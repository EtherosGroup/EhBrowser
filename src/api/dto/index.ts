/*
 * DTO 出口
 * 类型须以 export type 重新导出：verbatimModuleSyntax 下写成 export 会留下不存在的运行时绑定
 */

export type {
    DeepPartial,
    EhSite,
    EntityId,
    EpochSeconds,
    FieldIssue,
    PageQuery,
    Paginated,
    ShutdownResult,
    SystemHealth,
} from "./common.ts";

export { STATUS_FLAGS } from "./status.ts";
export type {
    DebugStatusInput,
    DebugStatusResult,
    SystemStatusFlag,
    SystemStatusMetrics,
    SystemStatusState,
} from "./status.ts";

export { GALLERY_CATEGORIES, GALLERY_LANGUAGES, SEARCH_PAGE_LIMIT } from "./gallery.ts";
export type {
    ArchiveCatalog,
    ArchiveOption,
    FavoriteGalleryInput,
    FavoriteGalleryResult,
    GalleryCategory,
    GalleryComment,
    GalleryDetail,
    GalleryDetailCacheStats,
    GalleryFavorite,
    GalleryImagePage,
    GalleryLanguage,
    GalleryNewerVersion,
    GalleryPreviewPage,
    GalleryPreviewSet,
    GalleryRelation,
    GallerySearchCache,
    GallerySearchQuery,
    GallerySearchResult,
    GallerySummary,
    GalleryTagGroup,
    GalleryTokenLookup,
    GalleryTokenResult,
    RateGalleryInput,
    RateGalleryResult,
    TorrentInfo,
} from "./gallery.ts";

export { playlistKeyOf } from "./playlist.ts";
export type {
    PlaylistAddInput,
    PlaylistItem,
    PlaylistKey,
    PlaylistKeyParam,
    PlaylistProgressInput,
    PlaylistSnapshot,
} from "./playlist.ts";

export type {
    CloudFavoriteFolder,
    FavoriteAddInput,
    FavoriteFolder,
    FavoriteFolderInput,
    FavoriteFolderLocator,
    FavoriteItem,
    FavoriteItemLocator,
    FavoriteSlotInput,
    FavoriteRefreshEntry,
    FavoriteRefreshInput,
    FavoriteRefreshResult,
    FavoriteState,
} from "./favorite.ts";

export type {
    LocalGallery,
    UpdateEntry,
    UpdateTarget,
    UpdateCheckTarget,
    UpdateCheckInput,
    UpdateState,
    LocalGalleryLocator,
    LocalImageLocator,
    LocalReadProgressInput,
} from "./library.ts";

export type {
    AccountCredentialsInput,
    AccountSummary,
    AccountUpdateInput,
    AuthStatus,
    EhApiKey,
    EhCookies,
    LoginInput,
} from "./auth.ts";

export type {
    AutoplaySetting,
    ConfigSnapshot,
    DownloadSetting,
    Effective,
    ExportConfigInput,
    ExportConfigResult,
    ImportConfigInput,
    ImportConfigResult,
    NetworkSetting,
    PathsInfo,
    ProxySetting,
    SafetySetting,
    SettingOrigin,
    TranslateSetting,
    UiSetting,
    UserSetting,
    UserSettingPatch,
    ViewerSetting,
} from "./settings.ts";

export type {
    CancelDownloadResult,
    DownloadStatus,
    DownloadTask,
    EnqueueDownloadInput,
} from "./download.ts";

export type { TranslateDatabase, TranslateNamespace, TranslateStatus } from "./translate.ts";

export type { LogEntry, LogLevel, LogState } from "./log.ts";

export type { StorageCleanupInput, StorageCleanupResult, StorageStats } from "./storage.ts";
