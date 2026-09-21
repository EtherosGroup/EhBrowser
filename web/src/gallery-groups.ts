/*
 * 结果网格的分组。搜索时只有一组，标题是「搜索 X 的结果」。
 * 排行榜按时期分组，本地画廊与收藏按各自的维度分组，都复用同一个网格组件。
 */

import type { GallerySummary } from "../../src/api/index.ts";

export interface GalleryGroup {
    readonly title: string;
    readonly items: readonly GallerySummary[];
}

/** 搜索结果那一组的标题。没有关键词时按规格回落到 EhBrowser */
export function searchGroupTitle(key: string): string {
    return `搜索 ${key === "" ? "EhBrowser" : key} 的结果`;
}
