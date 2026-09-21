/*
 * 储存空间。统计本地画廊与画廊缓存的占用，并按时间清理缓存。
 * 只清理详情持久缓存（detail-store），本地画廊的文件不受影响。
 */

import type { StorageCleanupResult, StorageStats } from "../api/index.ts";
import type { DetailStore } from "./detail-store.ts";
import type { LocalLibrary } from "./local-library.ts";

export interface StorageService {
    stats(): Promise<StorageStats>;
    cleanup(days: number): Promise<StorageCleanupResult>;
}

export interface StorageServiceOptions {
    readonly library: LocalLibrary;
    readonly store: DetailStore;
}

export function createStorageService(options: StorageServiceOptions): StorageService {
    async function stats(): Promise<StorageStats> {
        const [galleries, cache] = await Promise.all([
            options.library.list(),
            options.store.stats(),
        ]);
        return {
            libraryBytes: galleries.reduce((sum, item) => sum + item.sizeBytes, 0),
            libraryGalleries: galleries.length,
            cacheBytes: cache.bytes,
            cacheEntries: cache.entries,
            cacheOldestAt: cache.oldestUsedAt,
            cacheNewestAt: cache.newestUsedAt,
        };
    }

    return {
        stats,

        async cleanup(days) {
            const removed = await options.store.prune(days);
            return { removed: removed.removed, bytes: removed.bytes, stats: await stats() };
        },
    };
}
