/*
 * 两个播放列表。
 * 画廊播放列表：进入某个画廊时重建，装的是这个画廊的每一页（播放器的曲目）。
 * 用户播放列表：手动加入的画廊，持久化在服务端（SQLite），重启不丢。
 * 两者都是模块级单例：播放器、画廊页、播放列表页直接引用，不再层层传 props。
 */

import { computed, ref } from "vue";

import type { PlaylistItem, PlaylistSnapshot } from "../../src/api/index.ts";
import { describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";

/** 播放器的一页。地址可能是本地路由，也可能是上游图片 */
export interface GalleryTrack {
    /** 从 1 开始 */
    readonly page: number;
    readonly url: string;
    /** 估算字节数，用于缓存预算；未知为 0 */
    readonly bytes: number;
}

/** 当前正在播的画廊，用于标题、下载与收藏状态 */
export interface PlaylistGallery {
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly thumbUrl: string;
    readonly pageCount: number;
    /** 本地已下载时用这个分辨率取本地图；为空表示走网络 */
    readonly resolution: string | null;
    /** 在这个画廊里读到第几页 */
    readonly page: number;
    /** 本地每页平均字节，用于缓存预算；未知为 0 */
    readonly bytesPerPage: number;
}

/** 当前画廊的曲目。进画廊时整体重建，长度即总页数 */
export const galleryPlaylist = ref<readonly GalleryTrack[]>([]);

/** 画廊播放列表对应的那个画廊 */
export const playingGallery = ref<PlaylistGallery | null>(null);

/** 用户播放列表。服务端是唯一事实来源，这里只是界面侧的一份镜像 */
export const userPlaylist = ref<readonly PlaylistItem[]>([]);

/** 当前播放项，没有则为 null */
export const currentPlaylistKey = ref<string | null>(null);

/** 当前播放项在列表里的下标，不在列表里为 -1 */
export const currentIndex = computed(() =>
    userPlaylist.value.findIndex((item) => item.key === currentPlaylistKey.value),
);

/** 用户播放列表的总页数，顶部的「当前页/总页数」要用 */
export const userPlaylistPages = computed(() =>
    userPlaylist.value.reduce((total, item) => total + item.pageCount, 0),
);

/** 已播到的页：当前项之前的画廊算整本播完，再加当前项的进度 */
export const playedPages = computed(() => {
    const at = currentIndex.value;
    if (at === -1) {
        return 0;
    }
    let done = 0;
    for (let index = 0; index < at; index += 1) {
        done += userPlaylist.value[index]?.pageCount ?? 0;
    }
    return done + (userPlaylist.value[at]?.page ?? 1);
});

/** 把服务端返回的快照写入界面状态 */
function apply(snapshot: PlaylistSnapshot): void {
    userPlaylist.value = snapshot.items;
    currentPlaylistKey.value = snapshot.currentKey;
}

/** 取回用户播放列表。进页面时调一次即可 */
export async function loadUserPlaylist(): Promise<void> {
    try {
        apply(await request("playlist.list"));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/**
 * 加入用户播放列表（情景 2：不清空，只追加）
 * 已在列表里则只刷新快照，进度与顺序保留
 */
export async function addToUserPlaylist(input: {
    gid: number;
    token: string;
    title: string;
    thumbUrl: string;
    pageCount: number;
    resolution: string | null;
    bytesPerPage: number;
}): Promise<boolean> {
    try {
        apply(await request("playlist.add", { body: input }));
        return true;
    } catch (caught) {
        messenger.error(describeApiError(caught));
        return false;
    }
}

/** 设为当前播放项 */
export async function markPlaying(key: string): Promise<void> {
    try {
        apply(await request("playlist.play", { params: { key } }));
    } catch {
        // 标记当前项失败不影响播放
    }
}

/** 写回某个画廊的播放进度 */
export async function savePlaylistProgress(key: string, page: number): Promise<void> {
    try {
        apply(await request("playlist.progress", { params: { key }, body: { page } }));
    } catch {
        // 进度写失败不影响观看
    }
}

/** 从播放列表移除一项 */
export async function removePlaylistItem(key: string): Promise<void> {
    try {
        apply(await request("playlist.remove", { params: { key } }));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 清空播放列表 */
export async function clearUserPlaylist(): Promise<void> {
    try {
        apply(await request("playlist.clear"));
        messenger.info("播放列表已清空");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}
