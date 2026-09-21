/*
 * 日志
 * 各服务通过这里输出：既按原来的格式打到控制台，也按天追加到日志目录下的文件，
 * 还会经 SSE 的 log.appended 推给界面，服务页能直接看到。
 * 目录默认 ~/ehbrowser/logs（便携模式落在 <数据目录>/logs），可在设置 > 日志里改；
 * 每次写入都重新解析目录，因此改完立即生效，不必重启。
 * 写文件是排队异步做的，失败不影响调用方；落盘格式为
 * 「2026-09-21 00:35:12 [info] [download] 消息」，一行一条，同一天共用一个文件。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import type { LogEntry, LogLevel, LogState } from "../api/index.ts";
import type { ConfigContext } from "../config/index.ts";

/** 内存里保留的条数。界面初次打开时先铺一份，够用即可 */
const RECENT_LIMIT = 500;
const FILE_PREFIX = "ehbrowser";
const FILE_SUFFIX = ".log";

export interface LogService {
    /** 某一路来源的 logger，交给各服务的 logger 选项 */
    logger(tag: string): (level: LogLevel, message: string) => void;
    /** 记一条。tag 为空时控制台不打来源前缀 */
    append(level: LogLevel, message: string, tag?: string): void;
    /** 状态与最近若干条 */
    state(limit?: number): LogState;
    /** 新日志的回调，接 SSE 广播 */
    onChange(listener: (entry: LogEntry) => void): () => void;
    /** 等待已排队的写入落盘，退出前调用 */
    flush(): Promise<void>;
}

export interface LogServiceOptions {
    /** 未配置目录时的落点 */
    readonly fallbackDirectory: (ctx: ConfigContext) => string;
}

/** 默认日志目录：便携模式跟着数据目录走，否则就是 ~/ehbrowser/logs */
export function defaultLogDirectory(ctx: ConfigContext): string {
    if (ctx.paths.sources.dataDir === "portable-home") {
        return join(ctx.paths.dataDir, "logs");
    }
    return join(homedir(), "ehbrowser", "logs");
}

/** 展开 ~ 与 ~/…，相对路径按当前工作目录补全 */
function absolute(input: string): string {
    const trimmed = input.trim();
    const expanded =
        trimmed === "~"
            ? homedir()
            : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
              ? join(homedir(), trimmed.slice(2))
              : trimmed;
    return normalize(isAbsolute(expanded) ? expanded : join(process.cwd(), expanded));
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** 本地时间的 YYYY-MM-DD，用作文件名 */
function dayOf(at: number): string {
    const value = new Date(at * 1000);
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** 本地时间的 YYYY-MM-DD HH:mm:ss，用作行首时间戳 */
function stampOf(at: number): string {
    const value = new Date(at * 1000);
    return `${dayOf(at)} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function lineOf(entry: LogEntry): string {
    const tag = entry.tag === "" ? "" : ` [${entry.tag}]`;
    return `${stampOf(entry.at)} [${entry.level}]${tag} ${entry.message}\n`;
}

/** 控制台输出的格式：与文件里的区别是省去日期，来源前缀与原来的写法一致 */
function consoleOf(entry: LogEntry, keepLevel: boolean): string {
    const tag = entry.tag === "" ? "" : `[${entry.tag}] `;
    return keepLevel ? `${tag}${entry.level}: ${entry.message}` : entry.message;
}

export function createLogService(ctx: ConfigContext, options: LogServiceOptions): LogService {
    const listeners = new Set<(entry: LogEntry) => void>();
    /** 环形缓冲，新的在后 */
    const recent: LogEntry[] = [];
    /** 写文件的串行队列：不 await，但保证顺序，退出时 flush 等它 */
    let queue: Promise<void> = Promise.resolve();
    /** 目录创建失败等只报一次，避免日志重复输出 */
    let reported = false;

    function defaultDirectory(): string {
        return options.fallbackDirectory(ctx);
    }

    function directoryOf(): string {
        const configured = ctx.user.get().log.directory;
        return configured.trim() === "" ? defaultDirectory() : absolute(configured);
    }

    function fileOf(at: number): string {
        return join(directoryOf(), `${FILE_PREFIX}-${dayOf(at)}${FILE_SUFFIX}`);
    }

    /** 落盘。失败只报一次，日志写入失败不影响服务运行 */
    function write(entry: LogEntry): void {
        if (!ctx.user.get().log.enabled) {
            return;
        }
        const path = fileOf(entry.at);
        const text = lineOf(entry);
        queue = queue
            .then(async () => {
                await mkdir(directoryOf(), { recursive: true });
                await appendFile(path, text, "utf8");
            })
            .catch((error: unknown) => {
                if (!reported) {
                    reported = true;
                    console.error(
                        `[log] error: 日志写入失败（${directoryOf()}）：${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            });
    }

    /** 记一条 */
    function append(level: LogLevel, message: string, tag = ""): void {
        const entry: LogEntry = { level, tag, message, at: Math.floor(Date.now() / 1000) };
        recent.push(entry);
        if (recent.length > RECENT_LIMIT) {
            recent.splice(0, recent.length - RECENT_LIMIT);
        }
        // tag 为空的是入口自己的消息（启动横幅之类），控制台上保持原样不加级别前缀
        console.log(consoleOf(entry, tag !== ""));
        write(entry);
        for (const listener of listeners) {
            try {
                listener(entry);
            } catch {
                // 单个订阅者异常不影响其余订阅者
            }
        }
    }

    return {
        logger(tag) {
            return (level, message) => {
                append(level, message, tag);
            };
        },

        append,

        state(limit) {
            const count = limit === undefined || limit <= 0 ? 100 : Math.min(limit, RECENT_LIMIT);
            return {
                enabled: ctx.user.get().log.enabled,
                directory: directoryOf(),
                file: `${FILE_PREFIX}-${dayOf(Math.floor(Date.now() / 1000))}${FILE_SUFFIX}`,
                defaultDirectory: defaultDirectory(),
                entries: recent.slice(-count),
            };
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        async flush() {
            await queue;
        },
    };
}
