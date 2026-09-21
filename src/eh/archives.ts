/*
 * 归档相关接口：列表与下载地址。
 *
 * 流程分两步：先取列表（含各分辨率与账户资金），再按分辨率请求下载地址。
 *
 * 需要登录。未登录时上游返回登录页而非 JSON。
 */

import { parseArchiveList } from "./html.ts";
import { callApi, isLoginRequired, LoginRequiredError, type UpstreamSite } from "./http.ts";
import { siteOrigin } from "./urls.ts";

export interface ArchiveRequestOptions {
    readonly site: UpstreamSite;
    readonly cookies?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    /** 调用方的取消信号，透传到上游请求 */
    readonly signal?: AbortSignal;
}

export interface ArchiveEntry {
    readonly resolution: string;
    readonly label: string;
    readonly sizeText: string;
    readonly costText: string;
    readonly viaHath: boolean;
}

export interface ArchiveCatalogResult {
    readonly options: readonly ArchiveEntry[];
    readonly fundsText: string;
}

function archiverUrl(site: UpstreamSite, gid: number, token: string): string {
    return `${siteOrigin(site)}/archiver.php?gid=${gid}&token=${encodeURIComponent(token)}`;
}

function requestOf(
    options: ArchiveRequestOptions,
    url: string,
): {
    url: string;
    method: "POST";
    site: UpstreamSite;
    headers: Record<string, string>;
    body: string;
    cookies?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    signal?: AbortSignal;
} {
    const base = {
        url,
        method: "POST" as const,
        site: options.site,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
    };
    return {
        ...base,
        ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
}

/** 归档列表。解析失败时抛错，调用方据此判断是否需要登录 */
export async function fetchArchiveCatalog(
    gid: number,
    token: string,
    options: ArchiveRequestOptions,
): Promise<ArchiveCatalogResult> {
    const response = await callApi(requestOf(options, archiverUrl(options.site, gid, token)));
    if (isLoginRequired(response)) {
        throw new LoginRequiredError("归档列表需要登录后查看");
    }

    const parsed = parseArchiveList(response.text);
    if (parsed === null) {
        throw new Error(`归档列表解析失败（HTTP ${response.status}），通常表示未登录或会话已失效`);
    }
    return parsed;
}

export function buildArchiveForm(resolution: string, viaHath: boolean): Record<string, string> {
    if (viaHath) {
        // H@H 下载器：由 H@H 客户端在后台取回，不直接给下载地址
        return { hathdl_xres: resolution };
    }
    return {
        dltype: resolution,
        dlcheck: resolution === "org" ? "Download Original Archive" : "Download Resample Archive",
    };
}

/**
 * 请求归档下载地址。普通下载返回直链；H@H 下载返回 null（由客户端另行取回）
 * 服务端打包需要时间，首次可能拿不到地址，故允许重试
 */
export async function resolveArchiveUrl(
    gid: number,
    token: string,
    resolution: string,
    viaHath: boolean,
    options: ArchiveRequestOptions,
): Promise<string | null> {
    if (viaHath) {
        const response = await callApi({
            ...requestOf(options, archiverUrl(options.site, gid, token)),
            body: new URLSearchParams(buildArchiveForm(resolution, true)).toString(),
        });
        if (isLoginRequired(response)) {
            throw new LoginRequiredError("H@H 下载需要登录，请在账号页登录后重试");
        }
        if (response.status !== 200) {
            throw new Error(`H@H 下载请求失败：HTTP ${response.status}`);
        }
        return null;
    }

    const body = new URLSearchParams(buildArchiveForm(resolution, false)).toString();
    const response = await callApi({
        ...requestOf(options, archiverUrl(options.site, gid, token)),
        body,
    });

    if (isLoginRequired(response)) {
        throw new LoginRequiredError("归档下载需要登录，请在账号页登录后重试");
    }

    const url = extractUrl(response.text);
    if (url === null) {
        throw new Error(
            `未取到归档地址（HTTP ${response.status}）：${response.text.slice(0, 120)}`,
        );
    }
    return url;
}

/** 响应可能是 JSON（含 url 字段）或直接的地址文本 */
function extractUrl(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const candidate = parsed["url"] ?? parsed["archive_url"] ?? parsed["download"];
            if (typeof candidate === "string" && candidate.startsWith("http")) {
                return candidate;
            }
        } catch {
            return null;
        }
        return null;
    }
    return trimmed.startsWith("http") ? trimmed : null;
}
