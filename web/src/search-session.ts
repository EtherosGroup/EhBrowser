/*
 * 搜索页已加载结果的内存副本。
 * 结果区改成「加载更多」之后，列表是一整份累积起来的；而组件按路由路径重建
 * （点开画廊详情再回来、或从标签页切回来都会重建），累积状态留在组件里会丢。
 * 因此放模块里，重建后原样铺回去。
 * 只存在于本次页面会话：整页刷新即丢，那时退回服务端检索缓存（只留一页）并重新检索。
 */

import type { GallerySearchQuery, GallerySummary } from "../../src/api/index.ts";

export interface SearchSession {
    /** 已加载的检索条件；page 是已加载的页数，不是当前显示的是第几页 */
    readonly query: GallerySearchQuery;
    /** 已经累积起来的整份列表 */
    readonly items: readonly GallerySummary[];
    readonly hasNext: boolean;
}

let session: SearchSession | null = null;

/** 上一次加载的结果，没有则为 null */
export function readSearchSession(): SearchSession | null {
    return session;
}

/** 记下这次加载之后的结果。存的是追加完的整份列表，因此覆盖写即可 */
export function saveSearchSession(value: SearchSession): void {
    session = value;
}
