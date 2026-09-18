/**
 * 通用 JSON 存储管线
 */

import { readTextIfExists, moveAside, timeStamp, writeFileAtomic } from "./atomic.ts";
import { readVersion, runMigrations, type Migration } from "./migrations.ts";
import {
    collectUnknownPaths,
    deepMerge,
    isPlainObject,
    repairFields,
    validateFields,
    type DeepPartial,
    type FieldIssue,
    type FieldSpec,
} from "./validate.ts";

export type StoreLogger = (
    level: "info" | "warn" | "error",
    message: string,
    meta?: unknown,
) => void;

export interface JsonStoreOptions<T extends { schemaVersion: number }> {
    /** 数据文件绝对路径 */
    readonly file: string;
    readonly defaults: T;
    readonly fields: readonly FieldSpec[];
    readonly migrations?: readonly Migration[];
    /** 文件权限，默认 0600 */
    readonly mode?: number;
    readonly logger?: StoreLogger;
}

export interface JsonStore<T extends { schemaVersion: number }> {
    readonly file: string;
    /** 加载（幂等）。未加载时 get() 返回默认值 */
    load(): Promise<Readonly<T>>;
    isLoaded(): boolean;
    /** 已冻结快照，只读；变更走 patch() */
    get(): Readonly<T>;
    /** 局部更新，经写队列串行执行 */
    patch(patch: DeepPartial<T>): Promise<Readonly<T>>;
    /** 全量替换 */
    replace(next: T): Promise<Readonly<T>>;
    /** 重新读取磁盘文件 */
    reload(): Promise<Readonly<T>>;
    /** 等待写队列清空 */
    flush(): Promise<void>;
    /** 订阅变更，返回退订函数 */
    onChange(listener: (next: Readonly<T>) => void): () => void;
    /** false 表示文件版本高于程序，只读 */
    isWritable(): boolean;
}

/** 字段校验失败时抛出，携带字段级问题列表 */
export class ConfigInvalidError extends Error {
    readonly issues: readonly FieldIssue[];

    constructor(issues: readonly FieldIssue[]) {
        super(`配置校验失败：${issues.map((i) => i.path).join("、")}`);
        this.name = "ConfigInvalidError";
        this.issues = issues;
    }
}

interface Snapshot<T> {
    /** 冻结后的值 */
    readonly value: Readonly<T>;
    /** 磁盘内容副本，含未声明字段 */
    readonly raw: Record<string, unknown>;
    /** 是否允许写入 */
    readonly writable: boolean;
}

export function createJsonStore<T extends { schemaVersion: number }>(
    options: JsonStoreOptions<T>,
): JsonStore<T> {
    const log: StoreLogger = options.logger ?? (() => undefined);
    const listeners = new Set<(next: Readonly<T>) => void>();

    let snapshot: Snapshot<T> | null = null;
    let queue: Promise<unknown> = Promise.resolve();

    /** 写操作串行队列，避免并发 patch 相互覆盖 */
    function serialize<R>(task: () => Promise<R>): Promise<R> {
        const next = queue.then(task, task);
        queue = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    async function load(): Promise<Readonly<T>> {
        if (snapshot !== null) {
            return snapshot.value;
        }
        snapshot = await serialize(readFromDisk);
        return snapshot.value;
    }

    async function readFromDisk(): Promise<Snapshot<T>> {
        const text = await readTextIfExists(options.file);

        // 文件不存在：写入默认值，供用户查看与编辑
        if (text === null) {
            const result = finish(clone(options.defaults) as Record<string, unknown>, true);
            await write(result.raw);
            return result;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            const moved = await moveAside(options.file, `corrupt-${timeStamp()}`);
            log("warn", `无法读取配置文件。源文件已移动到 ${moved}，本次使用默认值`, { error });
            const result = finish(clone(options.defaults) as Record<string, unknown>, true);
            await write(result.raw);
            return result;
        }

        if (!isPlainObject(parsed)) {
            const moved = await moveAside(options.file, `corrupt-${timeStamp()}`);
            log("warn", `配置根节点不是对象。源文件已移动到 ${moved}，本次使用默认值`);
            const result = finish(clone(options.defaults) as Record<string, unknown>, true);
            await write(result.raw);
            return result;
        }

        const version = readVersion(parsed);
        const target = options.defaults.schemaVersion;

        // 版本高于程序：仅读取，不写回
        if (version > target) {
            log("warn", `文件版本 v${version} 高于程序支持的 v${target}。已进入只读模式`);
            const merged = deepMerge<T>(clone(options.defaults), parsed);
            return { value: deepFreeze(merged), raw: clone(parsed), writable: false };
        }

        // 版本低于程序：执行迁移
        let raw = parsed;
        let migrated = false;
        if (version < target) {
            const outcome = runMigrations(raw, target, options.migrations ?? []);
            if (outcome.applied.length > 0) {
                await backup();
                raw = outcome.data;
                migrated = true;
                log("info", `配置已从 v${version} 迁移到 v${target}`);
            }
        }

        // 默认值打底、文件内容覆盖；未声明字段由 deepMerge 保留
        const withDefaults = deepMerge<Record<string, unknown>>(
            clone(options.defaults) as Record<string, unknown>,
            raw,
        );
        const issues = repairFields(withDefaults, options.defaults, options.fields);
        if (issues.length > 0) {
            log("warn", `配置存在 ${issues.length} 处非法值。已替换为默认值`, issues);
        }

        const result = finish(withDefaults, true);
        // 迁移或修复后写回磁盘
        if (migrated || issues.length > 0) {
            await write(result.raw);
        }
        return result;
    }

    function finish(raw: Record<string, unknown>, writable: boolean): Snapshot<T> {
        const merged = deepMerge<T>(clone(options.defaults), raw);
        return { value: deepFreeze(merged), raw, writable };
    }

    async function write(raw: Record<string, unknown>): Promise<void> {
        const text = `${JSON.stringify(raw, null, 4)}\n`;
        await writeFileAtomic(options.file, text, { mode: options.mode });
    }

    async function backup(): Promise<void> {
        try {
            await moveAside(options.file, `bak-${timeStamp()}`);
        } catch (error) {
            log("warn", "迁移前备份失败，继续执行", { error });
        }
    }

    function current(): Snapshot<T> {
        if (snapshot === null) {
            throw new Error(`配置文件尚未加载：${options.file}`);
        }
        return snapshot;
    }

    function broadcast(value: Readonly<T>): void {
        for (const listener of listeners) {
            try {
                listener(value);
            } catch (error) {
                log("warn", "onChange 回调执行异常", { error });
            }
        }
    }

    async function commit(next: Record<string, unknown>): Promise<Readonly<T>> {
        const state = current();
        // 只读模式：拒绝写入
        if (!state.writable) {
            throw new Error(`只读模式：${options.file} 的版本高于当前程序，禁止写入`);
        }

        const issues = validateFields<Record<string, unknown>>(next, options.fields);
        if (!issues.ok) {
            throw new ConfigInvalidError(issues.issues);
        }

        await write(next);
        snapshot = {
            value: deepFreeze(deepMerge<T>(clone(options.defaults), next)),
            raw: next,
            writable: true,
        };
        broadcast(snapshot.value);
        return snapshot.value;
    }

    return {
        file: options.file,

        async load() {
            return load();
        },

        isLoaded() {
            return snapshot !== null;
        },

        get() {
            return current().value;
        },

        async patch(patch) {
            await load();
            return serialize(async () => {
                const unknown = collectUnknownPaths(patch, options.defaults);
                if (unknown.length > 0) {
                    throw new ConfigInvalidError(
                        unknown.map((path) => ({
                            path,
                            code: "conflict" as const,
                            message: "未声明字段",
                        })),
                    );
                }
                const state = current();
                // 以磁盘内容为基准打补丁，未声明字段一并保留
                const draft = clone(state.raw);
                const merged = deepMerge<Record<string, unknown>>(draft, patch);
                return commit(merged);
            });
        },

        async replace(next) {
            await load();
            return serialize(async () => {
                const issues = validateFields<Record<string, unknown>>(next, options.fields);
                if (!issues.ok) {
                    throw new ConfigInvalidError(issues.issues);
                }
                return commit(clone(next) as Record<string, unknown>);
            });
        },

        async reload() {
            // 此处不可调用 load()：load() 会再次进入 serialize，
            // 内层排在外层之后、外层等待内层，形成死锁
            return serialize(async () => {
                snapshot = await readFromDisk();
                return snapshot.value;
            });
        },

        async flush() {
            await queue;
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        isWritable() {
            return snapshot?.writable ?? true;
        },
    };
}

function clone<V>(value: V): V {
    return structuredClone(value);
}

function deepFreeze<V>(value: V): V {
    if (value !== null && typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) {
            deepFreeze(item);
        }
        Object.freeze(value);
    }
    return value;
}
