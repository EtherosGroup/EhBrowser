/*
 * 画廊服务：把上游接口元数据与页面解析结果归一化为线上 DTO
 * 列表只从搜索页取 (gid, token)，其余字段由 gdata 批量补全；详情与图片页需要解析 HTML
 * 画廊页解析结果带短时缓存，连续翻页时不会每次重新获取
 */

import {
    GALLERY_CATEGORIES,
    GALLERY_LANGUAGES,
    SEARCH_PAGE_LIMIT,
    type ArchiveCatalog,
    type EpochSeconds,
    type ArchiveOption,
    type GalleryCategory,
    type GalleryDetail,
    type GalleryImagePage,
    type GalleryLanguage,
    type GalleryPreviewPage,
    type GalleryPreviewSet,
    type GalleryRelation,
    type GallerySearchCache,
    type GallerySearchQuery,
    type GallerySearchResult,
    type GallerySummary,
    type GalleryTagGroup,
    type TorrentInfo,
} from "../api/index.ts";
import { activeAccount, type ConfigContext } from "../config/index.ts";
import {
    callApi,
    fetchArchiveCatalog,
    galleryUrl,
    imagePageUrl,
    isUsablePage,
    parseGalleryPage,
    parseImagePage,
    parseSearchResults,
    searchUrl,
    torrentsUrl,
    LoginRequiredError,
    type GalleryApiInfo,
    type ParsedGalleryPage,
    type UpstreamSite,
} from "../eh/index.ts";
import type { DetailStore } from "./detail-store.ts";
import type { UpstreamService } from "./upstream-service.ts";
import { createDetailCache, type DetailCacheStats } from "./detail-cache.ts";
import { createSearchCache } from "./search-cache.ts";

/** 未登录或凭据不足时抛出，由路由层映射为 not_logged_in */

export interface GalleryService {
    search(query: GallerySearchQuery): Promise<GallerySearchResult>;
    /**
     * 上一次检索的条件与结果，供界面再次进入搜索页时先铺内容
     * 没有缓存时，若预热正在进行则等待它结束（避免界面重复发起同样的检索），否则返回 null
     */
    cachedSearch(): Promise<GallerySearchCache | null>;
    /** 启动预热：按默认条件拉取一次并写入缓存，失败时只记日志 */
    warmSearch(): Promise<void>;
    /** 单个画廊的列表项快照。下载时存进本地库元数据，离线也能展示卡片 */
    summaryOf(gid: number, token: string, signal?: AbortSignal): Promise<GallerySummary>;
    /** 一批画廊的列表项快照。收藏夹内容这类一次取多条时用，走一次 gdata */
    summariesOf(
        pairs: readonly (readonly [number, string])[],
        signal?: AbortSignal,
    ): Promise<readonly GallerySummary[]>;
    /**
     * 详情。默认走详情缓存（信息 + 封面 + 缩略图），再次进入同一画廊时不发上游请求；
     * fresh 为真时跳过读取（仍然写回），供更新检查这类必须取到最新数据的场景使用
     */
    detail(
        gid: number,
        token: string,
        options?: { readonly fresh?: boolean },
    ): Promise<GalleryDetail>;
    /**
     * 查询是否存在更新的版本，结果落盘。新版本一旦出现就不会消失，查到即长期保留；
     * 只有「查过且当时没有」才隔一天重查。上游不可达时抛出错误，由调用方决定如何显示。
     */
    newer(
        gid: number,
        token: string,
    ): Promise<{ newer: GalleryRelation | null; checkedAt: EpochSeconds | null }>;
    imagePage(
        gid: number,
        token: string,
        page: number,
        pageToken?: string,
        options?: { readonly fresh?: boolean },
    ): Promise<GalleryImagePage>;
    torrents(gid: number, token: string): Promise<readonly TorrentInfo[]>;
    previews(
        gid: number,
        token: string,
        index: number,
        signal?: AbortSignal,
        options?: { readonly fresh?: boolean },
    ): Promise<GalleryPreviewSet>;
    /** 详情缓存的状态，设置页用来看条数与体积 */
    detailCacheStats(): DetailCacheStats;
    /** 清空详情缓存 */
    clearDetailCache(): DetailCacheStats;
    archives(gid: number, token: string): Promise<ArchiveCatalog>;
}

export interface GalleryServiceOptions {
    /** 详情持久缓存，接入后详情可跨重启保留 */
    readonly store?: DetailStore;
    /** 画廊页缓存条数 */
    readonly cacheSize?: number;
    readonly cacheTtlMs?: number;
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

const SEARCH_PAGE_SIZE = 25;
/** 查过且当时没有新版本时，隔多久重查一次（秒） */
const RECHECK_NEWER_SECONDS = 86_400;
const THUMBS_PER_PAGE = 20;
/** 界面读取缓存时等待预热的上限。预热卡住时界面不能一直等下去 */
const WARMUP_WAIT_MS = 12_000;

/** 定时器不阻塞事件循环，进程可以正常退出 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

export function createGalleryService(
    ctx: ConfigContext,
    upstream: UpstreamService,
    options: GalleryServiceOptions = {},
): GalleryService {
    const cacheSize = options.cacheSize ?? 32;
    const cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    /** 详情页缓存：条数上限取自设置，修改后立即生效 */
    const detailCache = createDetailCache({
        limit: () => ctx.user.get().ui.cachedGalleries,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const pageCache = new Map<string, { readonly at: number; readonly page: ParsedGalleryPage }>();
    const searchCache = createSearchCache(ctx.paths.cacheDir);
    /** 在途的预热检索。界面在没有缓存时会等它，避免同一份结果被拉取两次 */
    let warming: Promise<void> | null = null;

    // 上次运行留下的缓存一律丢弃：重启后的第一份结果由预热检索（或界面自身的检索）决定
    void searchCache.discard();

    /** 记录本次检索，界面再次进入搜索页时可以先据此铺出内容 */
    function rememberSearch(query: GallerySearchQuery, result: GallerySearchResult): void {
        searchCache.save({
            query: { ...query, page: result.page, limit: result.limit },
            result,
            savedAt: Math.floor(Date.now() / 1000),
        });
    }

    async function runSearch(query: GallerySearchQuery): Promise<GallerySearchResult> {
        const page = query.page ?? 1;
        const limit = query.limit ?? SEARCH_PAGE_SIZE;
        const response = await callApi({
            url: searchUrl(currentSite(), {
                ...query,
                page: Math.max(0, page - 1),
            }),
            ...pageOptions(),
        });
        if (!isUsablePage(response.status)) {
            throw new Error(`搜索页返回 HTTP ${response.status}`);
        }

        const pairs = parseSearchResults(response.text).slice(0, limit);
        if (pairs.length === 0) {
            const empty: GallerySearchResult = { items: [], page, limit, hasNext: false };
            rememberSearch(query, empty);
            return empty;
        }

        const infos = await upstream.gdata(pairs.map((pair) => [pair.gid, pair.token]));
        const items = infos.filter((info) => info.error === undefined).map(toSummary);
        const result: GallerySearchResult = {
            items,
            page,
            limit,
            // 上游不返回总数，取满一页即认为可能还有下一页
            hasNext: pairs.length >= limit,
        };
        rememberSearch(query, result);
        return result;
    }

    function currentSite(): UpstreamSite {
        return activeAccount(ctx.auth.get())?.site ?? ctx.user.get().preferredSite;
    }

    function pageOptions(extra: { readonly site?: UpstreamSite } = {}): {
        site: UpstreamSite;
    } & ReturnType<UpstreamService["callOptions"]> {
        const auth = upstream.callOptions();
        return { ...(auth ?? {}), site: extra.site ?? auth?.site ?? currentSite() } as never;
    }

    async function loadGalleryPage(
        gid: number,
        token: string,
        thumbPage = 0,
        signal?: AbortSignal,
    ): Promise<ParsedGalleryPage> {
        const key = `${gid}:${token}:${thumbPage}`;
        const hit = pageCache.get(key);
        if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) {
            return hit.page;
        }

        const response = await callApi({
            url: galleryUrl(currentSite(), gid, token, thumbPage),
            ...pageOptions(),
            ...(signal === undefined ? {} : { signal }),
        });
        if (!isUsablePage(response.status)) {
            throw new Error(`画廊页返回 HTTP ${response.status}`);
        }

        const parsed = parseGalleryPage(response.text, gid);
        if (parsed.title === "" && parsed.previewPages.length === 0) {
            throw new Error("画廊页解析为空，页面结构可能已变更");
        }

        pageCache.set(key, { at: Date.now(), page: parsed });
        if (pageCache.size > cacheSize) {
            const oldest = pageCache.keys().next().value;
            if (oldest !== undefined) {
                pageCache.delete(oldest);
            }
        }
        return parsed;
    }

    async function infoOf(gid: number, token: string): Promise<GalleryApiInfo> {
        const infos = await upstream.gdata([[gid, token]]);
        const info = infos[0];
        if (info === undefined) {
            throw new Error("gdata 未返回该画廊");
        }
        if (info.error !== undefined) {
            throw new Error(`gdata 拒绝：${info.error}`);
        }
        return info;
    }

    /** 解析某一页的图片地址。第 1 页（详情页封面）由详情缓存包住，其余页直接调用 */
    async function loadImagePage(
        gid: number,
        token: string,
        page: number,
        pageToken?: string,
    ): Promise<GalleryImagePage> {
        let resolved = pageToken;
        if (resolved === undefined) {
            const thumbPage = Math.floor((Math.max(1, page) - 1) / THUMBS_PER_PAGE);
            const parsed = await loadGalleryPage(gid, token, thumbPage);
            resolved = parsed.pageTokens.get(page);
        }
        if (resolved === undefined) {
            throw new Error(`未找到第 ${page} 页的图片页 token`);
        }

        const response = await callApi({
            url: imagePageUrl(currentSite(), gid, page, resolved),
            ...pageOptions(),
        });
        if (!isUsablePage(response.status)) {
            throw new Error(`图片页返回 HTTP ${response.status}`);
        }

        const parsed = parseImagePage(response.text, gid);
        if (parsed.showkey === null) {
            throw new Error("图片页未取到 showkey");
        }

        const result = await upstream.showpage({
            gid,
            page,
            imgkey: resolved,
            showkey: parsed.showkey,
        });

        return {
            page,
            pageToken: resolved,
            imageUrl: result.imageUrl,
            originalImageUrl: result.originalImageUrl,
            skipHathKey: result.skipHathKey,
            // 上游不再返回尺寸，保留字段
            width: null,
            height: null,
            nextPageToken: parsed.nextToken,
        };
    }

    return {
        search: runSearch,

        async cachedSearch() {
            const hit = await searchCache.read();
            if (hit !== null) {
                return hit;
            }
            if (warming === null) {
                return null;
            }
            // 预热正在进行：等待它结束，界面不必自己再发起一次同样的检索。
            // 但只等待 WARMUP_WAIT_MS，预热卡住（例如上游连不上）时界面不会一直等下去
            await Promise.race([warming, delay(WARMUP_WAIT_MS)]);
            return searchCache.read();
        },

        async warmSearch() {
            if (warming !== null) {
                return warming;
            }
            warming = (async () => {
                try {
                    await runSearch({ page: 1, limit: SEARCH_PAGE_LIMIT });
                } catch (error) {
                    options.logger?.(
                        "warn",
                        `启动预热检索失败：${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            })();
            return warming;
        },

        async summaryOf(gid, token, signal) {
            const infos = await upstream.gdata([[gid, token]], {
                ...(signal === undefined ? {} : { signal }),
            });
            const info = infos[0];
            if (info === undefined || info.error !== undefined) {
                throw new Error(`画廊信息读取失败：#${gid}`);
            }
            return toSummary(info);
        },

        async summariesOf(pairs, signal) {
            if (pairs.length === 0) {
                return [];
            }
            const infos = await upstream.gdata(
                pairs.map(([gid, token]) => [gid, token]),
                signal === undefined ? {} : { signal },
            );
            return infos.filter((info) => info.error === undefined).map(toSummary);
        },

        detail(gid, token, detailOptions) {
            return detailCache.detail(
                gid,
                token,
                async () => {
                    // 内存未命中时读取落盘副本，fresh 的调用方不经过这里
                    const stored =
                        options.store === undefined ? null : await options.store.get(gid, token);
                    if (stored !== null) {
                        return stored.detail;
                    }
                    const [info, parsed] = await Promise.all([
                        infoOf(gid, token),
                        loadGalleryPage(gid, token),
                    ]);
                    const detail = toDetail(info, parsed);
                    // 落盘，重启后同一画廊可以立即打开
                    await options.store?.put(gid, token, detail);
                    return detail;
                },
                detailOptions?.fresh === true,
            );
        },

        async newer(gid, token) {
            const store = options.store;
            const stored = store === undefined ? null : await store.get(gid, token);
            if (stored !== null && stored.newer !== null) {
                return { newer: stored.newer, checkedAt: stored.checkedAt };
            }
            const checkedAt = stored?.checkedAt ?? null;
            if (checkedAt !== null && Date.now() / 1000 - checkedAt < RECHECK_NEWER_SECONDS) {
                return { newer: null, checkedAt };
            }
            const info = await infoOf(gid, token);
            const newer = relationOfNewer(info, gid, token);
            await store?.saveCheck(gid, token, newer);
            return { newer, checkedAt: Math.floor(Date.now() / 1000) };
        },

        imagePage(gid, token, page, pageToken, pageOptions) {
            // 第 1 页即详情页封面，因此纳入缓存（有效期 10 分钟）；其余页地址过期风险更大，直接透传
            if (page !== 1 || pageToken !== undefined) {
                return loadImagePage(gid, token, page, pageToken);
            }
            return detailCache.cover(
                gid,
                token,
                () => loadImagePage(gid, token, page, pageToken),
                pageOptions?.fresh === true,
            );
        },

        async torrents(gid, token) {
            const info = await infoOf(gid, token);
            const site = currentSite();
            return (info.torrents ?? []).map((torrent) => ({
                hash: torrent.hash,
                name: torrent.name,
                // 单条种子的直链需要登录，此处给列表页地址
                url: torrentsUrl(site, gid, token),
                addedAt: Number(torrent.added),
                sizeBytes: Number(torrent.fsize),
            }));
        },

        previews(gid, token, index, signal, previewOptions) {
            const target = Math.max(0, index);
            return detailCache.previews(
                gid,
                token,
                target,
                async () => {
                    const parsed = await loadGalleryPage(gid, token, target, signal);
                    const previews: GalleryPreviewPage[] = parsed.previewPages.map((page) => ({
                        ...page,
                    }));
                    return {
                        index: target,
                        previews,
                        hasMore: previews.length >= THUMBS_PER_PAGE,
                    };
                },
                previewOptions?.fresh === true,
            );
        },

        detailCacheStats() {
            return detailCache.stats();
        },

        clearDetailCache() {
            return detailCache.clear();
        },

        async archives(gid, token) {
            if (!upstream.hasAccount()) {
                throw new LoginRequiredError("归档列表需要登录后查看");
            }
            const parsed = await fetchArchiveCatalog(gid, token, {
                site: currentSite(),
                ...(pageOptions().cookies === undefined ? {} : { cookies: pageOptions().cookies }),
            });
            const options_: ArchiveOption[] = parsed.options.map((option) => ({
                resolution: option.resolution,
                label: option.label,
                sizeText: option.sizeText,
                costText: option.costText,
                viaHath: option.viaHath,
            }));
            const catalog: ArchiveCatalog = { options: options_, fundsText: parsed.fundsText };
            return catalog;
        },
    };
}

const CATEGORY_SET: ReadonlySet<string> = new Set(GALLERY_CATEGORIES);
const LANGUAGE_SET: ReadonlySet<string> = new Set(GALLERY_LANGUAGES);

/** 上游给的是字符串，取不到或不在枚举内时归入 Misc */
function toCategory(value: string | undefined): GalleryCategory {
    const raw = (value ?? "").trim();
    return (CATEGORY_SET.has(raw) ? raw : "Misc") as GalleryCategory;
}

function toLanguage(tags: readonly string[] | undefined): GalleryLanguage | null {
    const found = (tags ?? []).find((tag) => tag.startsWith("language:"));
    if (found === undefined) {
        return null;
    }
    const value = found.slice("language:".length);
    return LANGUAGE_SET.has(value) ? (value as GalleryLanguage) : null;
}

/** 上游把数字当字符串返回，这里统一转换 */
function toNumber(value: string | number | undefined): number {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }
    const parsed = Number(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
}

function toSummary(info: GalleryApiInfo): GallerySummary {
    return {
        gid: info.gid,
        token: info.token ?? "",
        title: info.title ?? "",
        titleJpn: info.title_jpn ?? "",
        category: toCategory(info.category),
        thumbUrl: info.thumb ?? "",
        uploader: info.uploader ?? "",
        postedAt: toNumber(info.posted),
        pageCount: toNumber(info.filecount),
        sizeBytes: info.filesize ?? 0,
        rating: toNumber(info.rating),
        torrentCount: toNumber(info.torrentcount),
        expunged: info.expunged === true,
        tags: info.tags ?? [],
        language: toLanguage(info.tags),
        // 收藏状态需要登录后另查
        favorite: null,
    };
}

/** 标签组优先用页面解析结果（含显示名），缺失时退回 gdata 的带前缀标签 */
function toTagGroups(info: GalleryApiInfo, parsed: ParsedGalleryPage): GalleryTagGroup[] {
    if (parsed.tagGroups.length > 0) {
        return parsed.tagGroups.map((group) => ({ namespace: group.namespace, tags: group.tags }));
    }
    const grouped = new Map<string, string[]>();
    for (const tag of info.tags ?? []) {
        const separator = tag.indexOf(":");
        if (separator === -1) {
            continue;
        }
        const namespace = tag.slice(0, separator);
        const bucket = grouped.get(namespace) ?? [];
        bucket.push(tag.slice(separator + 1));
        grouped.set(namespace, bucket);
    }
    return [...grouped].map(([namespace, tags]) => ({ namespace, tags }));
}

function toRelation(
    gid: string | undefined,
    key: string | undefined,
): { gid: number; token: string } | null {
    const parsed = Number(gid ?? "");
    return Number.isInteger(parsed) && parsed > 0 && key !== undefined
        ? { gid: parsed, token: key }
        : null;
}

/*
 * gdata 返回的 current_* 与自身不同，表示上游存在更新版本。
 * 未返回、与自身相同或字段不完整时，按已是最新处理。
 */
function relationOfNewer(info: GalleryApiInfo, gid: number, token: string): GalleryRelation | null {
    const targetGid = Number(info.current_gid ?? "");
    const targetToken = info.current_key ?? "";
    if (!Number.isFinite(targetGid) || targetGid <= 0 || targetToken === "") {
        return null;
    }
    if (targetGid === gid && targetToken === token) {
        return null;
    }
    return { gid: targetGid, token: targetToken };
}

function toDetail(info: GalleryApiInfo, parsed: ParsedGalleryPage): GalleryDetail {
    const summary = toSummary(info);
    return {
        ...summary,
        title: parsed.title === "" ? summary.title : parsed.title,
        titleJpn: parsed.titleJpn === "" ? summary.titleJpn : parsed.titleJpn,
        category: parsed.category === "" ? summary.category : toCategory(parsed.category),
        tagGroups: toTagGroups(info, parsed),
        // 上游页面不直接给可见性文本，以 expunged 推导
        visibility: info.expunged === true ? "Deleted" : "Visible",
        sizeText: parsed.sizeText === "" ? `${summary.sizeBytes} B` : parsed.sizeText,
        rating: parsed.rating ?? summary.rating,
        ratingCount: parsed.ratingCount,
        favoriteCount: parsed.favoriteCount,
        previewPages: parsed.previewPages.map((page) => ({ ...page })),
        // 评论区结构复杂，暂不解析
        comments: [],
        archiveAvailable: parsed.archiveAvailable,
        parent: toRelation(info.parent_gid, info.parent_key),
        first: toRelation(info.first_gid, info.first_key),
        current: toRelation(info.current_gid, info.current_key),
    };
}
