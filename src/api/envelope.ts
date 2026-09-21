/*
 * 统一响应信封
 * 未采用「裸数据 + HTTP 状态码」的原因：客户端只需判断一次 ok，错误统一经 error.code 区分；
 * 校验问题随 issues 返回，可直接定位到输入框。HTTP 状态码仍按 HTTP_STATUS_BY_ERROR 设置
 */

import type { FieldIssue } from "./dto/common.ts";

/** 本项目使用的方法 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 错误码；新增时同步补充 HTTP_STATUS_BY_ERROR */
export type ApiErrorCode =
    /** 参数或请求体不合法，issues 指明具体字段 */
    | "bad_request"
    /** 本地访问令牌缺失或错误 */
    | "unauthorized"
    /** Origin 校验失败，或需登录后执行 */
    | "forbidden"
    | "not_found"
    /** 资源状态冲突，如账号重名、任务已结束 */
    | "conflict"
    /** 配置取值不合法，issues 对应到输入框 */
    | "config_invalid"
    /** 尚未登录 E-Hentai / ExHentai 账号 */
    | "not_logged_in"
    /** 命中上游限流 */
    | "rate_limited"
    /** 上游不可达或超时，未配置代理时最常见 */
    | "upstream_unavailable"
    /** 服务端忙，例如正在导入配置 */
    | "busy"
    /** 路由已定义，尚未实现 */
    | "not_implemented"
    | "internal";

/** 错误码到 HTTP 状态码的映射 */
export const HTTP_STATUS_BY_ERROR: Readonly<Record<ApiErrorCode, number>> = {
    bad_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    config_invalid: 422,
    not_logged_in: 403,
    rate_limited: 429,
    upstream_unavailable: 502,
    busy: 503,
    not_implemented: 501,
    internal: 500,
};

export interface ApiError {
    readonly code: ApiErrorCode;
    readonly message: string;
    /** 仅在 bad_request / config_invalid 时出现 */
    readonly issues?: readonly FieldIssue[];
}

export interface ApiSuccess<T> {
    readonly ok: true;
    readonly data: T;
    readonly requestId?: string;
}

export interface ApiFailure {
    readonly ok: false;
    readonly error: ApiError;
    readonly requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 构造成功响应 */
export function ok<T>(data: T, requestId?: string): ApiSuccess<T> {
    return requestId === undefined ? { ok: true, data } : { ok: true, data, requestId };
}

/** 构造失败响应 */
export function fail(
    code: ApiErrorCode,
    message: string,
    options: { readonly issues?: readonly FieldIssue[]; readonly requestId?: string } = {},
): ApiFailure {
    const error: ApiError =
        options.issues === undefined
            ? { code, message }
            : { code, message, issues: options.issues };
    return options.requestId === undefined
        ? { ok: false, error }
        : { ok: false, error, requestId: options.requestId };
}

/** 类型收窄辅助 */
export function isApiFailure<T>(response: ApiResponse<T>): response is ApiFailure {
    return !response.ok;
}

/** 取错误码对应的 HTTP 状态码 */
export function statusForError(code: ApiErrorCode): number {
    return HTTP_STATUS_BY_ERROR[code];
}
