/** 画廊相关 */
import type { EpochSeconds, Paginated, PageQuery } from "./common.ts";

/** 分类名。照上游原样抄，大小写和空格都别动 */
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

/** 对应上游 language:* 标签。translated 是单独的标签，不算语种 */
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

/** slot < 0 是没收藏，null 是还没问到 */
export interface GalleryFavorite {
    readonly slot: number;
    readonly name: string;
}

/** 同系列的前后作 / 初版 / 最新版，跳转用 */
export interface GalleryRelation {
    readonly gid: number;
    readonly token: string;
}

/** 列表项。搜索、收藏、排行榜都共用这一个 */
export interface GallerySummary {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly titleJpn: string;
    readonly category: GalleryCategory;
    readonly thumbUrl: string;
    readonly uploader: string;
    readonly postedAt: EpochSeconds;
    /** 上游叫 filecount，其实就是页数 */
    readonly pageCount: number;
    readonly sizeBytes: number;
    /** 0～5，两位小数 */
    readonly rating: number;
    /** 上游叫 torrentcount */
    readonly torrentCount: number;
    readonly expunged: boolean;
    /** "female:stockings" 这样。要带前缀就让服务端带上 namespace=1 */
    readonly tags: readonly string[];
    readonly language: GalleryLanguage | null;
    readonly favorite: GalleryFavorite | null;
}

/** 详情页按命名空间聚一下 */
export interface GalleryTagGroup {
    readonly namespace: string;
    /** 不带前缀的标签名 */
    readonly tags: readonly string[];
}

/** 预览图，每页一张缩略图 */
export interface GalleryPreviewPage {
    readonly page: number;
    readonly thumbUrl: string;
    readonly width: number;
    readonly height: number;
}

/** 评论。html 服务端洗过，脚本和外链自动加载都去掉了 */
export interface GalleryComment {
    readonly id: string;
    readonly author: string;
    readonly postedAt: EpochSeconds;
    readonly score: number;
    readonly html: string;
}

/** 详情 = 画廊页扒的 + gdata 补的 */
export interface GalleryDetail extends GallerySummary {
    readonly tagGroups: readonly GalleryTagGroup[];
    /** 上游原样给的，删掉的画廊就不是 "Visible" */
    readonly visibility: string;
    /** 给人看的，比如 "398.8 MiB" */
    readonly sizeText: string;
    readonly ratingCount: number;
    readonly favoriteCount: number;
    readonly previewPages: readonly GalleryPreviewPage[];
    readonly comments: readonly GalleryComment[];
    /** archiver 还能不能用 */
    readonly archiveAvailable: boolean;
    readonly parent: GalleryRelation | null;
    readonly first: GalleryRelation | null;
    /** 画廊被更新过的话就和自身不一样 */
    readonly current: GalleryRelation | null;
}

/**
 * 单张图片页
 * imageUrl 不在 HTML 里（页面是 JS 塞进去的），得走 MPV 的 showpage：
 * i3 给图、i7 给原图、i6 里 nl('...') 是跳 H@H 的 key
 */
export interface GalleryImagePage {
    /** 从 1 开始，跟上游 /s/{pageToken}/{gid}-{page} 对齐 */
    readonly page: number;
    readonly pageToken: string;
    readonly imageUrl: string;
    readonly originalImageUrl: string | null;
    readonly skipHathKey: string | null;
    readonly width: number | null;
    readonly height: number | null;
    /** 连播的时候能省一次详情请求 */
    readonly nextPageToken: string | null;
}

/** gdata 里的 torrents[] */
export interface TorrentInfo {
    readonly hash: string;
    readonly name: string;
    readonly url: string;
    readonly addedAt: EpochSeconds;
    readonly sizeBytes: number;
}

/** archiver.php 返回的每种分辨率 */
export interface ArchiveOption {
    /** org / res / 1280 / 1920 / 2560 这些 */
    readonly resolution: string;
    readonly label: string;
    readonly sizeText: string;
    /** 额度没用完的话是 "Free" */
    readonly costText: string;
    /** true 走 H@H 下载器（hathdl_xres），不是普通归档 */
    readonly viaHath: boolean;
}

export interface ArchiveCatalog {
    readonly options: readonly ArchiveOption[];
    /** 账户资金，用来提示要花多少 */
    readonly fundsText: string;
}

/** 搜索条件。GET 的 query 串由服务端解析成这个 */
export interface GallerySearchQuery extends PageQuery {
    readonly query?: string;
    readonly categories?: readonly GalleryCategory[];
    readonly excludedCategories?: readonly GalleryCategory[];
    readonly language?: GalleryLanguage;
    /** 最低评分，0～5 */
    readonly minRating?: number;
}

export type GallerySearchResult = Paginated<GallerySummary>;

/** gtoken 入参。手里只有单页链接的时候靠它把整个画廊找回来 */
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

/** 评分。传 0～5 就行，换算成上游要的 1～10 是服务端的事 */
export interface RateGalleryInput {
    readonly rating: number;
}

export interface RateGalleryResult {
    readonly rating: number;
    readonly ratingCount: number;
}

/** slot < 0 取消收藏，>= 0 放对应分类 */
export interface FavoriteGalleryInput {
    readonly slot: number;
}

export interface FavoriteGalleryResult {
    readonly favorite: GalleryFavorite | null;
}
