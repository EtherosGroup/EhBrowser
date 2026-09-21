/*
 * 单文件下载。流式写入，边写边上报进度，支持中断，网络层失败可重试。
 * 传输层用 undici 的 fetch：Node 内置 fetch 使用另一份 undici，无法挂载本项目配置的代理。
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetch as undiciFetch, type Dispatcher } from "undici";

/** 重试之间的间隔，按次数递增 */
const RETRY_DELAY_MS = 1500;

/** HTTP 层面的失败（4xx/5xx）：重试会得到同样的结果，因此不重试 */
class DownloadHttpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DownloadHttpError";
    }
}

export interface DownloadProgress {
    readonly bytesDone: number;
    readonly bytesTotal: number | null;
}

export interface DownloadFileOptions {
    readonly url: string;
    readonly targetPath: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    /** 配置了代理时传入，未配置为 undefined 即直连 */
    readonly dispatcher?: Dispatcher;
    readonly onProgress?: (progress: DownloadProgress) => void;
    /** 进度回调的最小间隔，避免高频写库 */
    readonly progressIntervalMs?: number;
    /** 网络层失败时的尝试次数，默认 1（不重试）。图床节点失败较多，逐页下载会传 3 */
    readonly attempts?: number;
    readonly signal?: AbortSignal;
}

export interface DownloadFileResult {
    readonly bytes: number;
    readonly targetPath: string;
}

/**
 * 下载到 targetPath，先写 .part 再改名，避免半截文件被当成完整文件
 * 传入 attempts 后会在「连接失败、传输中断」这类失败上重试；HTTP 状态码不对时不重试
 */
export async function downloadFile(options: DownloadFileOptions): Promise<DownloadFileResult> {
    const attempts = Math.max(1, options.attempts ?? 1);
    let lastError: unknown = new Error("下载失败");

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await downloadOnce(options);
        } catch (error) {
            // 用户取消时不再重试；HTTP 错误重试同样没有意义
            if (options.signal?.aborted === true || error instanceof DownloadHttpError) {
                throw error;
            }
            lastError = error;
            if (attempt < attempts) {
                await delay(RETRY_DELAY_MS * attempt, options.signal);
            }
        }
    }

    throw lastError;
}

async function downloadOnce(options: DownloadFileOptions): Promise<DownloadFileResult> {
    await mkdir(dirname(options.targetPath), { recursive: true });
    const partPath = `${options.targetPath}.part`;

    // 超时与调用方的取消信号需同时生效：只传一个会使另一个失效（没有整体超时时请求会一直挂起）
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10 * 60 * 1000);
    const signal =
        options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

    let response: Response;
    try {
        response = await undiciFetch(options.url, {
            headers: options.headers,
            signal,
            dispatcher: options.dispatcher,
        });
    } catch (error) {
        // 取消与超时分开处理：原因只挂在 cause 上，不再拼进 message，
        // 外层 describeError 会把 cause 链拼成一句，拼两次会重复
        if (options.signal?.aborted === true) {
            // 取消时不必带上底层的 "This operation was aborted"，该内容对用户没有信息量
            throw new Error("下载已取消");
        }
        if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
            throw new Error("请求超时", { cause: error });
        }
        throw new Error("请求失败", { cause: error });
    }

    if (!response.ok) {
        throw new DownloadHttpError(`下载失败：HTTP ${response.status}`);
    }
    if (response.body === null) {
        throw new DownloadHttpError("下载失败：响应没有内容");
    }

    const totalHeader = response.headers.get("content-length");
    const bytesTotal = totalHeader === null ? null : Number(totalHeader);
    let bytesDone = 0;
    const interval = options.progressIntervalMs ?? 500;
    let lastReport = 0;

    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
        bytesDone += chunk.length;
        const now = Date.now();
        if (options.onProgress !== undefined && now - lastReport >= interval) {
            lastReport = now;
            options.onProgress({ bytesDone, bytesTotal });
        }
    });

    try {
        await pipeline(source, createWriteStream(partPath));
    } catch (error) {
        await rm(partPath, { force: true });
        if (options.signal?.aborted === true) {
            // 取消时不必带上底层的 "This operation was aborted"，该内容对用户没有信息量
            throw new Error("下载已取消");
        }
        throw new Error("写入失败", { cause: error });
    }

    await rm(options.targetPath, { force: true });
    await rename(partPath, options.targetPath);
    options.onProgress?.({ bytesDone, bytesTotal });

    return { bytes: bytesDone, targetPath: options.targetPath };
}

/** 重试前的等待。等待期间被取消时直接抛出，不再继续 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(new Error("下载已取消"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort(): void {
            clearTimeout(timer);
            reject(new Error("下载已取消"));
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** 目录为空时直接用文件名，否则拼成相对路径 */
export function joinIfRelative(directory: string, name: string): string {
    return directory === "" ? name : join(directory, name);
}
