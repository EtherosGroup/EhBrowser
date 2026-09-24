/*
 * 路由名到请求/响应类型的映射，服务端与浏览器共用。
 * 两端据此推导 ApiRouteParams / ApiRequestBody / ApiRouteResponse。
 * 浏览器侧封装为 request<K extends ApiRouteName>(name: K, ...) 即可获得完整类型。
 * routes.ts 末尾的编译期断言用于校验与 ROUTES 的一致性。
 */

import type {
    AccountCredentialsInput,
    AccountSummary,
    AccountUpdateInput,
    ArchiveCatalog,
    AuthStatus,
    CancelDownloadResult,
    ConfigSnapshot,
    DebugStatusInput,
    DebugStatusResult,
    DownloadTask,
    EnqueueDownloadInput,
    ExportConfigInput,
    ExportConfigResult,
    FavoriteGalleryInput,
    FavoriteGalleryResult,
    GalleryDetail,
    GalleryImagePage,
    GalleryNewerVersion,
    GalleryPreviewSet,
    GallerySearchCache,
    GallerySearchQuery,
    GallerySearchResult,
    GalleryTokenLookup,
    GalleryTokenResult,
    ImportConfigInput,
    ImportConfigResult,
    LocalGallery,
    LocalGalleryLocator,
    LocalImageLocator,
    LocalReadProgressInput,
    LoginInput,
    PlaylistAddInput,
    PlaylistKeyParam,
    PlaylistProgressInput,
    PlaylistSnapshot,
    ProxyImageQuery,
    FavoriteAddInput,
    FavoriteFolderInput,
    FavoriteFolderLocator,
    FavoriteItem,
    FavoriteItemLocator,
    FavoriteRefreshInput,
    FavoriteRefreshResult,
    LogState,
    TranslateDatabase,
    TranslateStatus,
    FavoriteSlotInput,
    FavoriteState,
    GalleryDetailCacheStats,
    GallerySummary,
    UpdateCheckInput,
    UpdateState,
    PathsInfo,
    RateGalleryInput,
    RateGalleryResult,
    ShutdownResult,
    SystemHealth,
    SystemStatusState,
    TorrentInfo,
    UserSettingPatch,
    StorageCleanupInput,
    StorageCleanupResult,
    StorageStats,
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
    /** 跳过详情缓存，强制问一次上游（仍然写回缓存） */
    readonly fresh?: boolean;
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
    /** 客户端状态提示的当前值。SSE 会推变化，这里用于首屏与排查 */
    "system.status": { response: ApiResponse<SystemStatusState> };
    /** 调试：强制状态项。返回注入后的状态，页面据此直接刷新 */
    "debug.status": { body: DebugStatusInput; response: ApiResponse<DebugStatusResult> };
    /** 关闭本地服务。成功后界面与 SSE 都会断开，需要重新启动进程 */
    "system.shutdown": { response: ApiResponse<ShutdownResult> };
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
    /** 上一次检索的条件与结果；没有缓存时 data 为 null，界面据此决定是否自行发一次检索 */
    /** 详情缓存的状态：条数、上限与体积，设置页用 */
    "galleries.detailCache": { response: ApiResponse<GalleryDetailCacheStats> };
    /** 清空详情缓存 */
    "galleries.detailCache.clear": { response: ApiResponse<GalleryDetailCacheStats> };
    "galleries.searchCache": { response: ApiResponse<GallerySearchCache | null> };
    "galleries.newer": {
        params: GalleryLocator;
        response: ApiResponse<GalleryNewerVersion>;
    };
    "galleries.detail": {
        params: GalleryLocator;
        /** fresh 为真时跳过详情缓存，直接请求上游 */
        query: { fresh?: boolean };
        response: ApiResponse<GalleryDetail>;
    };
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
    "galleries.previews": {
        params: GalleryLocator;
        query: { index?: number; fresh?: boolean };
        response: ApiResponse<GalleryPreviewSet>;
    };
    "galleries.archives": { params: GalleryLocator; response: ApiResponse<ArchiveCatalog> };

    // ── 本地库 ─────────────────────────────────────────────
    /** 本地已下载的画廊，来自下载目录里的 .ehbrowser 元数据 */
    "library.list": { response: ApiResponse<readonly LocalGallery[]> };
    /** 写回阅读进度。落盘到对应目录的 .ehbrowser */
    "library.progress": {
        params: LocalGalleryLocator;
        body: LocalReadProgressInput;
        response: ApiResponse<LocalGallery>;
    };
    /** 取本地图片。返回图片本身而非信封，故 response 为 never；令牌经 query 传 */
    "library.image": { params: LocalImageLocator; response: never };
    /** 走本机代理取上游图片。查询串为 url 与 _token，返回图片本身而非信封 */
    "proxy.image": { query: ProxyImageQuery; response: never };
    /** 删除本地画廊，连同其目录 */
    "library.remove": { params: LocalGalleryLocator; response: ApiResponse<RemovedResult> };
    /** 更新检查的缓存与进度。只读，不触发检查 */
    "library.updates": { response: ApiResponse<UpdateState> };
    /** 发起更新检查；每查完一条会经 SSE 的 library.update 推过来，进度走 library.progress */
    "library.check": { body: UpdateCheckInput; response: ApiResponse<UpdateState> };
    /** 从更新列表中移除这些条目（对应界面上的「删除更新任务」）。只改列表，不改动本地文件 */
    "library.updates.forget": {
        body: { keys: readonly string[] };
        response: ApiResponse<UpdateState>;
    };

    // ── 收藏 ───────────────────────────────────────────────
    /** 本地收藏夹与云端分类（未登录时 cloudError 说明原因） */
    "favorites.state": { response: ApiResponse<FavoriteState> };
    "favorites.folder.create": { body: FavoriteFolderInput; response: ApiResponse<FavoriteState> };
    "favorites.folder.remove": {
        params: FavoriteFolderLocator;
        response: ApiResponse<FavoriteState>;
    };
    /** 本地收藏夹里的条目 */
    "favorites.items": {
        params: FavoriteFolderLocator;
        response: ApiResponse<readonly FavoriteItem[]>;
    };
    "favorites.items.add": {
        body: FavoriteAddInput;
        response: ApiResponse<readonly FavoriteItem[]>;
    };
    "favorites.items.remove": {
        params: FavoriteItemLocator;
        response: ApiResponse<readonly FavoriteItem[]>;
    };
    /** 改标记号：本地写库，登录时同步到上游 */
    "favorites.items.slot": {
        params: FavoriteItemLocator;
        body: FavoriteSlotInput;
        response: ApiResponse<readonly FavoriteItem[]>;
    };
    /** 云端分类里的画廊 */
    "favorites.cloud": {
        query: { slot?: number };
        response: ApiResponse<readonly GallerySummary[]>;
    };
    /**
     * 更新标记号：把收藏从本地这一版改为上游的最新版本，而不是修改云端槽位
     * 不传 gids 时检查整个收藏夹；每条都要向上游请求一次，速度较慢
     */
    "favorites.items.refresh": {
        params: FavoriteFolderLocator;
        body: FavoriteRefreshInput;
        response: ApiResponse<FavoriteRefreshResult>;
    };

    // ── 日志 ───────────────────────────────────────────────
    /** 日志目录与最近若干条。新日志由 SSE 的 log.appended 推过来 */
    "log.state": {
        query: { limit?: number };
        response: ApiResponse<LogState>;
    };

    // ── 标签翻译词库 ───────────────────────────────────────
    /** 词库状态。只读，不触发下载 */
    "translate.status": { response: ApiResponse<TranslateStatus> };
    /** 整份词库（原文 -> 中文名）。未安装词库时 data 为 null */
    "translate.tags": { response: ApiResponse<TranslateDatabase | null> };
    /** 从上游发布包下载并重建词库。数据不随程序分发，用不用由用户决定 */
    "translate.update": { response: ApiResponse<TranslateStatus> };
    /** 删除本地词库 */
    "translate.remove": { response: ApiResponse<TranslateStatus> };

    // ── 播放列表 ───────────────────────────────────────────
    /** 用户播放列表与当前播放项。持久化在 SQLite，重启不丢 */
    "playlist.list": { response: ApiResponse<PlaylistSnapshot> };
    /** 加入一个画廊。已在列表里则只刷新快照，保留进度与顺序 */
    "playlist.add": { body: PlaylistAddInput; response: ApiResponse<PlaylistSnapshot> };
    "playlist.play": { params: PlaylistKeyParam; response: ApiResponse<PlaylistSnapshot> };
    "playlist.progress": {
        params: PlaylistKeyParam;
        body: PlaylistProgressInput;
        response: ApiResponse<PlaylistSnapshot>;
    };
    "playlist.remove": { params: PlaylistKeyParam; response: ApiResponse<PlaylistSnapshot> };
    "playlist.clear": { response: ApiResponse<PlaylistSnapshot> };

    // ── 下载 ───────────────────────────────────────────────
    "downloads.list": { response: ApiResponse<readonly DownloadTask[]> };
    "downloads.create": { body: EnqueueDownloadInput; response: ApiResponse<DownloadTask> };
    "downloads.cancel": {
        params: { taskId: string };
        response: ApiResponse<CancelDownloadResult>;
    };
    /** 把失败或已取消的任务重新排队。复用同一行，保留历史 */
    "downloads.retry": {
        params: { taskId: string };
        response: ApiResponse<DownloadTask>;
    };

    // ── 储存空间 ───────────────────────────────────────────
    /** 本地画廊与画廊缓存的占用统计 */
    "storage.stats": { response: ApiResponse<StorageStats> };
    /** 按时间清理画廊缓存，只保留最近 days 天内用过的 */
    "storage.cleanup": {
        body: StorageCleanupInput;
        response: ApiResponse<StorageCleanupResult>;
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
