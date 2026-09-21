/*
 * 上游接口封装：gdata / gtoken / showpage。
 * 请求体与响应字段名保持上游原样；单次上限 25 条，超出自动分批。
 * 图片地址来自 showpage 的片段解析，静态 HTML 里没有。
 */

import { callApiJson, type UpstreamSite } from "./http.ts";
import {
    MAX_ENTRIES_PER_REQUEST,
    UPSTREAM_API,
    type GdataResponse,
    type GtokenEntry,
    type GtokenResponse,
    type GalleryApiInfo,
    type ShowpageResponse,
    type ShowpageResult,
} from "./types.ts";

export interface EhCallOptions {
    /** 缺省为外站 */
    readonly site?: UpstreamSite;
    /** 账号 Cookie；公开元数据可不带 */
    readonly cookies?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    /** 调用方的取消信号，透传到上游请求 */
    readonly signal?: AbortSignal;
}

/** [gid, token] */
export type GalleryTokenPair = readonly [number, string];

/** [gid, 图片页 token, 页码（从 1 开始）] */
export type PageTokenQuery = readonly [number, string, number];

export interface ShowpageInput {
    readonly gid: number;
    /** 从 1 开始 */
    readonly page: number;
    /** 图片页 token */
    readonly imgkey: string;
    /** 从图片页 HTML 取得的 showkey */
    readonly showkey: string;
}

/** 图库元数据。返回顺序与入参一致，失败条目带 error 字段而非抛错 */
export async function gdata(
    pairs: readonly GalleryTokenPair[],
    options: EhCallOptions = {},
): Promise<GalleryApiInfo[]> {
    const collected: GalleryApiInfo[] = [];
    for (const part of chunked(pairs, MAX_ENTRIES_PER_REQUEST)) {
        const response = await callApiJson<GdataResponse>({
            ...requestOf(options),
            body: JSON.stringify({
                method: "gdata",
                gidlist: part.map(([gid, token]) => [gid, token]),
                // 带上命名空间前缀，返回形如 "female:stockings"
                namespace: 1,
            }),
        });
        if (response.gmetadata === undefined) {
            throw new Error("gdata 响应缺少 gmetadata");
        }
        collected.push(...response.gmetadata);
    }
    return collected;
}

/** 由图片页链接反查画廊 token。返回顺序与入参一致，失败条目带 error 字段 */
export async function gtoken(
    pages: readonly PageTokenQuery[],
    options: EhCallOptions = {},
): Promise<GtokenEntry[]> {
    const collected: GtokenEntry[] = [];
    for (const part of chunked(pages, MAX_ENTRIES_PER_REQUEST)) {
        const response = await callApiJson<GtokenResponse>({
            ...requestOf(options),
            body: JSON.stringify({
                method: "gtoken",
                pagelist: part.map(([gid, pageToken, page]) => [gid, pageToken, page]),
            }),
        });
        if (response.tokenlist === undefined) {
            throw new Error("gtoken 响应缺少 tokenlist");
        }
        collected.push(...response.tokenlist);
    }
    return collected;
}

/** 取单页图片地址。上游以 error 字段报错时抛出 */
export async function showpage(
    input: ShowpageInput,
    options: EhCallOptions = {},
): Promise<ShowpageResult> {
    const response = await callApiJson<ShowpageResponse>({
        ...requestOf(options),
        body: JSON.stringify({
            method: "showpage",
            gid: input.gid,
            page: input.page,
            imgkey: input.imgkey,
            showkey: input.showkey,
        }),
    });

    if (response.error !== undefined) {
        throw new Error(`showpage 失败：${response.error}`);
    }

    const imageUrl = matchGroup(response.i3 ?? "", /<img[^>]*src="([^"]+)" style/);
    if (imageUrl === null) {
        throw new Error("showpage 响应中未找到图片地址");
    }

    const origin = (response.i7 ?? "").match(/<a href="([^"]+)fullimg\.php([^"]+)">/);
    const skipHathKey = matchGroup(response.i6 ?? "", /onclick="return nl\('([^)]+)'\)/);

    return {
        imageUrl: decodeEntities(imageUrl),
        originalImageUrl:
            origin === null ? null : decodeEntities(`${origin[1]}fullimg.php${origin[2]}`),
        skipHathKey: skipHathKey === null ? null : decodeEntities(skipHathKey),
    };
}

function requestOf(options: EhCallOptions): {
    url: string;
    method: "POST";
    site: UpstreamSite;
    cookies?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    signal?: AbortSignal;
} {
    const site = options.site ?? "e-hentai";
    const request: {
        url: string;
        method: "POST";
        site: UpstreamSite;
        cookies?: Readonly<Record<string, string>>;
        timeoutMs?: number;
        signal?: AbortSignal;
    } = { url: UPSTREAM_API[site], method: "POST", site };
    if (options.cookies !== undefined) {
        request.cookies = options.cookies;
    }
    if (options.timeoutMs !== undefined) {
        request.timeoutMs = options.timeoutMs;
    }
    if (options.signal !== undefined) {
        request.signal = options.signal;
    }
    return request;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        out.push(items.slice(index, index + size));
    }
    return out.length === 0 ? [] : out;
}

function matchGroup(text: string, pattern: RegExp): string | null {
    const found = pattern.exec(text);
    return found === null ? null : (found[1] ?? null);
}

/** 上游片段里的 XML 实体 */
function decodeEntities(text: string): string {
    return text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&");
}
