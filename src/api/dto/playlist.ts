/*
 * 播放列表的线上结构。
 * 用户播放列表持久化在 SQLite 的 playlist_items 表，应用重启不丢失。
 */

import type { EpochSeconds } from "./common.ts";

/**
 * 一项的身份：`<gid>-<分辨率或 net>`。
 * 同一个画廊下载了两种分辨率就是两项；`net` 表示没有本地副本、走网络。
 */
export type PlaylistKey = string;

export interface PlaylistItem {
    readonly key: PlaylistKey;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    readonly pageCount: number;
    /** 本地副本的分辨率；为空表示走网络 */
    readonly resolution: string | null;
    /** 在这个画廊里读到第几页，从 1 开始 */
    readonly page: number;
    /** 本地每页平均字节；未知为 0 */
    readonly bytesPerPage: number;
    readonly addedAt: EpochSeconds;
}

/** 列表与当前播放项一起给：界面一次拿到就能画完整页 */
export interface PlaylistSnapshot {
    readonly items: readonly PlaylistItem[];
    readonly currentKey: PlaylistKey | null;
}

/** 加入播放列表。带的是画廊快照，因此不依赖上游是否可达 */
export interface PlaylistAddInput {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    readonly pageCount: number;
    readonly resolution?: string | null;
    readonly page?: number;
    readonly bytesPerPage?: number;
}

/** 写回某个画廊的播放进度 */
export interface PlaylistProgressInput {
    readonly page: number;
}

/** 按 key 定位一项 */
export interface PlaylistKeyParam {
    readonly key: PlaylistKey;
}

/** 由 gid 与分辨率拼出 key。分辨率缺失时用 net */
export function playlistKeyOf(gid: number, resolution: string | null | undefined): PlaylistKey {
    return `${gid}-${resolution === null || resolution === undefined || resolution === "" ? "net" : resolution}`;
}
