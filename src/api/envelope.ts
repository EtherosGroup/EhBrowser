// 响应信封
// 不用裸数据 + HTTP 状态码的原因：浏览器判一次 ok 就够，错误全看 error.code，
// 校验错误还能带着 issues 回去直接标到输入框。状态码照样设，看日志方便

import type { FieldIssue } from "./dto/common.ts";

/** 就这几个 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 错误码。加了记得往 HTTP_STATUS_BY_ERROR 里补一条 */
export type ApiErrorCode =
    /** 参数或 body 不对，issues 里写了是哪个字段 */
    | "bad_request"
    /** 本地令牌不对 */
    | "unauthorized"
    /** Origin 不对，或者这事得先登录 */
    | "forbidden"
    | "not_found"
    /** 状态不对，比如账号重名、任务早结束了 */
    | "conflict"
    /** 配置值不合法，issues 直接标输入框 */
    | "config_invalid"
    /** 还没登录 */
    | "not_logged_in"
    /** 被上游限流了 */
    | "rate_limited"
    /** 上游连不上或者超时。没配代理的话基本就是这个 */
    | "upstream_unavailable"
    /** 服务端在忙，比如正在导配置 */
    | "busy"
    | "internal";

/** 错误码对 HTTP 状态码 */
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
    internal: 500,
};

export interface ApiError {
    readonly code: ApiErrorCode;
    readonly message: string;
    /** 只有 bad_request / config_invalid 才有 */
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

/** 拼个成功信封 */
export function ok<T>(data: T, requestId?: string): ApiSuccess<T> {
    return requestId === undefined ? { ok: true, data } : { ok: true, data, requestId };
}

/** 拼个失败信封 */
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

/** 浏览器侧写 if (isApiFailure(res)) 就能收窄 */
export function isApiFailure<T>(response: ApiResponse<T>): response is ApiFailure {
    return !response.ok;
}

/** 查状态码 */
export function statusForError(code: ApiErrorCode): number {
    return HTTP_STATUS_BY_ERROR[code];
}
