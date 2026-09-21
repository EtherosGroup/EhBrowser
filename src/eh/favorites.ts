/*
 * 收藏相关接口。
 * 收藏与取消收藏走 gallerypopups.php 的表单提交：favcat >= 0 放进对应分类，-1 表示取消。
 * 分类名与数量、分类里的画廊都从 favorites.php 取；需要登录，未登录时上游返回登录页。
 * 页面解析用宽松匹配：上游结构变化时只会解析不到（界面上表现为空），不会中断整个流程。
 */

import { isLoginRequired, LoginRequiredError, callApi, type UpstreamSite } from "./http.ts";
import { siteOrigin } from "./urls.ts";

export interface FavoriteRequestOptions {
    readonly site: UpstreamSite;
    readonly cookies?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface CloudFavoriteCategory {
    /** 0～9；-1 是「本地标记」而不是云端分类 */
    readonly slot: number;
    readonly name: string;
    readonly count: number;
}

/** 分类里的画廊，只需要 gid 与 token，其余字段由 gdata 补 */
export type FavoriteGalleryPair = readonly [gid: number, token: string];

interface RequestShape {
    readonly url: string;
    readonly method: "POST";
    readonly site: UpstreamSite;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly cookies?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

function requestOf(options: FavoriteRequestOptions, url: string, body = ""): RequestShape {
    return {
        url,
        method: "POST",
        site: options.site,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
}

function favoritesUrl(site: UpstreamSite, query = ""): string {
    return `${siteOrigin(site)}/favorites.php${query}`;
}

/**
 * 收藏或取消收藏。
 * 上游返回的是一个 HTML 弹窗；这里只看状态码与是否被重定向到登录页。
 */
export async function setFavorite(
    gid: number,
    token: string,
    slot: number,
    options: FavoriteRequestOptions,
): Promise<void> {
    const url =
        `${siteOrigin(options.site)}/gallerypopups.php?gid=${gid}` +
        `&t=${encodeURIComponent(token)}&act=addfav`;
    const body = `favcat=${slot}&favnote=&submit=Apply+Changes`;
    const response = await callApi(requestOf(options, url, body));
    if (isLoginRequired(response)) {
        throw new LoginRequiredError("收藏需要登录后操作");
    }
    if (response.status >= 400) {
        throw new Error(`收藏接口返回 HTTP ${response.status}`);
    }
}

/**
 * 云端收藏夹的名称与数量。
 * 默认名是 Favorites 0～9，用户改过名字的按页面上的文字；解析不到时返回空列表。
 */
export async function fetchFavoriteCategories(
    options: FavoriteRequestOptions,
): Promise<readonly CloudFavoriteCategory[]> {
    const response = await callApi(requestOf(options, favoritesUrl(options.site)));
    if (isLoginRequired(response)) {
        throw new LoginRequiredError("收藏需要登录后操作");
    }
    if (response.status >= 400) {
        return [];
    }
    const found = new Map<number, CloudFavoriteCategory>();
    // 形如 href="?favcat=0">名称</a>  (12)
    const pattern = /favcat=(\d+)[^>]*>([^<]{0,64})<\/a>[\s\S]{0,80}?\((\d{1,7})\)/g;
    for (const matched of response.text.matchAll(pattern)) {
        const slot = Number(matched[1]);
        const raw = matched[2]?.trim() ?? "";
        if (!Number.isInteger(slot) || slot < 0 || slot > 9 || found.has(slot)) {
            continue;
        }
        found.set(slot, {
            slot,
            name: raw === "" ? `Favorites ${slot}` : raw.replaceAll("&amp;", "&"),
            count: Number(matched[3]),
        });
    }
    return [...found.values()].sort((a, b) => a.slot - b.slot);
}

/**
 * 某个分类里的画廊。
 * 只取第一页：收藏页同样分页，这里先返回第一页的内容。
 */
export async function fetchFavoriteGalleryPairs(
    slot: number,
    options: FavoriteRequestOptions,
): Promise<readonly FavoriteGalleryPair[]> {
    const response = await callApi(
        requestOf(options, favoritesUrl(options.site, `?favcat=${slot}`)),
    );
    if (isLoginRequired(response)) {
        throw new LoginRequiredError("收藏需要登录后操作");
    }
    if (response.status >= 400) {
        return [];
    }
    const pairs: FavoriteGalleryPair[] = [];
    const seen = new Set<number>();
    const pattern = /\/g\/(\d+)\/([0-9a-fA-F]{8,})\//g;
    for (const matched of response.text.matchAll(pattern)) {
        const gid = Number(matched[1]);
        const token = matched[2] ?? "";
        if (!Number.isFinite(gid) || token === "" || seen.has(gid)) {
            continue;
        }
        seen.add(gid);
        pairs.push([gid, token]);
    }
    return pairs;
}
