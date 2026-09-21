/*
 * 路由表与 URL 工具。
 * ROUTES 与 contract.ts 相互约束：漏写路由或写入契约中不存在的路由都会编译报错。
 * 用法：routePath("galleries.detail", { gid, token }) + buildQueryString({ page: 2 })。
 */

import type { ApiRouteContract, ApiRouteName, ApiRouteParams } from "./contract.ts";
import type { HttpMethod } from "./envelope.ts";

/** 接口统一前缀 */
export const API_BASE_PATH = "/api";

/**
 * 本地令牌请求头
 * 服务端仅监听 127.0.0.1，但浏览器中的任意页面都可向 localhost 发起请求（CSRF），
 * 因此所有接口均要求令牌；令牌每次启动重新生成，仅注入本地界面
 */
export const API_TOKEN_HEADER = "x-ehbrowser-token";

/** EventSource 无法设置请求头，令牌经 query 传递 */
export const API_TOKEN_QUERY_PARAM = "_token";

export interface RouteDescriptor {
    readonly method: HttpMethod;
    readonly path: string;
    readonly description: string;
    /** 是否需要本地令牌；仅 /api/health 为 false，供就绪探针使用 */
    readonly requiresToken: boolean;
    /** 是否需要已登录 E-Hentai / ExHentai 账号 */
    readonly requiresAccount: boolean;
}

export const ROUTES = {
    // ── 系统 ───────────────────────────────────────────────
    "system.health": {
        method: "GET",
        path: "/api/health",
        description: "服务健康状态、版本与运行时长",
        requiresToken: false,
        requiresAccount: false,
    },
    "system.shutdown": {
        method: "POST",
        path: "/api/system/shutdown",
        description: "关闭本地服务；界面与事件流随之断开",
        requiresToken: true,
        requiresAccount: false,
    },
    "system.events": {
        method: "GET",
        path: "/api/events",
        description: "SSE 事件流：配置变更、鉴权变更、下载进度、日志",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 配置 ───────────────────────────────────────────────
    "config.get": {
        method: "GET",
        path: "/api/config",
        description: "取配置快照（生效值 + 每个字段的来源层）",
        requiresToken: true,
        requiresAccount: false,
    },
    "config.patch": {
        method: "PATCH",
        path: "/api/config",
        description: "局部更新用户配置（深合并）",
        requiresToken: true,
        requiresAccount: false,
    },
    "config.paths": {
        method: "GET",
        path: "/api/config/paths",
        description: "数据目录及其来源层（排错用）",
        requiresToken: true,
        requiresAccount: false,
    },
    "config.export": {
        method: "POST",
        path: "/api/config/export",
        description: "导出配置包（可选包含账号凭据）",
        requiresToken: true,
        requiresAccount: false,
    },
    "config.import": {
        method: "POST",
        path: "/api/config/import",
        description: "导入配置包（自动备份并迁移版本）",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 账号与鉴权 ─────────────────────────────────────────
    "auth.status": {
        method: "GET",
        path: "/api/auth/status",
        description: "登录状态摘要（不含任何凭据）",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.login": {
        method: "POST",
        path: "/api/auth/login",
        description: "用账号密码登录，cookie 由服务端持有",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.logout": {
        method: "POST",
        path: "/api/auth/logout",
        description: "清除当前账号的登录态",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.accounts.list": {
        method: "GET",
        path: "/api/auth/accounts",
        description: "账号列表（脱敏）",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.accounts.create": {
        method: "POST",
        path: "/api/auth/accounts",
        description: "新增账号（提交 cookie 或密码）",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.accounts.update": {
        method: "PATCH",
        path: "/api/auth/accounts/:accountId",
        description: "更新账号备注或凭据",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.accounts.remove": {
        method: "DELETE",
        path: "/api/auth/accounts/:accountId",
        description: "删除账号",
        requiresToken: true,
        requiresAccount: false,
    },
    "auth.accounts.activate": {
        method: "POST",
        path: "/api/auth/accounts/:accountId/activate",
        description: "切换当前使用的账号",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 画廊 ───────────────────────────────────────────────
    "galleries.search": {
        method: "GET",
        path: "/api/galleries",
        description: "搜索/浏览画廊列表",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.detailCache": {
        method: "GET",
        path: "/api/galleries/detail-cache",
        description: "详情页缓存的状态（条数、上限、体积）",
        requiresToken: true,
        // 只读内存里的缓存，不访问上游
        requiresAccount: false,
    },
    "galleries.detailCache.clear": {
        method: "DELETE",
        path: "/api/galleries/detail-cache",
        description: "清空详情页缓存",
        requiresToken: true,
        requiresAccount: false,
    },
    "galleries.searchCache": {
        method: "GET",
        path: "/api/galleries/cache",
        description: "上一次检索的条件与结果；进程内缓存，应用重启即丢",
        requiresToken: true,
        // 只读本地缓存，不访问上游，因此不要求账号
        requiresAccount: false,
    },
    "galleries.newer": {
        method: "GET",
        path: "/api/galleries/:gid/:token/newer",
        description: "查询是否存在更新的版本，结果落盘缓存",
        requiresToken: true,
        requiresAccount: false,
    },
    "galleries.detail": {
        method: "GET",
        path: "/api/galleries/:gid/:token",
        description: "画廊详情（标签、预览、评论）",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.page": {
        method: "GET",
        path: "/api/galleries/:gid/:token/pages/:page",
        description: "取单页图片地址（服务端代为调用 showpage）",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.token": {
        method: "POST",
        path: "/api/galleries/token",
        description: "由单页链接反查画廊 token（gtoken）",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.rate": {
        method: "POST",
        path: "/api/galleries/:gid/:token/rating",
        description: "评分（需要 apiuid/apikey）",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.favorite": {
        method: "POST",
        path: "/api/galleries/:gid/:token/favorite",
        description: "收藏到指定分类，slot<0 表示取消收藏",
        requiresToken: true,
        requiresAccount: true,
    },
    "galleries.torrents": {
        method: "GET",
        path: "/api/galleries/:gid/:token/torrents",
        description: "种子列表",
        requiresToken: true,
        requiresAccount: false,
    },
    "galleries.previews": {
        method: "GET",
        path: "/api/galleries/:gid/:token/previews",
        description: "某一组预览图，每 20 页一组",
        requiresToken: true,
        requiresAccount: false,
    },
    "galleries.archives": {
        method: "GET",
        path: "/api/galleries/:gid/:token/archives",
        description: "归档选项与账户资金",
        requiresToken: true,
        requiresAccount: true,
    },

    // ── 本地库 ─────────────────────────────────────────────
    "library.list": {
        method: "GET",
        path: "/api/library",
        description: "本地已下载的画廊列表",
        requiresToken: true,
        requiresAccount: false,
    },
    "library.progress": {
        method: "PATCH",
        path: "/api/library/:gid/:resolution",
        description: "写回某个本地画廊的阅读进度",
        requiresToken: true,
        requiresAccount: false,
    },
    // 图片要能直接放进 <img src>，令牌经 query 传递（与 EventSource 的处理一致）
    "library.image": {
        method: "GET",
        path: "/api/library/:gid/:resolution/pages/:page",
        description: "取本地已下载的第 page 页图片",
        requiresToken: true,
        requiresAccount: false,
    },
    "library.updates": {
        method: "GET",
        path: "/api/library/updates",
        description: "更新检查的缓存与进度（只读）",
        requiresToken: true,
        requiresAccount: false,
    },
    "library.check": {
        method: "POST",
        path: "/api/library/updates",
        description: "发起更新检查，结果经 SSE 逐条推送",
        requiresToken: true,
        requiresAccount: true,
    },
    "library.updates.forget": {
        method: "POST",
        path: "/api/library/updates/forget",
        description: "从更新列表里移除若干条目（不删除本地文件）",
        requiresToken: true,
        requiresAccount: false,
    },
    "library.remove": {
        method: "DELETE",
        path: "/api/library/:gid/:resolution",
        description: "删除本地画廊及其目录",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 储存空间 ───────────────────────────────────────────
    "storage.stats": {
        method: "GET",
        path: "/api/storage",
        description: "本地画廊与画廊缓存的占用统计",
        requiresToken: true,
        requiresAccount: false,
    },
    "storage.cleanup": {
        method: "POST",
        path: "/api/storage/cleanup",
        description: "按时间清理画廊缓存",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 收藏 ───────────────────────────────────────────────
    "favorites.state": {
        method: "GET",
        path: "/api/favorites",
        description: "本地收藏夹与云端收藏分类",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.folder.create": {
        method: "POST",
        path: "/api/favorites/folders",
        description: "新建本地收藏夹",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.folder.remove": {
        method: "DELETE",
        path: "/api/favorites/folders/:folderId",
        description: "删除本地收藏夹及其条目",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.items": {
        method: "GET",
        path: "/api/favorites/folders/:folderId/items",
        description: "本地收藏夹里的画廊",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.items.add": {
        method: "POST",
        path: "/api/favorites/items",
        description: "把一个画廊加入本地收藏夹（可同时指定云端槽位）",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.items.remove": {
        method: "DELETE",
        path: "/api/favorites/folders/:folderId/items/:gid",
        description: "从本地收藏夹移除一个画廊",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.items.slot": {
        method: "PATCH",
        path: "/api/favorites/folders/:folderId/items/:gid",
        description: "改这条收藏的标记号（云端槽位），登录时同步到上游",
        requiresToken: true,
        requiresAccount: false,
    },
    "favorites.cloud": {
        method: "GET",
        path: "/api/favorites/cloud",
        description: "云端某个收藏分类里的画廊",
        requiresToken: true,
        requiresAccount: true,
    },
    "favorites.items.refresh": {
        method: "POST",
        path: "/api/favorites/folders/:folderId/items/refresh",
        description: "更新标记号：把收藏从这一版挪到上游的最新版本",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 日志 ───────────────────────────────────────────────
    "log.state": {
        method: "GET",
        path: "/api/logs",
        description: "日志目录、文件名与最近若干条日志",
        requiresToken: true,
        // 只读内存里的环形缓冲，不访问上游
        requiresAccount: false,
    },

    // ── 标签翻译词库 ───────────────────────────────────────
    "translate.status": {
        method: "GET",
        path: "/api/translate",
        description: "标签翻译词库的状态",
        requiresToken: true,
        // 只读本地文件，不访问上游
        requiresAccount: false,
    },
    "translate.tags": {
        method: "GET",
        path: "/api/translate/tags",
        description: "整份标签翻译词库（原文 → 中文名）",
        requiresToken: true,
        requiresAccount: false,
    },
    "translate.update": {
        method: "POST",
        path: "/api/translate/update",
        description: "从 EhTagTranslation/Database 的发布包下载并重建词库",
        requiresToken: true,
        // 下载的是 GitHub 的发布包，不是 E-Hentai，因此不要求登录
        requiresAccount: false,
    },
    "translate.remove": {
        method: "DELETE",
        path: "/api/translate",
        description: "删除本地词库，回到内置的常用翻译",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 播放列表 ───────────────────────────────────────────
    "playlist.list": {
        method: "GET",
        path: "/api/playlist",
        description: "用户播放列表与当前播放项",
        requiresToken: true,
        requiresAccount: false,
    },
    "playlist.add": {
        method: "POST",
        path: "/api/playlist",
        description: "把一个画廊加入用户播放列表",
        requiresToken: true,
        requiresAccount: false,
    },
    "playlist.play": {
        method: "POST",
        path: "/api/playlist/:key/play",
        description: "把某一项设为当前播放项",
        requiresToken: true,
        requiresAccount: false,
    },
    "playlist.progress": {
        method: "PATCH",
        path: "/api/playlist/:key",
        description: "写回某个画廊的播放进度",
        requiresToken: true,
        requiresAccount: false,
    },
    "playlist.remove": {
        method: "DELETE",
        path: "/api/playlist/:key",
        description: "从播放列表移除一项",
        requiresToken: true,
        requiresAccount: false,
    },
    "playlist.clear": {
        method: "DELETE",
        path: "/api/playlist",
        description: "清空播放列表",
        requiresToken: true,
        requiresAccount: false,
    },

    // ── 下载 ───────────────────────────────────────────────
    "downloads.list": {
        method: "GET",
        path: "/api/downloads",
        description: "下载任务列表",
        requiresToken: true,
        requiresAccount: false,
    },
    "downloads.create": {
        method: "POST",
        path: "/api/downloads",
        description: "新建归档下载任务",
        requiresToken: true,
        requiresAccount: true,
    },
    "downloads.retry": {
        method: "POST",
        path: "/api/downloads/:taskId/retry",
        description: "重新排队失败或已取消的下载任务",
        requiresToken: true,
        requiresAccount: false,
    },
    "downloads.cancel": {
        method: "DELETE",
        path: "/api/downloads/:taskId",
        description: "取消或移出下载任务",
        requiresToken: true,
        requiresAccount: false,
    },
} as const satisfies Record<ApiRouteName, RouteDescriptor>;

/**
 * 填充 :name 占位符。缺少参数时抛出异常，避免生成无效 URL
 */
export function fillPath(
    template: string,
    params: Readonly<Record<string, string | number>> = {},
): string {
    return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined) {
            throw new Error(`缺少路径参数：${name}（模板 ${template}）`);
        }
        return encodeURIComponent(String(value));
    });
}

/**
 * 构造查询串
 * undefined / null / 空字符串跳过，可选字段可直接传入
 * 数组以逗号连接（多值参数统一约定，如 categories），布尔输出 1 / 0
 * 空格编码为 %20 而非 +，保证分类名原样传递给上游
 */
export function buildQueryString(params: Readonly<Record<string, unknown>>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") {
            continue;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                continue;
            }
            search.set(key, value.map((item) => String(item)).join(","));
        } else if (typeof value === "boolean") {
            search.set(key, value ? "1" : "0");
        } else {
            search.set(key, String(value));
        }
    }
    const query = search.toString().replaceAll("+", "%20");
    return query === "" ? "" : `?${query}`;
}

/** 取路由路径；无路径参数的路由无需第二个实参，由条件类型约束 */
export function routePath<K extends ApiRouteName>(
    name: K,
    ...args: ApiRouteParams<K> extends Record<string, never> ? [] : [params: ApiRouteParams<K>]
): string {
    const params = (args as readonly unknown[])[0];
    return fillPath(ROUTES[name].path, (params ?? {}) as Readonly<Record<string, string | number>>);
}

/* ── 路径参数覆盖检查 ──
 * 路径中的 :param 必须在契约 params 中声明
 * 背景：曾将 page 声明为 query，类型检查未报错，运行时才由 fillPath 抛出
 * 两个已知陷阱：
 *   1. 使用 keyof ApiRouteParams<ApiRouteName>：keyof 作用于联合类型时取键交集，
 *      此处退化为 never，Exclude 不再排除任何项，断言失效
 *   2. 用 ApiRouteParams 判断已声明参数：未声明 params 的路由退化为 Record<string, never>，
 *      其 keyof 为 string，会吞掉所有参数名
 * 因此按路由逐个比较。纯类型实现，无运行时开销
 */

/** 从路径模板字面量中提取 :param 名称 */
type ExtractPathParams<Path extends string> = Path extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractPathParams<`/${Rest}`>
    : Path extends `${string}/:${infer Param}`
      ? Param
      : never;

type PathParamsOf<K extends ApiRouteName> = ExtractPathParams<(typeof ROUTES)[K]["path"]>;

/** 契约中该路由声明的参数名；未声明 params 时为 never */
type DeclaredPathParamKeys<K extends ApiRouteName> = ApiRouteContract[K] extends {
    params: infer P;
}
    ? keyof P & string
    : never;

/** 路径中存在但契约未声明的参数 */
type MissingPathParamsOf<K extends ApiRouteName> = Exclude<
    PathParamsOf<K>,
    DeclaredPathParamKeys<K>
>;

/** 需逐路由展开，每个路由与自身的 params 比较 */
type MissingPathParamEntries<K extends ApiRouteName = ApiRouteName> = K extends ApiRouteName
    ? [MissingPathParamsOf<K>] extends [never]
        ? never
        : { readonly route: K; readonly missing: MissingPathParamsOf<K> }
    : never;

/** true 表示完全覆盖；否则展开为缺失的路由与参数 */
export type PathParamsCoverageReport = [MissingPathParamEntries] extends [never]
    ? true
    : MissingPathParamEntries;

/** 存在缺失时此行编译报错，错误信息包含路由名与参数名 */
const PATH_PARAMS_COVERAGE: PathParamsCoverageReport = true as const;
void PATH_PARAMS_COVERAGE;
