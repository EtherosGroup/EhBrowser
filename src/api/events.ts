/*
 * 服务端到浏览器的事件推送（SSE）
 * 配置变更、账号切换、下载进度均产生于服务端，浏览器可能同时开启多个页面；
 * 由服务端广播替代各页面轮询。事件名与负载类型一一对应，两端共用同一张表
 */

import type {
    AuthStatus,
    ConfigSnapshot,
    DownloadTask,
    EpochSeconds,
    SystemStatusState,
    UpdateEntry,
} from "./dto/index.ts";

export const API_EVENT_NAMES = [
    "server.ready",
    "system.status",
    "config.changed",
    "auth.changed",
    "download.changed",
    "library.update",
    "library.progress",
    "log.appended",
] as const;

export type ApiEventName = (typeof API_EVENT_NAMES)[number];

export interface ApiEventPayloads {
    readonly "server.ready": {
        readonly version: string;
        readonly startedAt: EpochSeconds;
    };
    /** 客户端状态提示。状态项集合有变化时才推，界面据此显示右上角那组图标 */
    readonly "system.status": SystemStatusState;
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
    /** 每查完一个本地画廊推送一条，界面随查随显示 */
    readonly "library.update": UpdateEntry;
    /**
     * 检查的进度：还剩几条未查、是否仍在检查
     * 该信息无法只靠 library.update 表达：查完最后一条时队列已经为空，
     * 但那一轮循环尚未结束，界面需要等这条事件到达才知道检查已结束
     */
    readonly "library.progress": {
        readonly checking: boolean;
        /** 仍在排队、尚未检查的条数 */
        readonly pending: number;
    };
    readonly "log.appended": {
        readonly level: "info" | "warn" | "error";
        /** 来源，如 upstream / download；入口自身的消息为空 */
        readonly tag: string;
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
