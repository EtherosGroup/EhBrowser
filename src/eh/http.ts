/*
 * 上游 HTTP 传输层。负责代理、Cookie 注入、请求头、超时与请求节流。
 * 仅依赖 undici 与 Node 内置模块，不引用 api / config / services。
 *
 * 使用 undici 自带的 fetch 而非全局 fetch：Node 内置的是 undici 7，
 * 与本项目安装的 undici 8 之间 handler 接口不一致，外部 dispatcher 会被拒绝
 * （UND_ERR_INVALID_ARG: invalid onRequestStart method）。
 *
 * ProxyAgent 只支持 HTTP/HTTPS 代理，SOCKS5 会直接报错。
 */

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import { errorCode } from "../platform/errors.ts";

/** 上游站点，决定 Referer 与 Origin */
export type UpstreamSite = "e-hentai" | "exhentai";

const SITE_ORIGINS: Readonly<Record<UpstreamSite, string>> = {
    "e-hentai": "https://e-hentai.org",
    exhentai: "https://exhentai.org",
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** 连发上限的兜底值：与配置默认值一致，配置未下发时也按「连发 5 次再等」处理 */
const DEFAULT_BURST_LIMIT = 5;

let dispatcher: Dispatcher | null = null;
let minIntervalMs = 0;
/** 一批里最多连发几次；发满后等待 minIntervalMs 再开始下一批 */
let burstLimit = DEFAULT_BURST_LIMIT;
/** 当前这一批已经发了几次 */
let sentInBurst = 0;
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

/** 当前代理通道；未配置代理为 null。归档下载与本模块共用同一条通道 */
export function getDispatcher(): Dispatcher | null {
    return dispatcher;
}

export function hasProxyAgent(): boolean {
    return dispatcher !== null;
}

/**
 * 设置限流：连续 burst 次请求之后等 intervalMs 再继续，0 间隔表示不限制
 * 上游建议连续 4～5 次后等待约 5 秒，因此这里限制的是一批之后的那次等待，
 * 而不是每次请求之间都等。每次请求之间都等时，一次操作要发好几条请求（详情要 gdata + 画廊页），
 * 多开几个页面就会排成长队
 */
export function setRequestInterval(ms: number, burst = DEFAULT_BURST_LIMIT): void {
    minIntervalMs = Math.max(0, ms);
    burstLimit = Math.max(1, Math.trunc(burst));
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
    /** 调用方的取消信号，与超时信号合取：任一触发即中断 */
    readonly signal?: AbortSignal;
    /** 是否跟随重定向，默认不跟随：里站未登录时会形成重定向循环 */
    readonly followRedirects?: boolean;
}

export interface UpstreamResponse {
    readonly status: number;
    /** 跟随重定向后的最终地址 */
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    /** 逐条保留 Set-Cookie：合并成一个字符串后无法再拆开 */
    readonly setCookie: readonly string[];
    readonly text: string;
}

/**
 * 上游请求耗时的观察者。诊断服务用它判断「与上游站点的通信是不是变慢了」。
 * 在 eh 层放一个观察者而不是把诊断服务层层传进来：callApi 的调用方散布在画廊、账号、收藏等处。
 * 传 null 取消观察。
 */
let durationObserver: ((durationMs: number) => void) | null = null;

export function observeRequestDuration(listener: ((durationMs: number) => void) | null): void {
    durationObserver = listener;
}

/** 发起一次上游请求，经串行队列与最小间隔节流 */
export async function callApi(request: UpstreamRequest): Promise<UpstreamResponse> {
    // 只计真实请求的耗时，不含排队等节流的时间：节流是本地主动限速，不算上游慢
    return schedule(async () => {
        const started = performance.now();
        try {
            return await send(request);
        } finally {
            durationObserver?.(performance.now() - started);
        }
    });
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

/** 需要登录的页面（归档、种子直链等）未登录时 302 到登录页，正文亦为登录表单 */
export function isLoginRequired(response: UpstreamResponse): boolean {
    const location = response.headers["location"] ?? "";
    if (response.status >= 300 && response.status < 400) {
        return /login|bounce/i.test(location);
    }
    return /<title>[^<]*Login/i.test(response.text.slice(0, 2048));
}

/** 登录态不足导致的失败。服务端据此回 401 语义，而非上游不可达 */
export class LoginRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LoginRequiredError";
    }
}

/**
 * 连接阶段失败的重试次数
 * 代理节点不稳时常见「TCP 已连接、TLS 握手被重置」，这类失败意味着请求没有送达上游，
 * 重发是安全的；收到响应之后再出错则不在这里重试
 */
const CONNECT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;

/** 只认「连接未建立」这类失败：域名解析、连接被拒、握手被重置、socket 被关闭 */
function isConnectFailure(error: unknown): boolean {
    const code = errorCode(error);
    if (
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        code === "EPIPE" ||
        code === "UND_ERR_SOCKET"
    ) {
        return true;
    }
    const message = error instanceof Error ? error.message : "";
    return /disconnected before secure TLS|socket hang up|other side closed/i.test(message);
}

/** 建连失败时重试；其余错误直接抛出 */
async function connect(
    url: string,
    init: Parameters<typeof undiciFetch>[1],
    signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    let lastError: unknown = new Error("请求失败");
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
        try {
            return await undiciFetch(url, init);
        } catch (error) {
            lastError = error;
            if (signal?.aborted === true || !isConnectFailure(error)) {
                throw error;
            }
            if (attempt < CONNECT_ATTEMPTS) {
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }
    }
    throw lastError;
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

    const response = await connect(
        request.url,
        {
            method: request.method ?? "GET",
            headers,
            body: request.body,
            redirect: request.followRedirects === true ? "follow" : "manual",
            signal: combineSignals(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            dispatcher: dispatcher ?? undefined,
        },
        request.signal,
    );

    return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers),
        setCookie: response.headers.getSetCookie(),
        text: await response.text(),
    };
}

/** 取消信号与超时信号合取。无取消信号时只保留超时 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (signal === undefined) {
        return timeout;
    }
    return AbortSignal.any([signal, timeout]);
}

/**
 * 串行队列与连发上限。上游的限流建议是「连续 4～5 次后等待约 5 秒」，
 * 因此不是每次请求之间都等一个间隔：先连发最多 maxSequentialRequests 次，发完这批再等 requestIntervalMs。
 * 等待从「上一批最后一次开始」算起，队列空闲一段时间之后自然不再等待
 */
function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
        if (sentInBurst >= burstLimit) {
            const wait = minIntervalMs - (Date.now() - lastStartedAt);
            if (wait > 0) {
                await sleep(wait);
            }
            sentInBurst = 0;
        }
        lastStartedAt = Date.now();
        sentInBurst += 1;
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
