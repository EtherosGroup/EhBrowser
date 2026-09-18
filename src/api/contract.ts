// 路由名 → 请求/响应类型，服务端和浏览器共用
// 有了它两边就能各自推出 ApiRouteParams / ApiRequestBody / ApiRouteResponse，
// 浏览器那边写成 request<K extends ApiRouteName>(name: K, ...) 就自动带类型，改字段两边一起报
// routes.ts 末尾的断言盯着 ROUTES 别跟这儿走偏，别删

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

/** 定位一个画廊。路径里就这两项，别的都在 query 或 body */
export interface GalleryLocator {
    readonly gid: number;
    readonly token: string;
}

/**
 * 图片页定位。page 在路径里，不是 query（从 1 开始，跟上游一致）
 * 想挪去 query 的话 routes.ts 末尾那个断言会拦你
 */
export interface ImagePageLocator extends GalleryLocator {
    readonly page: number;
}

/** 带上 pageToken 服务端能少解析一次详情 */
export interface ImagePageQuery {
    readonly pageToken?: string;
}

/** EventSource 加不了请求头，令牌只能塞 query 里 */
export interface EventStreamQuery {
    readonly token?: string;
    /** 重连时带上回 id，服务端可以补发。还没实现，先占着 */
    readonly lastEventId?: string;
}

/** 就一个布尔，懒得起名 */
export interface RemovedResult {
    readonly removed: boolean;
}

/** params 走路径，query 是 GET 的查询串，body 是请求体 */
export interface ApiRouteContract {
    // ── 系统 ───────────────────────────────────────────────
    "system.health": { response: ApiResponse<SystemHealth> };
    /** SSE 返回的是事件流不是信封，所以 response 是 never。负载类型在 events.ts */
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

/** 路径参数。没参数的路由是 Record<string, never> */
export type ApiRouteParams<K extends ApiRouteName> = ApiRouteContract[K] extends {
    params: infer P;
}
    ? P
    : Record<string, never>;

/** 查询参数。没 query 就是 never */
export type ApiRouteQuery<K extends ApiRouteName> = ApiRouteContract[K] extends { query: infer Q }
    ? Q
    : never;

/** 请求体。没 body 就是 never */
export type ApiRequestBody<K extends ApiRouteName> = ApiRouteContract[K] extends { body: infer B }
    ? B
    : never;

/** 响应类型 */
export type ApiRouteResponse<K extends ApiRouteName> = ApiRouteContract[K] extends {
    response: infer R;
}
    ? R
    : never;

/** 这路由收不收 body */
export type ApiRouteHasBody<K extends ApiRouteName> = ApiRouteContract[K] extends { body: unknown }
    ? true
    : false;
