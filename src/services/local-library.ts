/*
 * 本地库：下载落盘的画廊目录、目录内的 .ehbrowser 元数据、按页取图。
 *
 * 落盘形状为 <下载根>/<分辨率>@<画廊名>/，图片按页序重命名为 0001.jpg 这样的文件名。
 * 元数据只记条数与读到第几页，避免把上千个文件名写进一个小文件。
 *
 * 目录本身是唯一事实来源，手动修改目录内容或删除目录内文件都能如实反映出来。
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import type { GalleryDetail, GallerySummary, LocalGallery } from "../api/index.ts";
import type { ConfigContext } from "../config/index.ts";
import { writeFileAtomic } from "../config/atomic.ts";
import { extractEntry, isDirectory, readZipEntries } from "./zip.ts";

/** 元数据文件名，与规格中的命名一致 */
export const META_FILENAME = ".ehbrowser";
const META_SCHEMA_VERSION = 1;

/** 可识别的图片后缀。解压时只取这些后缀，取图时按同样规则匹配 */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"]);

/** 页序文件名：0001.jpg */
const PAGE_FILE = /^(\d{1,6})\.([A-Za-z0-9]+)$/;

/**
 * 下载中的标记。写在画廊目录里，记录当前下载的是哪一版。
 * 逐页下载被打断后重来时用它判断目录里的页文件是否属于同一本：是则续下，否则清空。
 */
export const DOWNLOAD_STATE_FILENAME = ".ehbrowser.downloading";

/** 目录里已有的一页 */
export interface ExistingPage {
    readonly page: number;
    /** 文件字节数，用于把已下载的量计入进度 */
    readonly bytes: number;
}

/** 下载中的标记内容 */
export interface DownloadState {
    readonly gid: number;
    readonly token: string;
    readonly resolution: string;
    readonly pageCount: number;
    readonly startedAt: number;
}

export interface LocalGalleryMeta {
    readonly schemaVersion: number;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    readonly resolution: string;
    readonly pageCount: number;
    /** 已解压出来的页数 */
    readonly files: number;
    readonly sizeBytes: number;
    readonly downloadedAt: number;
    /** 读到第几页，从 1 开始；0 表示没读过 */
    readonly lastReadPage: number;
    readonly lastReadAt: number | null;
    /** 归档文件名；没保留则为 null */
    readonly archive: string | null;
    /** 下载时留下的画廊信息快照，便于离线展示 */
    readonly summary: GallerySummary | null;
    /**
     * 下载时留下的详情页快照（标签分组、评分人数、预览图、系列关系等）。
     * 本地浏览（播放器、详情页）直接使用这一份，不再向上游请求详情；较早的下载可能没有。
     */
    readonly detail: GalleryDetail | null;
}

/**
 * 已落盘的元数据加上目录信息。
 * 仅在内部使用（读取快照、合并写回需要用它定位目录），出接口前一律经 toLocalGallery 收成 DTO 字段。
 */
export interface StoredGallery extends LocalGalleryMeta {
    readonly folder: string;
    readonly path: string;
}

/** 元数据中会进入接口的字段。schemaVersion 与详情快照不出接口 */
export function toLocalGallery(meta: StoredGallery): LocalGallery {
    return {
        gid: meta.gid,
        token: meta.token,
        title: meta.title,
        resolution: meta.resolution,
        folder: meta.folder,
        path: meta.path,
        pageCount: meta.pageCount,
        files: meta.files,
        sizeBytes: meta.sizeBytes,
        downloadedAt: meta.downloadedAt,
        lastReadPage: meta.lastReadPage,
        lastReadAt: meta.lastReadAt,
        archive: meta.archive,
        summary: meta.summary,
    };
}

export interface LocalLibrary {
    /** 下载根目录，取自配置 */
    root(): string;
    /** 扫描全部本地画廊，按下载时间从新到旧排序 */
    list(): Promise<readonly LocalGallery[]>;
    find(gid: number, resolution: string): Promise<LocalGallery | null>;
    /**
     * 落盘的详情页快照。同一个 gid 有多份副本时取最近下载的那一份。
     * 有快照时不必向上游请求详情，本地浏览因此不依赖网络。
     */
    storedDetail(gid: number, token: string): Promise<GalleryDetail | null>;
    /**
     * 把详情快照补进这个 gid 的每一份本地副本（只改 detail 一个字段，盘上其余字段保持现状）。
     * 供较早的下载补上快照，返回实际写入的份数。
     */
    saveDetail(gid: number, detail: GalleryDetail): Promise<number>;
    /** 第 page 页的图片绝对路径，没有则 null */
    imagePath(gid: number, resolution: string, page: number): Promise<string | null>;
    /** 写回阅读进度 */
    saveProgress(gid: number, resolution: string, page: number): Promise<LocalGallery | null>;
    /** 下载完成后写入元数据 */
    write(meta: LocalGalleryMeta, folder: string): Promise<void>;
    /**
     * 目录里已经下载完成的页（页号与字节数）。
     * 逐页下载的续传依赖它：已有的页不重新下载，进度也从此处起算。
     */
    existingPages(folder: string): Promise<readonly ExistingPage[]>;
    /** 读取下载标记；不存在、内容损坏或不属于这一版时返回 null */
    downloadState(folder: string): Promise<DownloadState | null>;
    /** 开始下载时写入标记，供同一版被打断后重来时识别 */
    beginDownload(folder: string, state: DownloadState): Promise<void>;
    /** 下载收尾时清除标记，页文件一律保留 */
    endDownload(folder: string): Promise<void>;
    /** 清除某个画廊目录里已有的页文件。仅在确认更换下载目标时调用 */
    clearPages(folder: string): Promise<void>;
    /** 解压归档到目标文件夹，返回解出的页数 */
    extractArchive(archivePath: string, folder: string): Promise<number>;
    /** 删除一个本地画廊，返回是否删除成功 */
    remove(gid: number, resolution: string): Promise<boolean>;
    /** 清空内存中的扫描缓存与页索引缓存 */
    invalidate(): void;
}

/**
 * 画廊名清洗：各平台非法字符取并集，并去掉控制字符与首尾的空格和点号。
 * Windows 不允许名称以点或空格结尾，这里统一处理；长度截断到 100 字，避免路径过长。
 */
export function safeGalleryName(title: string): string {
    const cleaned = title
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "");
    const capped = cleaned.slice(0, 100).trim();
    return capped === "" ? "untitled" : capped;
}

/** 画廊文件夹名：<分辨率>@<清洗后的画廊名> */
export function libraryFolderName(resolution: string, title: string): string {
    return `${safeGalleryName(resolution)}@${safeGalleryName(title)}`;
}

function isSummary(value: unknown): value is GallerySummary {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const item = value as Partial<GallerySummary>;
    return typeof item.gid === "number" && typeof item.title === "string";
}

/** 详情快照比列表项多了标签分组，缺少该字段即不是一份可用的详情 */
function isDetail(value: unknown): value is GalleryDetail {
    return isSummary(value) && Array.isArray((value as Partial<GalleryDetail>).tagGroups);
}

/**
 * 从详情快照里取出列表项需要的字段。
 * 只有详情、没有列表项快照时用它兜底，避免把整份详情放进列表响应。
 */
export function summaryOfDetail(detail: GalleryDetail): GallerySummary {
    return {
        gid: detail.gid,
        token: detail.token,
        title: detail.title,
        titleJpn: detail.titleJpn,
        category: detail.category,
        thumbUrl: detail.thumbUrl,
        uploader: detail.uploader,
        postedAt: detail.postedAt,
        pageCount: detail.pageCount,
        sizeBytes: detail.sizeBytes,
        rating: detail.rating,
        torrentCount: detail.torrentCount,
        expunged: detail.expunged,
        tags: detail.tags,
        language: detail.language,
        favorite: detail.favorite,
    };
}

/** 读入的元数据按陌生数据校验，文件损坏时仅将该目录视为不是本地画廊 */
function parseMeta(text: string, folder: string): StoredGallery | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const raw = parsed as Record<string, unknown>;
    const gid = Number(raw["gid"]);
    const resolution = typeof raw["resolution"] === "string" ? raw["resolution"] : "";
    if (!Number.isFinite(gid) || resolution === "") {
        return null;
    }
    const number = (key: string): number => {
        const value = Number(raw[key]);
        return Number.isFinite(value) ? value : 0;
    };
    const detail = isDetail(raw["detail"]) ? (raw["detail"] as GalleryDetail) : null;
    return {
        schemaVersion: number("schemaVersion") || META_SCHEMA_VERSION,
        gid,
        token: typeof raw["token"] === "string" ? raw["token"] : "",
        title: typeof raw["title"] === "string" ? raw["title"] : folder,
        resolution,
        pageCount: number("pageCount"),
        files: number("files"),
        sizeBytes: number("sizeBytes"),
        downloadedAt: number("downloadedAt"),
        lastReadPage: number("lastReadPage"),
        lastReadAt: raw["lastReadAt"] === null ? null : number("lastReadAt"),
        archive: typeof raw["archive"] === "string" ? raw["archive"] : null,
        summary: isSummary(raw["summary"])
            ? (raw["summary"] as GallerySummary)
            : detail === null
              ? null
              : summaryOfDetail(detail),
        detail,
        folder,
        path: "",
    };
}

export interface LocalLibraryOptions {
    /** 未配置下载目录时使用的落点 */
    readonly fallbackDirectory: (ctx: ConfigContext) => string;
}

export function createLocalLibrary(ctx: ConfigContext, options: LocalLibraryOptions): LocalLibrary {
    /** 页序索引：文件夹到「页号 -> 文件名」的映射。取图每页都要用到，因此缓存 */
    const pageIndex = new Map<string, ReadonlyMap<number, string>>();
    /** 目录扫描结果，避免一次页面渲染中反复读盘 */
    let scannedAt = 0;
    let scanned: readonly StoredGallery[] | null = null;
    const SCAN_TTL_MS = 2000;

    function root(): string {
        const configured = ctx.user.get().download.directory;
        return configured === "" ? options.fallbackDirectory(ctx) : configured;
    }

    async function readMeta(folder: string): Promise<StoredGallery | null> {
        const path = join(root(), folder);
        let text: string;
        try {
            text = await readFile(join(path, META_FILENAME), "utf8");
        } catch {
            // 没有元数据的目录不是本地画廊：可能正在下载，也可能是用户自行放入的内容
            return null;
        }
        const meta = parseMeta(text, folder);
        if (meta === null) {
            return null;
        }
        return { ...meta, path };
    }

    async function scan(): Promise<readonly StoredGallery[]> {
        if (scanned !== null && Date.now() - scannedAt < SCAN_TTL_MS) {
            return scanned;
        }
        const directory = root();
        let entries: Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            // 目录尚不存在，本地库为空
            scanned = [];
            scannedAt = Date.now();
            return scanned;
        }
        const found: StoredGallery[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const meta = await readMeta(entry.name);
            if (meta !== null) {
                found.push(meta);
            }
        }
        found.sort((a, b) => b.downloadedAt - a.downloadedAt);
        scanned = found;
        scannedAt = Date.now();
        return found;
    }

    /**
     * 页号到文件名的映射。文件名即解压时按页序写下的 0001.jpg。
     * 按页号取值而不是按排序后的下标：中间缺少某个页号时返回 null，
     * 不会把后一页当成前一页。
     */
    async function pagesOf(folder: string): Promise<ReadonlyMap<number, string>> {
        const path = join(root(), folder);
        const cached = pageIndex.get(path);
        if (cached !== undefined) {
            return cached;
        }
        let names: string[];
        try {
            names = await readdir(path);
        } catch {
            const empty = new Map<number, string>();
            pageIndex.set(path, empty);
            return empty;
        }
        const result = new Map<number, string>();
        for (const name of names) {
            const matched = PAGE_FILE.exec(name);
            if (matched === null) {
                continue;
            }
            if (!IMAGE_EXTENSIONS.has(matched[2]!.toLowerCase())) {
                continue;
            }
            const page = Number(matched[1]);
            if (!result.has(page)) {
                result.set(page, name);
            }
        }
        pageIndex.set(path, result);
        return result;
    }

    /**
     * 目录里已有的页，按页号排序（页号与字节数）。
     * 不经过 pagesOf 的页索引缓存：下载进行中目录持续变化，缓存中的结果可能是刚建目录时的空快照，
     * 用它判断续传会把已经下载完成的页当成不存在，从而重复下载。
     */
    async function existingPages(folder: string): Promise<readonly ExistingPage[]> {
        const path = join(root(), folder);
        let names: string[];
        try {
            names = await readdir(path);
        } catch {
            return [];
        }
        const result: ExistingPage[] = [];
        for (const name of names) {
            const matched = PAGE_FILE.exec(name);
            if (matched === null || !IMAGE_EXTENSIONS.has(matched[2]!.toLowerCase())) {
                continue;
            }
            let bytes = 0;
            try {
                bytes = (await stat(join(path, name))).size;
            } catch {
                // 文件在此期间被删除等情况，按不存在处理
                continue;
            }
            if (bytes > 0) {
                result.push({ page: Number(matched[1]), bytes });
            }
        }
        result.sort((a, b) => a.page - b.page);
        return result;
    }

    async function downloadState(folder: string): Promise<DownloadState | null> {
        let text: string;
        try {
            text = await readFile(join(root(), folder, DOWNLOAD_STATE_FILENAME), "utf8");
        } catch {
            return null;
        }
        try {
            const raw = JSON.parse(text) as Record<string, unknown>;
            const gid = Number(raw["gid"]);
            const resolution = typeof raw["resolution"] === "string" ? raw["resolution"] : "";
            if (!Number.isFinite(gid) || resolution === "") {
                return null;
            }
            return {
                gid,
                token: typeof raw["token"] === "string" ? raw["token"] : "",
                resolution,
                pageCount: Number(raw["pageCount"]) || 0,
                startedAt: Number(raw["startedAt"]) || 0,
            };
        } catch {
            return null;
        }
    }

    async function beginDownload(folder: string, state: DownloadState): Promise<void> {
        const path = join(root(), folder);
        await writeFileAtomic(
            join(path, DOWNLOAD_STATE_FILENAME),
            `${JSON.stringify(state, null, 2)}\n`,
            { mode: 0o600 },
        );
    }

    async function endDownload(folder: string): Promise<void> {
        await rm(join(root(), folder, DOWNLOAD_STATE_FILENAME), { force: true });
    }

    /** 内部使用：包含快照在内的整份元数据。写回时用它保留 detail 这类不经过接口的字段 */
    async function findStored(gid: number, resolution: string): Promise<StoredGallery | null> {
        const all = await scan();
        return all.find((item) => item.gid === gid && item.resolution === resolution) ?? null;
    }

    async function find(gid: number, resolution: string): Promise<LocalGallery | null> {
        const stored = await findStored(gid, resolution);
        return stored === null ? null : toLocalGallery(stored);
    }

    /**
     * 落盘的详情快照。scan 已按下载时间从新到旧排序，取第一条命中的即为最近那一份。
     * token 只在两边都非空时比对：手动改过目录的元数据不应因此被当成另一本。
     */
    async function storedDetail(gid: number, token: string): Promise<GalleryDetail | null> {
        const all = await scan();
        const hit = all.find(
            (item) =>
                item.gid === gid &&
                item.detail !== null &&
                (token === "" || item.token === "" || item.token === token),
        );
        return hit?.detail ?? null;
    }

    async function saveDetail(gid: number, detail: GalleryDetail): Promise<number> {
        const targets = (await scan()).filter((item) => item.gid === gid);
        let written = 0;
        for (const target of targets) {
            // 先读盘上现状再写：下载进行中可能刚改过进度，不能用扫描缓存中的那份覆盖回盘
            const current = await readMeta(target.folder);
            if (current === null) {
                continue;
            }
            await write(
                {
                    ...current,
                    detail,
                    summary: current.summary ?? summaryOfDetail(detail),
                },
                target.folder,
            );
            written += 1;
        }
        return written;
    }

    function invalidate(): void {
        pageIndex.clear();
        scanned = null;
        scannedAt = 0;
    }

    async function write(meta: LocalGalleryMeta, folder: string): Promise<void> {
        const path = join(root(), folder);
        await writeFileAtomic(join(path, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, {
            mode: 0o600,
        });
        // 只写元数据不改变目录成员，页索引丢弃即可
        pageIndex.delete(path);
        /*
         * 扫描缓存中的那份是写入之前的，就地替换为新的。
         * 不这么做的话，写入后 2 秒内再读（例如刚写完阅读进度、紧接着又执行一次）拿到的仍是旧值，
         * 元数据会被旧值覆盖回去。
         */
        if (scanned !== null) {
            const entry: StoredGallery = { ...meta, folder, path };
            const at = scanned.findIndex((item) => item.folder === folder);
            scanned =
                at === -1
                    ? [...scanned, entry]
                    : scanned.map((item, index) => (index === at ? entry : item));
            scannedAt = Date.now();
        }
    }

    /** 清除目录里的页文件（只删按页序命名的文件，元数据与归档均保留） */
    async function clearPages(folder: string): Promise<void> {
        const target = join(root(), folder);
        for (const name of await readdir(target).catch(() => [] as string[])) {
            if (PAGE_FILE.test(name)) {
                await rm(join(target, name), { force: true });
            }
        }
        pageIndex.delete(target);
    }

    /**
     * 解压归档。只取图片，按归档中的顺序重命名为 0001.jpg 这样的页序文件名。
     * 顺序即页序：上游打包时即为该次序，重命名后取第几页就是取第几个文件。
     */
    async function extractArchive(archivePath: string, folder: string): Promise<number> {
        const entries = await readZipEntries(archivePath);
        const target = join(root(), folder);
        // 重新下载同一个画廊时先清除旧的页文件，避免上一版多出的页留在目录里
        for (const name of await readdir(target).catch(() => [] as string[])) {
            if (PAGE_FILE.test(name)) {
                await rm(join(target, name), { force: true });
            }
        }
        let page = 0;
        for (const entry of entries) {
            if (isDirectory(entry)) {
                continue;
            }
            const name = entry.name;
            // 资源叉与隐藏文件不属于内容
            if (
                name.startsWith("__MACOSX/") ||
                name.split("/").some((part) => part.startsWith("."))
            ) {
                continue;
            }
            const dot = name.lastIndexOf(".");
            if (dot === -1) {
                continue;
            }
            const extension = name.slice(dot + 1).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(extension)) {
                continue;
            }
            page += 1;
            const file = join(target, `${String(page).padStart(4, "0")}.${extension}`);
            await extractEntry(archivePath, entry, file);
        }
        if (page === 0) {
            throw new Error("归档里没有可用的图片");
        }
        invalidate();
        return page;
    }

    return {
        root,

        async list() {
            return (await scan()).map(toLocalGallery);
        },

        find,

        storedDetail,
        saveDetail,

        async imagePath(gid, resolution, page) {
            const gallery = await findStored(gid, resolution);
            if (gallery === null || page < 1) {
                return null;
            }
            const pages = await pagesOf(gallery.folder);
            const name = pages.get(page);
            return name === undefined ? null : join(gallery.path, name);
        },

        async saveProgress(gid, resolution, page) {
            const gallery = await findStored(gid, resolution);
            if (gallery === null) {
                return null;
            }
            // 整份元数据一并写回：详情快照这类不经过接口的字段不能因为写进度而丢失
            const next: StoredGallery = {
                ...gallery,
                lastReadPage: Math.max(0, Math.floor(page)),
                lastReadAt: Math.floor(Date.now() / 1000),
            };
            await write(next, gallery.folder);
            return toLocalGallery({ ...next, folder: gallery.folder, path: gallery.path });
        },

        write,

        existingPages,
        downloadState,
        beginDownload,
        endDownload,

        clearPages,

        extractArchive,

        async remove(gid, resolution) {
            const gallery = await findStored(gid, resolution);
            if (gallery === null) {
                return false;
            }
            await rm(gallery.path, { recursive: true, force: true });
            invalidate();
            return true;
        },

        invalidate,
    };
}
