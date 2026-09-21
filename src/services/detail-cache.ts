/*
 * 画廊详情缓存。
 * 详情页要的三样东西都存这里：信息（detail）、封面（第 1 页的图片地址）、缩略图（预览图分组）。
 * 内存 LRU，条数上限来自设置（ui.cachedGalleries，0 表示不缓存），超出就丢最久没用的那本。
 * 再次进入同一画廊时一个上游请求都不发。
 *
 * 封面存的是 showpage 给的图片地址，地址里的 keystamp 会过期，因此封面单独带 10 分钟有效期。
 * 信息和缩略图是静态内容，只受条数上限约束。
 * 需要「一定要新」的调用方（更新检查、收藏挪版本、进入阅读前的存在性检查）传 fresh，
 * 跳过读取但仍然写回缓存。
 *
 * 同一个键在途的读只发一次上游。多开几个页面同时看同一本，
 * 或者详情页与播放器同时进同一本时，同一份东西不会重复请求很多遍。
 */

import type { GalleryDetail, GalleryImagePage, GalleryPreviewSet } from "../api/index.ts";

/** 封面地址的有效期。keystamp 过期后图片会 403，因此宁可重新解析一次 */
const COVER_TTL_MS = 10 * 60 * 1000;
/** 缓存空着时用来估体积的单个画廊大小，取自实际详情（含标签、评论、预览）的量级。 */
const NOMINAL_BYTES = 24 * 1024;

interface Entry {
    /** 最近一次使用时间，用于 LRU。 */
    at: number;
    detail: GalleryDetail | null;
    /** 封面与它的存放时间。过期的按没有处理。 */
    cover: { at: number; page: GalleryImagePage } | null;
    previews: Map<number, GalleryPreviewSet>;
    /** 这份条目占的字节数（按 JSON 估）。 */
    bytes: number;
}

export interface DetailCacheStats {
    readonly entries: number;
    readonly max: number;
    readonly bytes: number;
    /** 单个画廊的平均体积。缓存为空时是按经验给的估算值 */
    readonly perGallery: number;
}

export interface DetailCacheOptions {
    /** 条数上限。每次调用都重新取，设置改完立即生效 */
    readonly limit: () => number;
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

export interface GalleryDetailCache {
    detail(
        gid: number,
        token: string,
        load: () => Promise<GalleryDetail>,
        fresh?: boolean,
    ): Promise<GalleryDetail>;
    cover(
        gid: number,
        token: string,
        load: () => Promise<GalleryImagePage>,
        fresh?: boolean,
    ): Promise<GalleryImagePage>;
    previews(
        gid: number,
        token: string,
        index: number,
        load: () => Promise<GalleryPreviewSet>,
        fresh?: boolean,
    ): Promise<GalleryPreviewSet>;
    stats(): DetailCacheStats;
    /** 清空缓存。 */
    clear(): DetailCacheStats;
}

function keyOf(gid: number, token: string): string {
    return `${gid}:${token}`;
}

/** 条目占多少字节：按 JSON 文本长度估，够用来显示「约 X MB」 */
function sizeOf(entry: {
    detail: GalleryDetail | null;
    cover: { page: GalleryImagePage } | null;
    previews: ReadonlyMap<number, GalleryPreviewSet>;
}): number {
    let bytes = entry.detail === null ? 0 : JSON.stringify(entry.detail).length;
    if (entry.cover !== null) {
        bytes += JSON.stringify(entry.cover.page).length;
    }
    for (const set of entry.previews.values()) {
        bytes += JSON.stringify(set).length;
    }
    return bytes;
}

export function createDetailCache(options: DetailCacheOptions): GalleryDetailCache {
    const log = options.logger ?? (() => undefined);
    /** Map 的插入顺序当 LRU 用：命中就删了再放回尾部。 */
    const entries = new Map<string, Entry>();

    function limit(): number {
        const value = options.limit();
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    function touch(key: string, entry: Entry): void {
        entries.delete(key);
        entries.set(key, entry);
    }

    /** 超上限就丢最久没用的。设置调小后下一次访问就会收敛。 */
    function trim(): void {
        const max = limit();
        if (entries.size <= max) {
            return;
        }
        for (const [key] of entries) {
            if (entries.size <= max) {
                break;
            }
            entries.delete(key);
        }
        log("info", `详情缓存超出上限（${max}），已丢弃最久未用的条目`);
    }

    /** 上限为 0 时缓存不该继续占内存，直接清空。条数调小后也一样收敛。 */
    function prune(): void {
        const max = limit();
        if (max === 0) {
            if (entries.size > 0) {
                entries.clear();
            }
            return;
        }
        trim();
    }

    function entryOf(gid: number, token: string): Entry | null {
        const key = keyOf(gid, token);
        const entry = entries.get(key);
        if (entry === undefined) {
            return null;
        }
        if (entry.detail === null && entry.cover === null && entry.previews.size === 0) {
            entries.delete(key);
            return null;
        }
        touch(key, entry);
        return entry;
    }

    /*
     * 在途的读。同一个键的并发调用共用一次上游请求，完成后立刻从表里摘掉。
     * 共用的是「正在向上游要」这件事，因此 fresh 的调用方也跟着用，不算吃了旧数据。
     */
    const inflight = new Map<string, Promise<unknown>>();

    function share<T>(key: string, load: () => Promise<T>): Promise<T> {
        const running = inflight.get(key);
        if (running !== undefined) {
            return running as Promise<T>;
        }
        const task = load().finally(() => {
            inflight.delete(key);
        });
        inflight.set(key, task);
        return task;
    }

    /** 拿一份可写的条目。不存在的就新建并占位，写回时再 trim。 */
    function writable(gid: number, token: string): Entry {
        const existing = entryOf(gid, token);
        if (existing !== null) {
            return existing;
        }
        const fresh: Entry = {
            at: Date.now(),
            detail: null,
            cover: null,
            previews: new Map(),
            bytes: 0,
        };
        entries.set(keyOf(gid, token), fresh);
        return fresh;
    }

    function statsOf(): DetailCacheStats {
        prune();
        let bytes = 0;
        for (const entry of entries.values()) {
            bytes += entry.bytes;
        }
        return {
            entries: entries.size,
            max: limit(),
            bytes,
            perGallery:
                entries.size === 0
                    ? NOMINAL_BYTES
                    : Math.max(1024, Math.round(bytes / entries.size)),
        };
    }

    return {
        async detail(gid, token, load, fresh = false) {
            const max = limit();
            if (max === 0) {
                prune();
                return share(`detail:${keyOf(gid, token)}`, load);
            }
            const cached = fresh ? null : entryOf(gid, token)?.detail;
            if (cached !== undefined && cached !== null) {
                return cached;
            }
            const detail = await share(`detail:${keyOf(gid, token)}`, load);
            const entry = writable(gid, token);
            entry.detail = detail;
            entry.at = Date.now();
            entry.bytes = sizeOf(entry);
            trim();
            return detail;
        },

        async cover(gid, token, load, fresh = false) {
            const max = limit();
            if (max === 0) {
                prune();
                return share(`cover:${keyOf(gid, token)}`, load);
            }
            const entry = fresh ? null : entryOf(gid, token);
            const cached = entry?.cover;
            if (cached !== undefined && cached !== null && Date.now() - cached.at < COVER_TTL_MS) {
                return cached.page;
            }
            const page = await share(`cover:${keyOf(gid, token)}`, load);
            const target = writable(gid, token);
            target.cover = { at: Date.now(), page };
            target.at = Date.now();
            target.bytes = sizeOf(target);
            trim();
            return page;
        },

        async previews(gid, token, index, load, fresh = false) {
            const max = limit();
            if (max === 0) {
                prune();
                return share(`previews:${keyOf(gid, token)}:${index}`, load);
            }
            const cached = fresh ? undefined : entryOf(gid, token)?.previews.get(index);
            if (cached !== undefined) {
                return cached;
            }
            const set = await share(`previews:${keyOf(gid, token)}:${index}`, load);
            const entry = writable(gid, token);
            entry.previews.set(index, set);
            entry.at = Date.now();
            entry.bytes = sizeOf(entry);
            trim();
            return set;
        },

        stats: statsOf,

        clear() {
            entries.clear();
            inflight.clear();
            return statsOf();
        },
    };
}
