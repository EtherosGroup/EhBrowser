/*
 * 版本迁移。约定：迁移前备份；文件版本高于程序版本时只读；migrate 为纯函数。
 * 只补「这一版新增且无法从旧值推出」的字段，缺失字段另有默认值层兜底。
 */

import { AUTH_SETTING_VERSION, USER_SETTING_VERSION } from "./schema.ts";

export interface Migration {
    readonly from: number;
    readonly to: number;
    /** 纯函数，不做 IO，便于单测 */
    migrate(data: Record<string, unknown>): Record<string, unknown>;
}

export interface MigrationOutcome {
    readonly data: Record<string, unknown>;
    /** 实际执行了哪些步骤，用来决定是否需要写回文件 */
    readonly applied: readonly number[];
}

/** 结构变更示例：
 *  { from: 1, to: 2, migrate: (data) => ({ ...data, schemaVersion: 2, 新字段: 默认值 }) }
 */
export const USER_SETTING_MIGRATIONS: readonly Migration[] = [
    {
        // v2 为播放器补上缓存上限、并发加载与自动播放设置，另加翻译开关
        from: 1,
        to: 2,
        migrate: (data) => {
            const viewer = (data["viewer"] ?? {}) as Record<string, unknown>;
            return {
                ...data,
                schemaVersion: 2,
                viewer: {
                    ...viewer,
                    ...(viewer["maxCacheMb"] === undefined ? { maxCacheMb: 512 } : {}),
                    ...(viewer["maxConcurrentLoads"] === undefined
                        ? { maxConcurrentLoads: 3 }
                        : {}),
                    ...(viewer["autoplay"] === undefined
                        ? { autoplay: { enabled: false, intervalSeconds: 5, loop: false } }
                        : {}),
                },
                ...(data["translate"] === undefined ? { translate: { tags: false } } : {}),
            };
        },
    },
    {
        // v3 增加紧急避险：默认开启提示，跳转地址为空白页
        from: 2,
        to: 3,
        migrate: (data) => ({
            ...data,
            schemaVersion: 3,
            ...(data["safety"] === undefined
                ? { safety: { hintEnabled: true, url: "about:blank" } }
                : {}),
        }),
    },
    {
        // v4 增加日志：默认写入文件，目录留空时使用默认的 ~/ehbrowser/logs
        from: 3,
        to: 4,
        migrate: (data) => ({
            ...data,
            schemaVersion: 4,
            ...(data["log"] === undefined ? { log: { enabled: true, directory: "" } } : {}),
        }),
    },
    {
        // v5 增加详情页缓存条数：默认缓存 20 个画廊，0 表示不缓存
        from: 4,
        to: 5,
        migrate: (data) => {
            const ui = (data["ui"] ?? {}) as Record<string, unknown>;
            return {
                ...data,
                schemaVersion: 5,
                ui: {
                    ...ui,
                    ...(ui["cachedGalleries"] === undefined ? { cachedGalleries: 20 } : {}),
                },
            };
        },
    },
    {
        // v6 增加自动搜索：默认关闭（打开界面不主动拉内容），提示默认开启
        from: 5,
        to: 6,
        migrate: (data) => ({
            ...data,
            schemaVersion: 6,
            ...(data["search"] === undefined ? { search: { auto: false, hintEnabled: true } } : {}),
        }),
    },
    {
        // v7 增加直连解析（绕 DNS 污染）：默认关闭，内置表与 DoH 默认开
        from: 6,
        to: 7,
        migrate: (data) => {
            const network = (data["network"] ?? {}) as Record<string, unknown>;
            return {
                ...data,
                schemaVersion: 7,
                network: {
                    ...network,
                    ...(network["direct"] === undefined
                        ? { direct: { enabled: false, builtIn: true, doh: true, hosts: "" } }
                        : {}),
                },
            };
        },
    },
];

export const AUTH_SETTING_MIGRATIONS: readonly Migration[] = [];

export const CURRENT_VERSIONS = {
    user: USER_SETTING_VERSION,
    auth: AUTH_SETTING_VERSION,
} as const;

export type SettingFile = keyof typeof CURRENT_VERSIONS;

export function migrationsFor(file: SettingFile): readonly Migration[] {
    return file === "user" ? USER_SETTING_MIGRATIONS : AUTH_SETTING_MIGRATIONS;
}

/** 将 data.schemaVersion 升至 target。缺失步骤直接抛错，避免写入不完整数据 */
export function runMigrations(
    data: Record<string, unknown>,
    target: number,
    migrations: readonly Migration[],
): MigrationOutcome {
    let current = data;
    let version = readVersion(current);
    const applied: number[] = [];

    while (version < target) {
        const step = migrations.find((m) => m.from === version);
        if (step === undefined) {
            throw new Error(`没有 v${version} → 更上层的迁移步骤，代码里的版本是 v${target}`);
        }
        current = step.migrate(current);
        version = step.to;
        applied.push(step.to);
    }

    return { data: current, applied };
}

/** 无法读取版本号时按 1 处理 */
export function readVersion(data: Record<string, unknown>): number {
    const raw = data["schemaVersion"];
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}
