/**
 * 服务端到浏览器的事件推送（SSE）
 * 配置变更、账号切换、下载进度均产生于服务端，浏览器可能同时开启多个页面；
 * 由服务端广播替代各页面轮询。事件名与负载类型一一对应，两端共用同一张表
 */

import type { AuthStatus, ConfigSnapshot, DownloadTask, EpochSeconds } from "./dto/index.ts";

export const API_EVENT_NAMES = [
    "server.ready",
    "config.changed",
    "auth.changed",
    "download.changed",
    "log.appended",
] as const;

export type ApiEventName = (typeof API_EVENT_NAMES)[number];

export interface ApiEventPayloads {
    readonly "server.ready": {
        readonly version: string;
        readonly startedAt: EpochSeconds;
    };
    readonly "config.changed": {
        /** 附带新快照，省去一次 GET */
        readonly snapshot: ConfigSnapshot;
    };
    readonly "auth.changed": {
        readonly status: AuthStatus;
    };
    readonly "download.changed": {
        readonly task: DownloadTask;
    };
    readonly "log.appended": {
        readonly level: "info" | "warn" | "error";
        readonly message: string;
        readonly at: EpochSeconds;
    };
}

export interface ApiEvent<K extends ApiEventName = ApiEventName> {
    readonly event: K;
    readonly data: ApiEventPayloads[K];
    readonly id?: string;
}

/** 心跳间隔；长时间无事件时保活，避免浏览器断开连接 */
export const API_EVENT_HEARTBEAT_MS = 15000;

/** 校验事件名；名称错误时浏览器无法接收 */
export function isApiEventName(value: string): value is ApiEventName {
    return (API_EVENT_NAMES as readonly string[]).includes(value);
}
