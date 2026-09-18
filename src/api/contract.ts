/**
 * 路由名到请求/响应类型的映射，服务端与浏览器共用
 * 两端据此推导 ApiRouteParams / ApiRequestBody / ApiRouteResponse；
 * 浏览器侧封装为 request<K extends ApiRouteName>(name: K, ...) 即可获得完整类型
 * routes.ts 末尾的编译期断言用于校验与 ROUTES 的一致性
 */

import type {
    AccountCredentialsInput,
    AccountSummary,
    AccountUpdateInput,
    ArchiveCatalog,
    AuthStatus,
    CancelDownloadResult,
    ConfigSnapshot,
    DownloadTask,
    EnqueueDownloadInput,
    ExportConfigInput,
    ExportConfigResult,
    FavoriteGalleryInput,
    FavoriteGalleryResult,
    GalleryDetail,
    GalleryImagePage,
    GallerySearchQuery,
    GallerySearchResult,
    GalleryTokenLookup,
    GalleryTokenResult,
    ImportConfigInput,
    ImportConfigResult,
    LoginInput,
    PathsInfo,
    RateGalleryInput,
    RateGalleryResult,
    SystemHealth,
    TorrentInfo,
    UserSettingPatch,
} from "./dto/index.ts";
import type { ApiResponse } from "./envelope.ts";

/** 画廊定位；路径参数仅此两项，其余位于 query 或 body */
export interface GalleryLocator {
    readonly gid: number;
    readonly token: string;
}

/**
 * 图片页定位。page 位于路径（从 1 开始，与上游一致），不在 query
 * 若改至 query，routes.ts 末尾的断言会报错
 */
export interface ImagePageLocator extends GalleryLocator {
    readonly page: number;
}

/** 携带 pageToken 可省去一次详情解析 */
export interface ImagePageQuery {
    readonly pageToken?: string;
}

/** EventSource 无法设置请求头，令牌只能经 query 传递 */
export interface EventStreamQuery {
    readonly token?: string;
    /** 重连时携带上次事件 id，供服务端补发；尚未实现 */
    readonly lastEventId?: string;
}

/** 单一布尔结果 */
export interface RemovedResult {
    readonly removed: boolean;
}

/** params 位于路径，query 为 GET 查询串，body 为请求体 */
export interface ApiRouteContract {
    // ── 系统 ───────────────────────────────────────────────
    "system.health": { response: ApiResponse<SystemHealth> };
    /** SSE 返回事件流而非信封，故 response 为 never；负载类型见 events.ts */
    "system.events": { query: EventStreamQuery; response: never };

    // ── 配置 ───────────────────────────────────────────────
    "config.get": { response: ApiResponse<ConfigSnapshot> };
    "config.patch": { body: UserSettingPatch; response: ApiResponse<ConfigSnapshot> };
    "config.paths": { response: ApiResponse<PathsInfo> };
    "config.export": { body: ExportConfigInput; response: ApiResponse<ExportConfigResult> };
    "config.import": { body: ImportConfigInput; response: ApiResponse<ImportConfigResult> };

    // ── 账号与鉴权 ───────────────────────────────────────────────
    "auth.status": { response: ApiResponse<AuthStatus> };
    "auth.login": { body: LoginInput; response: ApiResponse<AuthStatus> };
    "auth.logout": { response: ApiResponse<AuthStatus> };
    "auth.accounts.list": { response: ApiResponse<readonly AccountSummary[]> };
    "auth.accounts.create": {
        body: AccountCredentialsInput;
        response: ApiResponse<AccountSummary>;
    };
    "auth.accounts.update": {
        params: { accountId: string };
        body: AccountUpdateInput;
        response: ApiResponse<AccountSummary>;
    };
    "auth.accounts.remove": {
        params: { accountId: string };
        response: ApiResponse<RemovedResult>;
    };
    "auth.accounts.activate": {
        params: { accountId: string };
        response: ApiResponse<AuthStatus>;
    };

    // ── 画廊 ───────────────────────────────────────────────
    "galleries.search": { query: GallerySearchQuery; response: ApiResponse<GallerySearchResult> };
    "galleries.detail": { params: GalleryLocator; response: ApiResponse<GalleryDetail> };
    "galleries.page": {
        params: ImagePageLocator;
        query: ImagePageQuery;
        response: ApiResponse<GalleryImagePage>;
    };
    "galleries.token": { body: GalleryTokenLookup; response: ApiResponse<GalleryTokenResult> };
    "galleries.rate": {
        params: GalleryLocator;
        body: RateGalleryInput;
        response: ApiResponse<RateGalleryResult>;
    };
    "galleries.favorite": {
        params: GalleryLocator;
        body: FavoriteGalleryInput;
        response: ApiResponse<FavoriteGalleryResult>;
    };
    "galleries.torrents": {
        params: GalleryLocator;
        response: ApiResponse<readonly TorrentInfo[]>;
    };
    "galleries.archives": { params: GalleryLocator; response: ApiResponse<ArchiveCatalog> };

    // ── 下载 ───────────────────────────────────────────────
    "downloads.list": { response: ApiResponse<readonly DownloadTask[]> };
    "downloads.create": { body: EnqueueDownloadInput; response: ApiResponse<DownloadTask> };
    "downloads.cancel": {
        params: { taskId: string };
        response: ApiResponse<CancelDownloadResult>;
    };
}

export type ApiRouteName = keyof ApiRouteContract;

/** 路径参数；无参数的路由为 Record<string, never> */
export type ApiRouteParams<K extends ApiRouteName> = ApiRouteContract[K] extends {
    params: infer P;
}
    ? P
    : Record<string, never>;

/** 查询参数；无 query 时为 never */
export type ApiRouteQuery<K extends ApiRouteName> = ApiRouteContract[K] extends { query: infer Q }
    ? Q
    : never;

/** 请求体；无 body 时为 never */
export type ApiRequestBody<K extends ApiRouteName> = ApiRouteContract[K] extends { body: infer B }
    ? B
    : never;

/** 响应类型 */
export type ApiRouteResponse<K extends ApiRouteName> = ApiRouteContract[K] extends {
    response: infer R;
}
    ? R
    : never;

/** 该路由是否接收请求体 */
export type ApiRouteHasBody<K extends ApiRouteName> = ApiRouteContract[K] extends { body: unknown }
    ? true
    : false;
