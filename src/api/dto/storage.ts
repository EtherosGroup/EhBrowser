/*
 * 储存空间。设置页该分组使用。
 * 两个数字分别来自本地库扫描的占用与详情缓存的体积，清理只作用于缓存。
 */

import type { EpochSeconds } from "./common.ts";

/** 储存空间一览 */
export interface StorageStats {
    /** 本地画廊的占用与个数 */
    readonly libraryBytes: number;
    readonly libraryGalleries: number;
    /** 画廊缓存的占用、条数，以及最久与最近一次使用时间 */
    readonly cacheBytes: number;
    readonly cacheEntries: number;
    readonly cacheOldestAt: EpochSeconds | null;
    readonly cacheNewestAt: EpochSeconds | null;
}

/** 清理范围，只保留最近 days 天内用过的缓存 */
export interface StorageCleanupInput {
    readonly days: number;
}

export interface StorageCleanupResult {
    readonly removed: number;
    readonly bytes: number;
    /** 清理后的统计，界面据此刷新显示 */
    readonly stats: StorageStats;
}
