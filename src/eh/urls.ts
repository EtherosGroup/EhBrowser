/*
 * 站点页面地址构造。与 api.php 一套分开：这里构造的是 HTML 页面地址，不是接口
 */

import type { UpstreamSite } from "./http.ts";

const SITE_ORIGINS: Readonly<Record<UpstreamSite, string>> = {
    "e-hentai": "https://e-hentai.org",
    exhentai: "https://exhentai.org",
};

/**
 * 分类位。上游搜索表单只有 10 个分类复选（cat_1 … cat_512），Private 没有对应位，无法过滤
 * f_cats 为排除掩码：默认 0 表示不过滤，1023 表示全排除（上游对 1023 与 >=1024 均按不过滤处理）
 */
export const CATEGORY_BITS: Readonly<Record<string, number>> = {
    Misc: 1 << 0,
    Doujinshi: 1 << 1,
    Manga: 1 << 2,
    "Artist CG": 1 << 3,
    "Game CG": 1 << 4,
    Western: 1 << 5,
    "Non-H": 1 << 6,
    "Image Set": 1 << 7,
    Cosplay: 1 << 8,
    "Asian Porn": 1 << 9,
};

export const ALL_CATEGORY_BITS = Object.values(CATEGORY_BITS).reduce((a, b) => a | b, 0);

export interface SearchUrlQuery {
    readonly query?: string;
    /** 只保留这些分类 */
    readonly categories?: readonly string[];
    /** 排除这些分类 */
    readonly excludedCategories?: readonly string[];
    readonly language?: string;
    /** 从 0 开始 */
    readonly page?: number;
    readonly minRating?: number;
}

export function galleryUrl(
    site: UpstreamSite,
    gid: number,
    token: string,
    thumbPage?: number,
): string {
    const base = `${SITE_ORIGINS[site]}/g/${gid}/${token}/`;
    return thumbPage === undefined || thumbPage <= 0 ? base : `${base}?p=${thumbPage}`;
}

export function imagePageUrl(
    site: UpstreamSite,
    gid: number,
    page: number,
    pageToken: string,
    skipHathKey?: string,
): string {
    const base = `${SITE_ORIGINS[site]}/s/${pageToken}/${gid}-${page}`;
    return skipHathKey === undefined ? base : `${base}?nl=${encodeURIComponent(skipHathKey)}`;
}

/** 搜索页。语言过滤并入 f_search，上游支持 language: 前缀 */
export function searchUrl(site: UpstreamSite, query: SearchUrlQuery): string {
    const params = new URLSearchParams();
    const terms: string[] = [];
    if (query.query !== undefined && query.query.trim() !== "") {
        terms.push(query.query.trim());
    }
    if (query.language !== undefined) {
        terms.push(`language:${query.language}`);
    }
    if (terms.length > 0) {
        params.set("f_search", terms.join(" "));
    }

    let excluded = 0;
    for (const category of query.excludedCategories ?? []) {
        excluded |= CATEGORY_BITS[category] ?? 0;
    }
    if ((query.categories ?? []).length > 0) {
        let included = 0;
        for (const category of query.categories ?? []) {
            included |= CATEGORY_BITS[category] ?? 0;
        }
        excluded |= ALL_CATEGORY_BITS & ~included;
    }
    // 上游仅在 advsearch=1 时应用 f_cats 与 f_sr；全排除与超范围的值会被忽略，因此跳过
    if (excluded !== 0 && excluded !== ALL_CATEGORY_BITS) {
        params.set("advsearch", "1");
        params.set("f_cats", String(excluded));
    }
    if (query.minRating !== undefined) {
        params.set("advsearch", "1");
        params.set("f_sr", "on");
        params.set("f_srdd", String(Math.max(1, Math.round(query.minRating))));
    }
    if (query.page !== undefined && query.page > 0) {
        params.set("page", String(query.page));
    }

    const search = params.toString();
    return search === "" ? `${SITE_ORIGINS[site]}/` : `${SITE_ORIGINS[site]}/?${search}`;
}

export function archiveUrl(site: UpstreamSite, gid: number, token: string): string {
    return `${SITE_ORIGINS[site]}/archiver.php?gid=${gid}&token=${encodeURIComponent(token)}`;
}

export function torrentsUrl(site: UpstreamSite, gid: number, token: string): string {
    return `${SITE_ORIGINS[site]}/gallerytorrents.php?gid=${gid}&t=${encodeURIComponent(token)}`;
}

export function siteOrigin(site: UpstreamSite): string {
    return SITE_ORIGINS[site];
}
