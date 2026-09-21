/*
 * 画廊相关线上结构。
 *
 * 字段与 EhViewer 的 GalleryInfo / GalleryDetail 对齐，有三处差异：
 * category 使用上游原始字符串而非下标；数字字段统一为 number；
 * parent / current / first 合并为单个关系对象。
 */

import type { EpochSeconds, Paginated, PageQuery } from "./common.ts";

/** 分类名，取上游原始字符串（大小写与空格保持不变） */
export const GALLERY_CATEGORIES = [
    "Doujinshi",
    "Manga",
    "Artist CG",
    "Game CG",
    "Western",
    "Image Set",
    "Non-H",
    "Cosplay",
    "Asian Porn",
    "Misc",
    "Private",
] as const;

export type GalleryCategory = (typeof GALLERY_CATEGORIES)[number];

/** 对应上游 language:* 标签；translated 为独立标签，不属于语种 */
export const GALLERY_LANGUAGES = [
    "chinese",
    "dutch",
    "english",
    "french",
    "german",
    "hungarian",
    "italian",
    "japanese",
    "korean",
    "polish",
    "portuguese",
    "russian",
    "spanish",
    "thai",
    "vietnamese",
] as const;

export type GalleryLanguage = (typeof GALLERY_LANGUAGES)[number];

/** slot < 0 表示未收藏；null 表示尚未获取 */
export interface GalleryFavorite {
    readonly slot: number;
    readonly name: string;
}

/** 同系列的前后作 / 初版 / 最新版关系 */
export interface GalleryRelation {
    readonly gid: number;
    readonly token: string;
}

/** 列表项；搜索、收藏、排行榜共用 */
export interface GallerySummary {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly titleJpn: string;
    readonly category: GalleryCategory;
    readonly thumbUrl: string;
    readonly uploader: string;
    readonly postedAt: EpochSeconds;
    /** 上游字段名为 filecount，语义为页数 */
    readonly pageCount: number;
    readonly sizeBytes: number;
    /** 0～5，保留两位小数 */
    readonly rating: number;
    /** 对应上游 torrentcount */
    readonly torrentCount: number;
    readonly expunged: boolean;
    /** 形如 "female:stockings"；需带命名空间前缀时由服务端请求 namespace=1 */
    readonly tags: readonly string[];
    readonly language: GalleryLanguage | null;
    readonly favorite: GalleryFavorite | null;
}

/** 详情页按命名空间分组 */
export interface GalleryTagGroup {
    readonly namespace: string;
    /** 不含命名空间前缀的标签名 */
    readonly tags: readonly string[];
}

/**
 * 预览图。上游把本页的缩略图拼成一张横向精灵图。
 * 单格尺寸加偏移即 background-position，渲染按此计算。
 */
export interface GalleryPreviewPage {
    readonly page: number;
    readonly thumbUrl: string;
    readonly width: number;
    readonly height: number;
    readonly offsetX: number;
    readonly offsetY: number;
}

/** 一组缩略图。上游按每 20 页一组分页，index 为组号 */
export interface GalleryPreviewSet {
    readonly index: number;
    readonly previews: readonly GalleryPreviewPage[];
    /** 本组取满，可能还有下一组 */
    readonly hasMore: boolean;
}

/** 评论；html 已由服务端清洗，移除脚本与外链自动加载 */
/** 更新检查结果。newer 为上游最新版本，null 表示已是最新 */
export interface GalleryNewerVersion {
    readonly newer: GalleryRelation | null;
    /** 上次检查时间，未查过为 null */
    readonly checkedAt: EpochSeconds | null;
}

export interface GalleryComment {
    readonly id: string;
    readonly author: string;
    readonly postedAt: EpochSeconds;
    readonly score: number;
    readonly html: string;
}

/** 详情页缓存的状态；界面据此计算「约 X MB」 */
export interface GalleryDetailCacheStats {
    readonly entries: number;
    /** 条数上限，0 表示不缓存 */
    readonly max: number;
    readonly bytes: number;
    /** 单个画廊的平均体积；缓存为空时使用按经验给出的估算值 */
    readonly perGallery: number;
}

/** 详情：画廊页解析结果与 gdata 补充字段的合并 */
export interface GalleryDetail extends GallerySummary {
    readonly tagGroups: readonly GalleryTagGroup[];
    /** 上游可见性文本；已删除的画廊取其它值 */
    readonly visibility: string;
    /** 人类可读体积，如 "398.8 MiB" */
    readonly sizeText: string;
    readonly ratingCount: number;
    readonly favoriteCount: number;
    readonly previewPages: readonly GalleryPreviewPage[];
    readonly comments: readonly GalleryComment[];
    /** 归档下载是否可用（archiver.php） */
    readonly archiveAvailable: boolean;
    readonly parent: GalleryRelation | null;
    readonly first: GalleryRelation | null;
    /** 画廊被更新时与自身不同，指向最新版本 */
    readonly current: GalleryRelation | null;
}

/**
 * 单张图片页。
 * imageUrl 不在 HTML 中（由页面脚本注入），需经 MPV 的 showpage 接口获取：
 * i3 返回图片地址、i7 返回原图、i6 中的 nl('...') 为跳过 H@H 的 key。
 */
export interface GalleryImagePage {
    /** 从 1 开始，与上游 /s/{pageToken}/{gid}-{page} 一致 */
    readonly page: number;
    readonly pageToken: string;
    readonly imageUrl: string;
    readonly originalImageUrl: string | null;
    readonly skipHathKey: string | null;
    readonly width: number | null;
    readonly height: number | null;
    /** 连播时可省去一次详情请求 */
    readonly nextPageToken: string | null;
}

/** 对应 gdata 的 torrents[] */
export interface TorrentInfo {
    readonly hash: string;
    readonly name: string;
    readonly url: string;
    readonly addedAt: EpochSeconds;
    readonly sizeBytes: number;
}

/** archiver.php 返回的各分辨率选项 */
export interface ArchiveOption {
    /** org / res / 1280 / 1920 / 2560 等 */
    readonly resolution: string;
    readonly label: string;
    readonly sizeText: string;
    /** 免费额度未用尽时为 "Free" */
    readonly costText: string;
    /** true 表示经 H@H 下载器（hathdl_xres），非普通归档 */
    readonly viaHath: boolean;
}

export interface ArchiveCatalog {
    readonly options: readonly ArchiveOption[];
    /** 账户资金，用于提示花费 */
    readonly fundsText: string;
}

/**
 * 一次检索取多少条。界面与启动预热都使用该值，缓存命中判定以此为准。
 */
export const SEARCH_PAGE_LIMIT = 24;

/** 搜索条件；GET 查询串由服务端解析为该结构 */
export interface GallerySearchQuery extends PageQuery {
    readonly query?: string;
    readonly categories?: readonly GalleryCategory[];
    readonly excludedCategories?: readonly GalleryCategory[];
    readonly language?: GalleryLanguage;
    /** 最低评分（0～5） */
    readonly minRating?: number;
}

export type GallerySearchResult = Paginated<GallerySummary>;

/**
 * 上一次检索的缓存：条件与结果一起存，界面重新进入搜索页时可以据此直接渲染。
 * 只存在于进程内（文件落在缓存目录的 temp 下，启动时清掉），因此不保证新鲜度，
 * 界面使用它只为了先呈现内容，获取新结果仍需重新发起检索。
 */
export interface GallerySearchCache {
    /** 当时实际给上游的检索条件 */
    readonly query: GallerySearchQuery;
    readonly result: GallerySearchResult;
    readonly savedAt: EpochSeconds;
}

/** gtoken 入参；仅有单页链接时用于还原完整画廊 */
export interface GalleryTokenLookup {
    readonly gid: number;
    readonly pageToken: string;
    /** 从 1 开始 */
    readonly page: number;
}

export interface GalleryTokenResult {
    readonly gid: number;
    readonly token: string;
}

/** 评分；取值 0～5，换算为上游的 1～10 由服务端处理 */
export interface RateGalleryInput {
    readonly rating: number;
}

export interface RateGalleryResult {
    readonly rating: number;
    readonly ratingCount: number;
}

/** slot < 0 取消收藏，>= 0 放入对应分类 */
export interface FavoriteGalleryInput {
    readonly slot: number;
}

export interface FavoriteGalleryResult {
    readonly favorite: GalleryFavorite | null;
}
