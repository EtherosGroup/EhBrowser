/*
 * 站点 HTML 解析。上游只提供 api.php 的元数据接口，列表、详情与图片页需自行解析。
 *
 * 选择器按 2026-09 的页面结构编写。上游改版时本文件会最先失效，因此解析失败一律返回空值，不抛错。
 */

/** 搜索页返回 451 属正常：上游对部分出口 IP 打该状态码但仍给出结果 */
export function isUsablePage(status: number): boolean {
    return status === 200 || status === 451;
}

export interface ParsedTagGroup {
    readonly namespace: string;
    readonly tags: readonly string[];
}

export interface ParsedPreviewPage {
    readonly page: number;
    /** 上游把本页 20 张缩略图拼成一张横向精灵图，这里给的是精灵图地址 */
    readonly thumbUrl: string;
    /** 单格尺寸 */
    readonly width: number;
    readonly height: number;
    /** 在精灵图里的偏移，渲染时作为 background-position */
    readonly offsetX: number;
    readonly offsetY: number;
}

export interface ParsedGalleryPage {
    readonly title: string;
    readonly titleJpn: string;
    readonly category: string;
    readonly uploader: string;
    readonly postedText: string;
    readonly pageCount: number | null;
    readonly sizeText: string;
    readonly rating: number | null;
    readonly ratingCount: number;
    readonly favoriteCount: number;
    readonly tagGroups: readonly ParsedTagGroup[];
    readonly previewPages: readonly ParsedPreviewPage[];
    readonly archiveAvailable: boolean;
    /** 页码 -> 图片页 token，来自缩略图的 /s/<token>/<gid>-<n> 链接 */
    readonly pageTokens: ReadonlyMap<number, string>;
}

/**
 * 从缩略图格子的 style 里取出精灵图与偏移
 * 形如 width:200px;height:300px;background:transparent url(<图>) -200px 0 no-repeat
 * 旧版上游一页一张图，此时没有偏移，按 0 处理
 */
function parseThumbCell(inner: string): {
    thumbUrl: string;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
} {
    const url = /url\((['"]?)([^'")]+)\1\)/.exec(inner)?.[2] ?? "";
    const size = /width:\s*(\d+)px;\s*height:\s*(\d+)px/.exec(inner);
    // 第二个数值常常省略单位，形如 -200px 0
    const offset = /\)\s*(-?\d+)px\s+(-?\d+)(?:px)?/.exec(inner);
    return {
        thumbUrl: decodeEntities(url),
        width: size === null ? 0 : Number(size[1]),
        height: size === null ? 0 : Number(size[2]),
        offsetX: offset === null ? 0 : Number(offset[1]),
        offsetY: offset === null ? 0 : Number(offset[2]),
    };
}

export function parseGalleryPage(html: string, gid: number): ParsedGalleryPage {
    const tagGroups = new Map<string, string[]>();
    for (const found of html.matchAll(/<a[^>]*id="td_([a-z]+):[^"]*"[^>]*>([^<]*)<\/a>/g)) {
        const namespace = found[1] ?? "";
        const name = decodeEntities((found[2] ?? "").trim());
        if (namespace === "" || name === "") {
            continue;
        }
        const bucket = tagGroups.get(namespace) ?? [];
        bucket.push(name);
        tagGroups.set(namespace, bucket);
    }

    const previews: ParsedPreviewPage[] = [];
    const pageTokens = new Map<number, string>();
    // 缩略图没有 img 标签：一格是一个 200x300 的 div，背景是整张精灵图，通过 offset 定位到自身那一格
    for (const found of html.matchAll(
        /<a[^>]*href="https?:\/\/[^"]*\/s\/([0-9a-f]{10})\/(\d+)-(\d+)"[^>]*>([\s\S]{0,600}?)<\/a>/g,
    )) {
        const token = found[1] ?? "";
        const hrefGid = Number(found[2]);
        const page = Number(found[3]);
        const inner = found[4] ?? "";
        if (token === "" || !Number.isInteger(page) || hrefGid !== gid) {
            continue;
        }
        const cell = parseThumbCell(inner);
        if (!pageTokens.has(page)) {
            pageTokens.set(page, token);
        }
        previews.push({ page, ...cell });
    }

    const ratingLabel = textOf(html, /<td[^>]*id="rating_label"[^>]*>([\s\S]{0,200}?)<\/td>/);
    const ratingMatch = /([0-9]+(?:\.[0-9]+)?)/.exec(ratingLabel);

    return {
        title: decodeEntities(textOf(html, /<h1[^>]*id="gn"[^>]*>([\s\S]*?)<\/h1>/)),
        titleJpn: decodeEntities(textOf(html, /<h1[^>]*id="gj"[^>]*>([\s\S]*?)<\/h1>/)),
        category: decodeEntities(
            textOf(html, /<div[^>]*id="gdc"[^>]*>[\s\S]{0,200}?<a[^>]*>([^<]+)<\/a>/),
        ),
        uploader: decodeEntities(
            textOf(html, /<div[^>]*id="gdn"[^>]*>([\s\S]{0,200}?)<\/div>/).replace(
                /\s+<a[\s\S]*$/,
                "",
            ),
        ),
        postedText: textOf(html, /Posted:<\/td>\s*<td[^>]*>([^<]*)</),
        pageCount: toInteger(textOf(html, /(?:Length|File Count):<\/td>\s*<td[^>]*>([^<]*)</)),
        sizeText: textOf(html, /File Size:<\/td>\s*<td[^>]*>([^<]*)</),
        rating: ratingMatch === null ? null : Number(ratingMatch[1]),
        ratingCount:
            toInteger(textOf(html, /<span[^>]*id="rating_count"[^>]*>([\s\S]{0,80}?)</)) ?? 0,
        favoriteCount: toInteger(textOf(html, /<td[^>]*id="favcount"[^>]*>([\s\S]{0,80}?)</)) ?? 0,
        tagGroups: [...tagGroups].map(([namespace, tags]) => ({ namespace, tags })),
        previewPages: previews,
        archiveAvailable: html.includes("archiver.php"),
        pageTokens,
    };
}

export interface ParsedImagePage {
    readonly showkey: string | null;
    readonly previousToken: string | null;
    readonly nextToken: string | null;
}

export function parseImagePage(html: string, gid: number): ParsedImagePage {
    return {
        showkey: /showkey="([^"]+)"/.exec(html)?.[1] ?? null,
        previousToken: pageTokenOf(html, "prev", gid),
        nextToken: pageTokenOf(html, "next", gid),
    };
}

/** 搜索页只取 (gid, token) 对，其余字段由 gdata 补全。结果行的 class 在内层 div 上，故只按 href 匹配 */
export function parseSearchResults(html: string): Array<{ gid: number; token: string }> {
    const out: Array<{ gid: number; token: string }> = [];
    const seen = new Set<number>();
    for (const found of html.matchAll(
        /<a[^>]*href="https?:\/\/[^"]*\/g\/(\d+)\/([0-9a-f]{10})\/"/g,
    )) {
        const gid = Number(found[1]);
        const token = found[2] ?? "";
        if (!Number.isInteger(gid) || token === "" || seen.has(gid)) {
            continue;
        }
        seen.add(gid);
        out.push({ gid, token });
    }
    return out;
}

/** 归档列表是 JSON：{ "archives": [...], "funds": "..." } 之类的结构 */
export interface ParsedArchiveOption {
    readonly resolution: string;
    readonly label: string;
    readonly sizeText: string;
    readonly costText: string;
    readonly viaHath: boolean;
}

export function parseArchiveList(text: string): {
    options: ParsedArchiveOption[];
    fundsText: string;
} | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object") {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    const list = Array.isArray(record["archives"]) ? record["archives"] : [];
    const options: ParsedArchiveOption[] = [];
    for (const item of list) {
        if (item === null || typeof item !== "object") {
            continue;
        }
        const entry = item as Record<string, unknown>;
        const resolution = String(entry["res"] ?? entry["dltype"] ?? "");
        if (resolution === "") {
            continue;
        }
        options.push({
            resolution,
            label: String(entry["name"] ?? resolution),
            sizeText: String(entry["size"] ?? ""),
            costText: String(entry["cost"] ?? ""),
            viaHath: entry["hath"] === true || entry["hathdl_xres"] !== undefined,
        });
    }
    return { options, fundsText: String(record["funds"] ?? "") };
}

function pageTokenOf(html: string, direction: string, gid: number): string | null {
    const pattern = new RegExp(
        `<a[^>]*id="${direction}"[^>]*href="https?://[^"]*/s/([0-9a-f]{10})/${gid}-\\d+"`,
    );
    return pattern.exec(html)?.[1] ?? null;
}

function textOf(html: string, pattern: RegExp): string {
    const found = pattern.exec(html);
    if (found === null) {
        return "";
    }
    return (found[1] ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .trim();
}

function toInteger(text: string): number | null {
    const digits = text.replace(/[^0-9]/g, "");
    return digits === "" ? null : Number(digits);
}

function decodeEntities(text: string): string {
    return text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&")
        .replace(/\s+/g, " ")
        .trim();
}
