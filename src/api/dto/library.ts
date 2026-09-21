/*
 * 本地库的线上结构。
 * 对应下载根目录下的 <分辨率>@<画廊名>/ 与其中的 .ehbrowser 元数据。
 */

import type { EpochSeconds } from "./common.ts";
import type { GallerySummary } from "./gallery.ts";

/** 本地已下载的画廊 */
export interface LocalGallery {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    /** 落盘时用的归档分辨率：org / res / hath 等 */
    readonly resolution: string;
    /** 下载根下的文件夹名 */
    readonly folder: string;
    /** 文件夹绝对路径，供界面显示与排错 */
    readonly path: string;
    readonly pageCount: number;
    /** 已解压出来的页数 */
    readonly files: number;
    readonly sizeBytes: number;
    readonly downloadedAt: EpochSeconds;
    /** 读到第几页，从 1 开始；0 表示没读过 */
    readonly lastReadPage: number;
    readonly lastReadAt: EpochSeconds | null;
    /** 保留的归档文件名，没保留则为 null */
    readonly archive: string | null;
    /** 下载时留下的画廊信息快照，便于离线展示；较早的数据可能没有 */
    readonly summary: GallerySummary | null;
}

/** 定位一个本地画廊 */
export interface LocalGalleryLocator {
    readonly gid: number;
    readonly resolution: string;
}

/** 定位本地画廊里的某一页 */
export interface LocalImageLocator extends LocalGalleryLocator {
    /** 从 1 开始 */
    readonly page: number;
}

/** 写回阅读进度 */
export interface LocalReadProgressInput {
    /** 从 1 开始 */
    readonly page: number;
}

/** 上游有更新的版本时给出的信息 */
export interface UpdateTarget {
    readonly gid: number;
    readonly token: string;
    readonly postedAt: EpochSeconds;
    readonly pageCount: number;
}

/** 检查对象：本地画廊的更新检查与收藏的标记更新共用 */
export interface UpdateCheckTarget {
    readonly key: string;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    /** 本地已有这一版的发布时间 */
    readonly postedAt: EpochSeconds;
    readonly pageCount: number;
    /** 归档分辨率：本地画廊有，收藏条目没有（不落盘，不存在分辨率） */
    readonly resolution?: string;
}

/** 更新检查的一条结果。本地画廊与收藏共用同一套检查与展示 */
export interface UpdateEntry {
    /** 身份：本地画廊是 <gid>-<分辨率>，收藏是 fav:<gid> */
    readonly key: string;
    /** 这一条来自哪里，决定界面上的动作是「更新」还是「更新标记号」 */
    readonly source: "library" | "favorites";
    readonly gid: number;
    readonly resolution: string;
    readonly title: string;
    readonly thumbUrl: string;
    /** 本地这一版的发布时间与页数 */
    readonly localPostedAt: EpochSeconds;
    readonly localPageCount: number;
    /** 有更新版本时的信息；null 表示已是最新 */
    readonly latest: UpdateTarget | null;
    /** 检查失败的原因；null 表示检查成功 */
    readonly error: string | null;
    readonly checkedAt: EpochSeconds;
}

/** 更新检查的整体状态。缓存只在内存里，重启即清空 */
export interface UpdateState {
    readonly checking: boolean;
    /** 已查完的结果，按检查顺序 */
    readonly entries: readonly UpdateEntry[];
    /** 本轮还排着没查的条数 */
    readonly pending: number;
}

/**
 * 发起更新检查。
 * targets 为空时按本地画廊全查；提供了 targets 时只查这些条目（收藏页把自己的条目传入）。
 * keys 在本地画廊范围内筛选；reset 会先清除已有缓存。
 */
export interface UpdateCheckInput {
    readonly targets?: readonly UpdateCheckTarget[];
    readonly keys?: readonly string[];
    readonly reset?: boolean;
}
