/*
 * 上游接口返回的原始结构。字段名与上游一致，归一化由服务层完成
 * 上游常把数字以字符串返回（posted、filecount、rating），此处保留原始类型
 */

import type { UpstreamSite } from "./http.ts";

/** 接口地址：外站在 api 子域，里站在 s 子域 */
export const UPSTREAM_API: Readonly<Record<UpstreamSite, string>> = {
    "e-hentai": "https://api.e-hentai.org/api.php",
    exhentai: "https://s.exhentai.org/api.php",
};

/** 单次请求的条目上限，两个接口一致 */
export const MAX_ENTRIES_PER_REQUEST = 25;

/** gdata 的 gmetadata 元素；失败时只带 gid 与 error */
export interface GalleryApiInfo {
    readonly gid: number;
    readonly token?: string;
    readonly title?: string;
    readonly title_jpn?: string;
    readonly category?: string;
    readonly thumb?: string;
    readonly uploader?: string;
    readonly posted?: string;
    readonly filecount?: string;
    readonly filesize?: number;
    readonly expunged?: boolean;
    readonly rating?: string;
    readonly torrentcount?: string;
    readonly torrents?: readonly TorrentApiInfo[];
    readonly tags?: readonly string[];
    readonly parent_gid?: string;
    readonly parent_key?: string;
    readonly current_gid?: string;
    readonly current_key?: string;
    readonly first_gid?: string;
    readonly first_key?: string;
    readonly error?: string;
}

export interface TorrentApiInfo {
    readonly hash: string;
    readonly added: string;
    readonly name: string;
    readonly tsize: string;
    readonly fsize: string;
}

export interface GdataResponse {
    readonly gmetadata?: readonly GalleryApiInfo[];
}

/** gtoken 的 tokenlist 元素；无效条目只带 gid 与 error */
export interface GtokenEntry {
    readonly gid: number;
    readonly token?: string;
    readonly error?: string;
}

export interface GtokenResponse {
    readonly tokenlist?: readonly GtokenEntry[];
}

/** showpage 响应：i3 图片片段、i6 跳过 H@H 的 key、i7 原图链接 */
export interface ShowpageResponse {
    readonly i3?: string;
    readonly i6?: string;
    readonly i7?: string;
    readonly error?: string;
}

/** showpage 解析结果 */
export interface ShowpageResult {
    readonly imageUrl: string;
    readonly originalImageUrl: string | null;
    readonly skipHathKey: string | null;
}
