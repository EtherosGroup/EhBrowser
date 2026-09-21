/*
 * 前端 API 客户端。路由、参数与响应类型全部从 src/api 契约推导，路径不手写
 * 本地令牌由服务端注入页面，见 window.__EHBROWSER__
 */

import { withProgress } from "./progress.ts";
import {
    API_TOKEN_HEADER,
    buildQueryString,
    isApiFailure,
    routePath,
    type ApiResponse,
    type ApiRouteContract,
    type ApiRequestBody,
    type ApiRouteName,
    type ApiRouteParams,
    type ApiRouteQuery,
} from "../../src/api/index.ts";

/** 从契约取该路由响应里的 data 类型 */
type DataOf<K extends ApiRouteName> = ApiRouteContract[K] extends {
    response: ApiResponse<infer D>;
}
    ? D
    : never;

export interface CallOptions<K extends ApiRouteName> {
    readonly params?: ApiRouteParams<K>;
    readonly query?: ApiRouteQuery<K>;
    readonly body?: ApiRequestBody<K>;
    /** 取消信号。组件卸载时中断，避免离开页面后请求仍在进行 */
    readonly signal?: AbortSignal;
}

export class ApiCallError extends Error {
    readonly code: string;
    readonly issues: readonly { path: string; message: string }[];

    constructor(
        code: string,
        message: string,
        issues: readonly { path: string; message: string }[],
    ) {
        super(message);
        this.name = "ApiCallError";
        this.code = code;
        this.issues = issues;
    }
}

interface Boot {
    readonly token: string;
    readonly port: number;
}

export function boot(): Boot {
    const injected = globalThis.window?.__EHBROWSER__;
    if (injected === undefined) {
        throw new Error("页面未注入启动信息，请通过服务端地址访问");
    }
    return injected;
}

/**
 * 本地图片的地址。<img src> 带不了请求头，令牌只能走 query（与 SSE 同款处理）
 * 页面里直接当 src 用即可
 */
export function libraryImageUrl(gid: number, resolution: string, page: number): string {
    return (
        routePath("library.image", { gid, resolution, page }) +
        buildQueryString({ _token: boot().token })
    );
}

/** 与 api/routes.ts 的方法表一致；改动路由会在此处编译报错 */
const ROUTE_METHODS: Readonly<Record<ApiRouteName, string>> = {
    "system.health": "GET",
    "system.shutdown": "POST",
    "system.events": "GET",
    "config.get": "GET",
    "config.patch": "PATCH",
    "config.paths": "GET",
    "config.export": "POST",
    "config.import": "POST",
    "auth.status": "GET",
    "auth.login": "POST",
    "auth.logout": "POST",
    "auth.accounts.list": "GET",
    "auth.accounts.create": "POST",
    "auth.accounts.update": "PATCH",
    "auth.accounts.remove": "DELETE",
    "auth.accounts.activate": "POST",
    "galleries.search": "GET",
    "galleries.detailCache": "GET",
    "galleries.detailCache.clear": "DELETE",
    "galleries.searchCache": "GET",
    "galleries.newer": "GET",
    "galleries.detail": "GET",
    "galleries.page": "GET",
    "galleries.token": "POST",
    "galleries.rate": "POST",
    "galleries.favorite": "POST",
    "galleries.previews": "GET",
    "galleries.torrents": "GET",
    "galleries.archives": "GET",
    "favorites.state": "GET",
    "favorites.folder.create": "POST",
    "favorites.folder.remove": "DELETE",
    "favorites.items": "GET",
    "favorites.items.add": "POST",
    "favorites.items.remove": "DELETE",
    "favorites.items.slot": "PATCH",
    "favorites.cloud": "GET",
    "favorites.items.refresh": "POST",
    "log.state": "GET",
    "translate.status": "GET",
    "translate.tags": "GET",
    "translate.update": "POST",
    "translate.remove": "DELETE",
    "playlist.list": "GET",
    "playlist.add": "POST",
    "playlist.play": "POST",
    "playlist.progress": "PATCH",
    "playlist.remove": "DELETE",
    "playlist.clear": "DELETE",
    "library.updates": "GET",
    "library.check": "POST",
    "library.updates.forget": "POST",
    "library.list": "GET",
    "library.progress": "PATCH",
    "library.image": "GET",
    "library.remove": "DELETE",
    "storage.stats": "GET",
    "storage.cleanup": "POST",
    "downloads.retry": "POST",
    "downloads.list": "GET",
    "downloads.create": "POST",
    "downloads.cancel": "DELETE",
};

/** 发起一次契约内的请求。失败抛 ApiCallError，其 issues 可直接对应到输入框 */
export async function request<K extends ApiRouteName>(
    name: K,
    options: CallOptions<K> = {},
): Promise<DataOf<K>> {
    // routePath 的实参类型由条件类型推导，泛型包装里无法逐路由满足，此处放宽
    const buildPath = routePath as (
        route: ApiRouteName,
        params?: Record<string, string | number>,
    ) => string;
    const path =
        buildPath(name, options.params as Record<string, string | number> | undefined) +
        (options.query === undefined
            ? ""
            : buildQueryString(options.query as Record<string, unknown>));

    const response = await withProgress(
        fetch(path, {
            method: ROUTE_METHODS[name],
            headers: {
                [API_TOKEN_HEADER]: boot().token,
                "content-type": "application/json",
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: options.signal,
        }),
    );

    const payload = (await response.json()) as unknown;
    if (isApiFailure(payload as ApiResponse<unknown>)) {
        const error = (
            payload as {
                error: {
                    code: string;
                    message: string;
                    issues?: { path: string; message: string }[];
                };
            }
        ).error;
        throw new ApiCallError(error.code, error.message, error.issues ?? []);
    }
    return (payload as { data: DataOf<K> }).data;
}

/** 请求被取消。调用方应静默处理，不弹错误提示 */
export function isAbortError(caught: unknown): boolean {
    if (caught instanceof Error && caught.name === "AbortError") {
        return true;
    }
    return globalThis.DOMException !== undefined && caught instanceof globalThis.DOMException;
}

/** 异常转成一句提示。校验失败时列出各字段问题，与输入框提示同源 */
export function describeApiError(caught: unknown): string {
    if (caught instanceof ApiCallError) {
        if (caught.issues.length === 0) {
            return `${caught.code}：${caught.message}`;
        }
        const details = caught.issues.map((issue) => `${issue.path} ${issue.message}`).join("；");
        return `${caught.code}：${details}`;
    }
    return caught instanceof Error ? caught.message : String(caught);
}

/** 订阅 SSE 事件流，返回关闭函数 */
export function subscribeEvents(
    handlers: Readonly<Record<string, (data: unknown) => void>>,
): () => void {
    const source = new EventSource(
        `${routePath("system.events")}${buildQueryString({ _token: boot().token })}`,
    );
    for (const [event, handler] of Object.entries(handlers)) {
        source.addEventListener(event, (message) => {
            handler(JSON.parse((message as MessageEvent).data));
        });
    }
    return () => {
        source.close();
    };
}
