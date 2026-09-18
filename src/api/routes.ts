// 路由表和拼 URL 的几个小工具
// ROUTES 和 contract.ts 互相盯着：漏写路由、或者写了契约里压根没有的，编译就报
// 浏览器侧用法：routePath("galleries.detail", { gid, token }) + buildQueryString({ page: 2 })

import type { ApiRouteContract, ApiRouteName, ApiRouteParams } from "./contract.ts";
import type { HttpMethod } from "./envelope.ts";

/** 接口前缀 */
export const API_BASE_PATH = "/api";

/**
 * 本地令牌的请求头
 * 服务端只听 127.0.0.1，但用户浏览器里随便哪个页面都能打 localhost（CSRF），
 * 所以每个接口都要令牌。令牌每次启动重新生成，只注入给本地界面
 */
export const API_TOKEN_HEADER = "x-ehbrowser-token";

/** EventSource 加不了头，只能走 query */
export const API_TOKEN_QUERY_PARAM = "_token";

export interface RouteDescriptor {
    readonly method: HttpMethod;
    readonly path: string;
    readonly description: string;
    /** 要不要本地令牌。就 /api/health 不要，留给就绪探针 */
    readonly requiresToken: boolean;
    /** 要不要先登录 E-Hentai 账号 */
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
    "system.events": {
        method: "GET",
        path: "/api/events",
        description: "SSE 事件流：配置变更、鉴权变更、下载进度",
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
    "galleries.archives": {
        method: "GET",
        path: "/api/galleries/:gid/:token/archives",
        description: "归档选项与账户资金",
        requiresToken: true,
        requiresAccount: true,
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
    "downloads.cancel": {
        method: "DELETE",
        path: "/api/downloads/:taskId",
        description: "取消或移出下载任务",
        requiresToken: true,
        requiresAccount: false,
    },
} as const satisfies Record<ApiRouteName, RouteDescriptor>;

/**
 * 填 :name。少参数直接抛 —— 这是写错了，不该默默发出个烂 URL
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
 * 拼查询串
 * 空的、null、undefined 直接跳过，可选字段可以原样扔进来
 * 数组逗号连接（多值参数都这个约定，比如 categories），布尔出 1/0
 * 空格编码成 %20 不是 '+'："Artist CG" 这种分类名要原样传给上游
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

/** 拿路由路径。没参数的路由不用传第二个实参，条件类型保证的 */
export function routePath<K extends ApiRouteName>(
    name: K,
    ...args: ApiRouteParams<K> extends Record<string, never> ? [] : [params: ApiRouteParams<K>]
): string {
    const params = (args as readonly unknown[])[0];
    return fillPath(ROUTES[name].path, (params ?? {}) as Readonly<Record<string, string | number>>);
}

// ── 路径参数覆盖检查 ──
// 路径里的 :param 必须在契约 params 里声明
// 之前把 page 写成 query，类型检查一声没吭，跑到 fillPath 才炸
// 想偷懒的话有俩坑，我都试过了：
//   keyof ApiRouteParams<ApiRouteName> 遇上联合类型取的是键交集，直接变 never，Exclude 白干
//   没写 params 的路由，ApiRouteParams 是 Record<string, never>，keyof 出来是 string，啥都能吞
// 所以老老实实按路由一个个比。纯类型，没运行时开销

/** 从路径模板字面量里抠出 :param 名字 */
type ExtractPathParams<Path extends string> = Path extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractPathParams<`/${Rest}`>
    : Path extends `${string}/:${infer Param}`
      ? Param
      : never;

type PathParamsOf<K extends ApiRouteName> = ExtractPathParams<(typeof ROUTES)[K]["path"]>;

/** 契约给这个路由声明了哪些参数。没写 params 就是 never，一个都不许 */
type DeclaredPathParamKeys<K extends ApiRouteName> = ApiRouteContract[K] extends {
    params: infer P;
}
    ? keyof P & string
    : never;

/** 路径里有、契约里没声明的 */
type MissingPathParamsOf<K extends ApiRouteName> = Exclude<
    PathParamsOf<K>,
    DeclaredPathParamKeys<K>
>;

/** 得逐路由展开，各自跟自己的 params 比 */
type MissingPathParamEntries<K extends ApiRouteName = ApiRouteName> = K extends ApiRouteName
    ? [MissingPathParamsOf<K>] extends [never]
        ? never
        : { readonly route: K; readonly missing: MissingPathParamsOf<K> }
    : never;

/** true 就是全覆盖。不是的话鼠标停上去能看见缺哪个路由的哪个参数 */
export type PathParamsCoverageReport = [MissingPathParamEntries] extends [never]
    ? true
    : MissingPathParamEntries;

/** 缺东西这行就编译报错，错误信息里直接点名路由和参数。别删 */
const PATH_PARAMS_COVERAGE: PathParamsCoverageReport = true as const;
void PATH_PARAMS_COVERAGE;
