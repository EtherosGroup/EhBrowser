/**
 * 上游 HTTP 传输层。负责代理、Cookie 注入、请求头、超时与请求节流
 * 仅依赖 undici 与 Node 内置模块，不引用 api / config / services
 *
 * 使用 undici 自带的 fetch 而非全局 fetch：Node 内置的是 undici 7，
 * 与本项目安装的 undici 8 之间 handler 接口不一致，外部 dispatcher 会被拒绝
 * （UND_ERR_INVALID_ARG: invalid onRequestStart method）
 *
 * ProxyAgent 只支持 HTTP/HTTPS 代理，SOCKS5 会直接报错
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

/** 上游站点，决定 Referer 与 Origin */
export type UpstreamSite = "e-hentai" | "exhentai";

const SITE_ORIGINS: Readonly<Record<UpstreamSite, string>> = {
    "e-hentai": "https://e-hentai.org",
    exhentai: "https://exhentai.org",
};

const DEFAULT_TIMEOUT_MS = 30_000;

let dispatcher: Dispatcher | null = null;
let minIntervalMs = 0;
let lastStartedAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** 设置代理，参数形如 http://127.0.0.1:7897 */
export function setProxyAgent(server: string, username?: string, password?: string): void {
    const url = new URL(server);
    if (url.protocol === "socks5:" || url.protocol === "socks:") {
        throw new Error(`ProxyAgent 不支持 SOCKS5 代理：${server}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`代理协议不支持：${url.protocol}`);
    }

    const options: { uri: string; token?: string } = {
        uri: `${url.protocol}//${url.host}`,
    };
    if (username !== undefined && username !== "") {
        const credentials = Buffer.from(`${username}:${password ?? ""}`).toString("base64");
        options.token = `Basic ${credentials}`;
    }
    dispatcher = new ProxyAgent(options);
}

/** 清除代理，恢复直连 */
export function clearProxyAgent(): void {
    dispatcher = null;
}

export function hasProxyAgent(): boolean {
    return dispatcher !== null;
}

/** 设置请求间隔（毫秒），0 表示不限制。上游建议连续 4～5 次后等待约 5 秒 */
export function setRequestInterval(ms: number): void {
    minIntervalMs = Math.max(0, ms);
}

export interface UpstreamRequest {
    readonly url: string;
    readonly method?: "GET" | "POST";
    /** 已编码的请求体 */
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** 以对象形式传入，内部拼为 Cookie 头 */
    readonly cookies?: Readonly<Record<string, string>>;
    /** Referer / Origin 的取值依据，缺省为外站 */
    readonly site?: UpstreamSite;
    readonly timeoutMs?: number;
    /** 是否跟随重定向，默认不跟随：里站未登录时会形成重定向循环 */
    readonly followRedirects?: boolean;
}

export interface UpstreamResponse {
    readonly status: number;
    /** 跟随重定向后的最终地址 */
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly text: string;
}

/** 发起一次上游请求，经串行队列与最小间隔节流 */
export async function callApi(request: UpstreamRequest): Promise<UpstreamResponse> {
    return schedule(() => send(request));
}

/** 同上，并将响应解析为 JSON */
export async function callApiJson<T>(request: UpstreamRequest): Promise<T> {
    const response = await callApi(request);
    try {
        return JSON.parse(response.text) as T;
    } catch (error) {
        throw new Error(
            `上游返回的不是 JSON（HTTP ${response.status}）：${response.text.slice(0, 200)}`,
            { cause: error },
        );
    }
}

/** 跳过空值，拼为 Cookie 头 */
export function buildCookieHeader(cookies: Readonly<Record<string, string>>): string {
    return Object.entries(cookies)
        .filter(([, value]) => value !== "")
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
}

/** 里站未登录时返回 302 指向 remoteapi，继续跟随会形成重定向循环 */
export function isExAccessDenied(response: UpstreamResponse): boolean {
    const location = response.headers["location"] ?? "";
    if (response.status >= 300 && response.status < 400) {
        return location.includes("remoteapi.php") || location.includes("?poni=no");
    }
    return response.url.includes("?poni=no");
}

async function send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const site = request.site ?? "e-hentai";
    const headers: Record<string, string> = {
        referer: `${SITE_ORIGINS[site]}/`,
        origin: SITE_ORIGINS[site],
        ...request.headers,
    };
    if (request.cookies !== undefined) {
        headers["cookie"] = buildCookieHeader(request.cookies);
    }
    if (request.body !== undefined && headers["content-type"] === undefined) {
        headers["content-type"] = "application/json";
    }

    const response = await undiciFetch(request.url, {
        method: request.method ?? "GET",
        headers,
        body: request.body,
        redirect: request.followRedirects === true ? "follow" : "manual",
        signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        dispatcher: dispatcher ?? undefined,
    });

    return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers),
        text: await response.text(),
    };
}

/** 串行队列 + 最小间隔，避免触发上游限流 */
function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
        const wait = minIntervalMs - (Date.now() - lastStartedAt);
        if (wait > 0) {
            await sleep(wait);
        }
        lastStartedAt = Date.now();
        return task();
    };
    const next = queue.then(run, run);
    queue = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
