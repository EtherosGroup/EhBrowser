/*
 * 画廊详情的持久缓存。一个画廊一个文件，放在 <缓存目录>/gallery/ 下。
 *
 * 当上游更新，gid/token会更新，同时为了保证缓存秒开，因此将缓存落盘
 *
 * 字段：
 *   detail    详情本体，详情页需要
 *   usedAt    写入/最后使用时间
 *   checkedAt 上次查更新的时间
 *   newer     查到的更新版本
 *
 * 读取时更新 mtime，清理按 mtime 判龄，读过就算用过。
 *
 * newer 查到就长期留着，新版本不会自己消失。只有「查过、当时没有」才隔一天重查，
 * 间隔在 gallery-service 里。
 *
 * 缓存目录用户可以自行删除。文件不存在、内容损坏、JSON 不合法等当作没有缓存处理，坏文件直接删除。
 */

import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

import type { GalleryDetail, GalleryRelation } from "../api/index.ts";
import { writeFileAtomic } from "../config/atomic.ts";

/** 落盘的一条记录 */
export interface StoredDetail {
    readonly detail: GalleryDetail;
    /** 写入/最后使用时间，秒 */
    readonly usedAt: number;
    readonly checkedAt: number | null;
    readonly newer: GalleryRelation | null;
}

export interface DetailStoreStats {
    readonly entries: number;
    readonly bytes: number;
    /** 最久没用过的时间，没有条目时为 null */
    readonly oldestUsedAt: number | null;
    readonly newestUsedAt: number | null;
}

export interface DetailStoreClearResult {
    readonly removed: number;
    readonly bytes: number;
}

export interface DetailStore {
    get(gid: number, token: string): Promise<StoredDetail | null>;
    /** 写入详情。已有的更新检查结果保留，不会被本次写入覆盖 */
    put(gid: number, token: string, detail: GalleryDetail): Promise<void>;
    /** 只写回更新检查结果，不更新使用时间，否则旧画廊永远不会被清理 */
    saveCheck(gid: number, token: string, newer: GalleryRelation | null): Promise<void>;
    /** 删掉超过 days 天没用过的条目 */
    prune(days: number): Promise<DetailStoreClearResult>;
    /** 全部删掉 */
    clear(): Promise<DetailStoreClearResult>;
    stats(): Promise<DetailStoreStats>;
}

export interface DetailStoreOptions {
    /** 缓存根目录，条目位于其下的 gallery/ 目录 */
    readonly cacheDir: string;
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

const SUBDIR = "gallery";
const DAY_MS = 86_400_000;

/** token 过滤一次非字母数字字符，避免拼出目录穿越的路径 */
function fileOf(dir: string, gid: number, token: string): string {
    const safe = token.replace(/[^0-9a-zA-Z]/g, "");
    return join(dir, `${gid}-${safe}.json`);
}

function isDetail(value: unknown): value is GalleryDetail {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const item = value as Partial<GalleryDetail>;
    return typeof item.gid === "number" && typeof item.title === "string";
}

function isRelation(value: unknown): value is GalleryRelation {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const item = value as Partial<GalleryRelation>;
    return typeof item.gid === "number" && typeof item.token === "string";
}

export function createDetailStore(options: DetailStoreOptions): DetailStore {
    const log = options.logger ?? ((): void => undefined);
    const dir = join(options.cacheDir, SUBDIR);

    async function ensure(): Promise<void> {
        await mkdir(dir, { recursive: true, mode: 0o700 });
    }

    /** 读取一条记录，文件损坏时删除并按没有缓存处理 */
    async function read(file: string): Promise<StoredDetail | null> {
        let text: string;
        try {
            text = await readFile(file, "utf8");
        } catch {
            return null;
        }
        try {
            const raw = JSON.parse(text) as Record<string, unknown>;
            if (!isDetail(raw["detail"])) {
                throw new Error("detail 字段不是详情");
            }
            return {
                detail: raw["detail"],
                usedAt: Number(raw["usedAt"]) || 0,
                checkedAt: raw["checkedAt"] === null ? null : Number(raw["checkedAt"]) || null,
                newer: isRelation(raw["newer"]) ? raw["newer"] : null,
            };
        } catch (error) {
            log("warn", `画廊缓存损坏，已丢弃：${file}（${String(error)}）`);
            await rm(file, { force: true });
            return null;
        }
    }

    return {
        async get(gid, token) {
            const file = fileOf(dir, gid, token);
            const stored = await read(file);
            if (stored === null) {
                return null;
            }
            // 更新 mtime，清理按 mtime 判龄，读过即视为用过
            const now = new Date();
            await utimes(file, now, now).catch(() => undefined);
            return stored;
        },

        async put(gid, token, detail) {
            await ensure();
            const file = fileOf(dir, gid, token);
            // 保留旧的更新检查结果，已查到的新版本不会消失
            const previous = await read(file);
            const envelope = {
                detail,
                usedAt: Math.floor(Date.now() / 1000),
                checkedAt: previous?.checkedAt ?? null,
                newer: previous?.newer ?? null,
            };
            await writeFileAtomic(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
        },

        async saveCheck(gid, token, newer) {
            const file = fileOf(dir, gid, token);
            const previous = await read(file);
            if (previous === null) {
                // 没有详情时不单独保存检查结果，下次进入该画廊会重新检查
                return;
            }
            const envelope = {
                detail: previous.detail,
                usedAt: previous.usedAt,
                checkedAt: Math.floor(Date.now() / 1000),
                newer,
            };
            await writeFileAtomic(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
        },

        async prune(days) {
            const cutoff = Date.now() - Math.max(0, days) * DAY_MS;
            let removed = 0;
            let bytes = 0;
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return { removed, bytes };
            }
            for (const name of names) {
                if (!name.endsWith(".json")) {
                    continue;
                }
                const file = join(dir, name);
                try {
                    const info = await stat(file);
                    if (info.mtimeMs >= cutoff) {
                        continue;
                    }
                    await rm(file, { force: true });
                    removed += 1;
                    bytes += info.size;
                } catch {
                    // 遍历途中文件被删除，跳过
                }
            }
            if (removed > 0) {
                log("info", `画廊缓存清理：删掉 ${removed} 条（超过 ${days} 天没用过）`);
            }
            return { removed, bytes };
        },

        async clear() {
            let removed = 0;
            let bytes = 0;
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return { removed, bytes };
            }
            for (const name of names) {
                if (!name.endsWith(".json")) {
                    continue;
                }
                const file = join(dir, name);
                try {
                    const info = await stat(file);
                    await rm(file, { force: true });
                    removed += 1;
                    bytes += info.size;
                } catch {
                    // 同上
                }
            }
            return { removed, bytes };
        },

        async stats() {
            let entries = 0;
            let bytes = 0;
            let oldest: number | null = null;
            let newest: number | null = null;
            let names: string[];
            try {
                names = await readdir(dir);
            } catch {
                return { entries, bytes, oldestUsedAt: null, newestUsedAt: null };
            }
            for (const name of names) {
                if (!name.endsWith(".json")) {
                    continue;
                }
                try {
                    const info = await stat(join(dir, name));
                    entries += 1;
                    bytes += info.size;
                    const at = Math.floor(info.mtimeMs / 1000);
                    oldest = oldest === null ? at : Math.min(oldest, at);
                    newest = newest === null ? at : Math.max(newest, at);
                } catch {
                    // 同上
                }
            }
            return { entries, bytes, oldestUsedAt: oldest, newestUsedAt: newest };
        },
    };
}
