// dto 出口
// 类型必须用 export type 重新导出，verbatimModuleSyntax 下写成 export 会弄出不存在的运行时绑定

export type {
    DeepPartial,
    EhSite,
    EntityId,
    EpochSeconds,
    FieldIssue,
    PageQuery,
    Paginated,
    SystemHealth,
} from "./common.ts";

export { GALLERY_CATEGORIES, GALLERY_LANGUAGES } from "./gallery.ts";
export type {
    ArchiveCatalog,
    ArchiveOption,
    FavoriteGalleryInput,
    FavoriteGalleryResult,
    GalleryCategory,
    GalleryComment,
    GalleryDetail,
    GalleryFavorite,
    GalleryImagePage,
    GalleryLanguage,
    GalleryPreviewPage,
    GalleryRelation,
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
    SettingOrigin,
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
