/** UTC 时间戳 */
export type EpochSeconds = number;

/** 外站还是里站 */
export type EhSite = "e-hentai" | "exhentai";

/** 服务端自己生成的 id，账号、下载任务都用它 */
export type EntityId = string;

/** 分页请求。page 从 1 开始，跟上游 URL 对齐省得两边换算 */
export interface PageQuery {
    readonly page?: number;
    /** 服务端会按上限裁一刀 */
    readonly limit?: number;
}

/** 分页结果 */
export interface Paginated<T> {
    readonly items: readonly T[];
    readonly page: number;
    readonly limit: number;
    readonly hasNext: boolean;
    /** 上游不给就空着，别硬凑 */
    readonly total?: number;
}

/** PATCH 用的局部更新。数组整个换掉，不逐项合并 */
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[]
        ? T[K]
        : T[K] extends object
          ? DeepPartial<T[K]>
          : T[K];
};

/** 字段级报错。config/validate.ts 那边结构一样，服务层负责搬过来 */
export interface FieldIssue {
    /** 点分路径，界面照着这个找输入框标红 */
    readonly path: string;
    readonly code: "missing" | "type" | "range" | "enum" | "conflict";
    readonly message: string;
}

/** 服务端版本和运行时状态 */
export interface SystemHealth {
    readonly status: "ok";
    readonly version: string;
    readonly nodeVersion: string;
    readonly platform: "windows" | "macos" | "linux";
    readonly startedAt: EpochSeconds;
    readonly uptimeSeconds: number;
}
