/*
 * 路由表。顶部标签即路由，刷新后停在原页面，前进后退可用。
 * 用 HTML5 路径，服务端对不存在的无扩展名路径回退到 index.html。
 * 导航经 NProgress 表达，页面切换动画由 App.vue 的 Transition 负责。
 */

import type { Component } from "vue";
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";

import AccountPanel from "./components/AccountPanel.vue";
import GalleryLibraryPage from "./components/GalleryLibraryPage.vue";
import GalleryPage from "./components/GalleryPage.vue";
import GalleryPreviewsPage from "./components/GalleryPreviewsPage.vue";
import PlayerPage from "./components/PlayerPage.vue";
import FavoritesPage from "./components/FavoritesPage.vue";
import PlaylistPage from "./components/PlaylistPage.vue";
import ConfigPanel from "./components/ConfigPanel.vue";
import DownloadsPanel from "./components/DownloadsPanel.vue";
import SearchPanel from "./components/SearchPanel.vue";
import ServicePanel from "./components/ServicePanel.vue";
import { doneProgress, finishProgress, startProgress } from "./progress.ts";

/** 站点名。标签名与它相同时，标题不重复它。 */
const BRAND = "EhBrowser";

export interface TabRoute {
    readonly path: string;
    /** 顶部标签文字。 */
    readonly label: string;
    /** 页面标题，最终显示为「标题 - EhBrowser」。 */
    readonly title: string;
    readonly component: Component;
}

/** 标签页顺序即导航顺序，两侧都从这里取，避免两处维护。 */
export const TABS: readonly TabRoute[] = [
    { path: "/", label: "EhBrowser", title: "EhBrowser", component: SearchPanel },
    { path: "/config", label: "配置", title: "配置", component: ConfigPanel },
    { path: "/account", label: "账号", title: "账号", component: AccountPanel },
    { path: "/library", label: "本地画廊", title: "本地画廊", component: GalleryLibraryPage },
    { path: "/favorites", label: "收藏", title: "收藏", component: FavoritesPage },
    { path: "/playlist", label: "播放列表", title: "播放列表", component: PlaylistPage },
    { path: "/downloads", label: "下载", title: "下载", component: DownloadsPanel },
    { path: "/service", label: "服务", title: "服务", component: ServicePanel },
];

const routes: RouteRecordRaw[] = [
    ...TABS.map((tab) => ({
        path: tab.path,
        component: tab.component,
        meta: { title: tab.title },
    })),
    // 画廊详情独立成页：只加载这一个画廊，地址可收藏、可分享
    {
        path: "/g/:gid/:token",
        name: "gallery",
        component: GalleryPage,
        props: (route) => ({
            gid: Number(route.params["gid"]),
            token: String(route.params["token"]),
        }),
        meta: { title: "画廊" },
    },
    // 播放器即阅读面：一页一张大图，翻页、缩放、自动播放、网页全屏都在这里
    {
        path: "/g/:gid/:token/play",
        name: "gallery-player",
        component: PlayerPage,
        props: (route) => ({
            gid: Number(route.params["gid"]),
            token: String(route.params["token"]),
        }),
        meta: { title: "播放" },
    },
    // 早先的阅读器路由保留为重定向，书签与旧链接照常可用
    {
        path: "/g/:gid/:token/read",
        redirect: (route) => ({
            name: "gallery-player",
            params: route.params,
            query: route.query,
        }),
    },
    // 全部预览图单独成页：详情页只铺前 20 张
    {
        path: "/g/:gid/:token/previews",
        name: "gallery-previews",
        component: GalleryPreviewsPage,
        props: (route) => ({
            gid: Number(route.params["gid"]),
            token: String(route.params["token"]),
        }),
        meta: { title: "全部预览" },
    },
    // 地址栏里手改出来的路径一律回首页
    { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(() => {
    startProgress();
});

router.afterEach((to) => {
    // 导航是离散事件，收尾用强制版本，避免重定向把计数留在中间。
    finishProgress();
    const title = to.meta["title"];
    document.title = typeof title === "string" && title !== BRAND ? `${title} - ${BRAND}` : BRAND;
});

router.onError(() => {
    doneProgress();
});
