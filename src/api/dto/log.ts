/*
 * 日志的线上结构。
 * 服务端把每一路服务的消息同时写进日志文件并经 SSE 推给界面，界面只读最近若干条。
 */

import type { EpochSeconds } from "./common.ts";

export type LogLevel = "info" | "warn" | "error";

/** 一条日志 */
export interface LogEntry {
    readonly level: LogLevel;
    /** 来源，如 upstream / download。入口自身不带来源。 */
    readonly tag: string;
    readonly message: string;
    readonly at: EpochSeconds;
}

/** 日志的状态与最近若干条，界面初次打开时先铺一份 */
export interface LogState {
    /** 是否写入文件。关闭时只有控制台与界面可见。 */
    readonly enabled: boolean;
    /** 生效的日志目录，设置里为空时是默认目录。 */
    readonly directory: string;
    /** 今天写入的文件名 */
    readonly file: string;
    /** 默认目录，设置里留空时使用 */
    readonly defaultDirectory: string;
    /** 最近若干条，新的在后。 */
    readonly entries: readonly LogEntry[];
}
