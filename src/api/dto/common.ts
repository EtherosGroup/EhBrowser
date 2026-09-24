/*
 * 通用线上类型
 * 上游常以字符串返回数值（posted、filecount 等），归一化在服务端完成，线上类型均为 number
 * 字段一律 readonly：浏览器侧只读
 */

/** UTC 时间戳 */
export type EpochSeconds = number;

/** 站点：外站或里站 */
export type EhSite = "e-hentai" | "exhentai";

/** 服务端生成的标识，用于账号、下载任务等 */
export type EntityId = string;

/** 分页请求；page 从 1 开始，与上游 URL 一致 */
export interface PageQuery {
    readonly page?: number;
    /** 服务端按上限裁剪 */
    readonly limit?: number;
}

/** 分页结果 */
export interface Paginated<T> {
    readonly items: readonly T[];
    readonly page: number;
    readonly limit: number;
    readonly hasNext: boolean;
    /** 上游未提供时省略 */
    readonly total?: number;
}

/** PATCH 用局部更新；数组整体替换，不逐项合并 */
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[]
        ? T[K]
        : T[K] extends object
          ? DeepPartial<T[K]>
          : T[K];
};

/** 字段级问题；结构与 config/validate.ts 一致，由服务层映射 */
export interface FieldIssue {
    /** 点分路径，用于定位界面输入框 */
    readonly path: string;
    readonly code: "missing" | "type" | "range" | "enum" | "conflict";
    readonly message: string;
}

/** 图片代理的查询参数。url 必须是上游图床地址（服务端有白名单），_token 是本地令牌 */
export interface ProxyImageQuery {
    readonly url: string;
    readonly _token: string;
}

/** 关闭请求的受理结果。响应先回，进程随后自己退出 */
export interface ShutdownResult {
    readonly closing: boolean;
}

/** 服务端版本与运行状态 */
export interface SystemHealth {
    readonly status: "ok";
    readonly version: string;
    readonly nodeVersion: string;
    readonly platform: "windows" | "macos" | "linux";
    readonly startedAt: EpochSeconds;
    readonly uptimeSeconds: number;
}
