/*
 * 收藏的线上结构。
 * 本地收藏夹与收藏项落在 SQLite；云端分类（槽位 0～9）的名称与数量来自上游。
 */

import type { EpochSeconds } from "./common.ts";

/** 本地收藏夹 */
export interface FavoriteFolder {
    readonly id: string;
    readonly name: string;
    /** 夹内条目数 */
    readonly count: number;
    readonly createdAt: EpochSeconds;
}

/** 云端收藏夹：槽位 + 名称 + 数量 */
export interface CloudFavoriteFolder {
    readonly slot: number;
    readonly name: string;
    readonly count: number;
}

/** 收藏页顶部需要的两份列表 */
export interface FavoriteState {
    readonly folders: readonly FavoriteFolder[];
    readonly cloud: readonly CloudFavoriteFolder[];
    /** 云端列表读取失败的原因；null 表示读取正常 */
    readonly cloudError: string | null;
}

/** 本地收藏项 */
export interface FavoriteItem {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    readonly pageCount: number;
    /** 云端分类槽位；-1 表示只在本地 */
    readonly slot: number;
    readonly addedAt: EpochSeconds;
}

/** 加入本地收藏夹 */
export interface FavoriteAddInput {
    readonly folderId: string;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    readonly pageCount: number;
    /** 同时放进云端分类时给出槽位 */
    readonly slot?: number;
}

/** 新建收藏夹 */
export interface FavoriteFolderInput {
    readonly name: string;
}

/** 收藏项定位：夹 + 画廊 */
export interface FavoriteItemLocator {
    readonly folderId: string;
    readonly gid: number;
}

/** 改标记号（云端槽位）。-1 表示取消云端收藏 */
export interface FavoriteSlotInput {
    readonly slot: number;
}

/** 收藏夹的夹 id */
export interface FavoriteFolderLocator {
    readonly folderId: string;
}

/**
 * 「更新标记号」的单条结果。
 * 一个画廊在上游是分版本的：2024-1-1 收藏的是 v1，2026-1-1 又出了 v2。
 * 更新标记号指把收藏从当前版本改为最新版本，与云端槽位无关。
 */
export interface FavoriteRefreshEntry {
    /** 原先收藏的版本 */
    readonly gid: number;
    /** 移动后的版本；没有更新版本时为 null */
    readonly latestGid: number | null;
    readonly moved: boolean;
    /** 未完成移动的原因；null 表示移动成功 */
    readonly reason: string | null;
}

/** 更新标记号的结果 */
export interface FavoriteRefreshResult {
    readonly entries: readonly FavoriteRefreshEntry[];
    readonly moved: number;
    /** 更新后的完整收藏夹，界面直接替换 */
    readonly items: readonly FavoriteItem[];
}

/** 批量更新标记号：未给出 gids 时更新整个收藏夹 */
export interface FavoriteRefreshInput {
    readonly gids?: readonly number[];
}
