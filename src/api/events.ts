// 服务端往浏览器推的事件（SSE）
// 配置改了、账号换了、下载动了都在服务端发生，浏览器还可能开着好几个标签页，
// 与其让每个页面轮询，不如服务端直接广播
// 事件名和负载一一对应，广播端和监听端共用这张表，省得字符串写错

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
        /** 顺手把新快照带上，省一次 GET */
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

/** 长时间没事件就发个心跳，不然浏览器会把连接判死 */
export const API_EVENT_HEARTBEAT_MS = 15000;

/** 广播前过一遍，名字写错了浏览器是收不到的 */
export function isApiEventName(value: string): value is ApiEventName {
    return (API_EVENT_NAMES as readonly string[]).includes(value);
}
