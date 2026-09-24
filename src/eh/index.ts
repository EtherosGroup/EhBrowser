/*
 * 上游客户端。
 * http.ts 为传输层，api.ts 为接口封装，types.ts 为上游结构。
 */

export * from "./http.ts";
export * from "./doh.ts";
export * from "./direct-dns.ts";
export * from "./hosts.ts";
export * from "./image-proxy.ts";
export * from "./api.ts";
export * from "./urls.ts";
export * from "./html.ts";
export * from "./cookies.ts";
export * from "./auth.ts";
export * from "./archives.ts";
export * from "./favorites.ts";
export type {
    GdataResponse,
    GalleryApiInfo,
    GtokenEntry,
    GtokenResponse,
    ShowpageResponse,
    ShowpageResult,
    TorrentApiInfo,
} from "./types.ts";
export { MAX_ENTRIES_PER_REQUEST, UPSTREAM_API } from "./types.ts";
