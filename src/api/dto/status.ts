/*
 * 客户端状态提示的线上结构。
 *
 * 服务端在本地采样（内存、磁盘、上游耗时、并发连接、未捕获的异常……），
 * 把「当前处于异常状态的那些项」推给界面，由界面在右上角用小图标覆盖展示。
 * 图标是状态（持续期间一直在），messenger 的提示是提醒（出错那一刻弹一次），两者不互相替代。
 */

import type { EpochSeconds } from "./common.ts";

/** 状态项。名字与右上角那组图标一一对应 */
export const STATUS_FLAGS = [
    /** 内部错误：未捕获的异常、未处理的 Promise 拒绝，需要去终端看堆栈 */
    "internal-error",
    /** 文件系统异常：读写报错（权限、只读挂载、介质错误、空间不足……） */
    "fs-anomaly",
    /** 可用运行内存不足 */
    "low-memory",
    /** 磁盘繁忙：读写响应明显变慢 */
    "disk-busy",
    /** 与上游站点的通信变慢（代理/节点慢、被限流） */
    "upstream-slow",
    /** 浏览器与本机服务之间的往返变慢 */
    "latency",
    /** 客户端繁忙：同时连上来的页面过多 */
    "congestion",
] as const;

export type SystemStatusFlag = (typeof STATUS_FLAGS)[number];

/** 采样到的原始数值。界面只用来写悬浮说明，服务面板与排查时看它 */
export interface SystemStatusMetrics {
    /** 当前挂着的 SSE 连接数，约等于打开的页面数 */
    readonly connections: number;
    /** 正在处理中的请求数 */
    readonly inflight: number;
    /** 最近几次上游请求的平均耗时（毫秒）；还没有数据时为 null */
    readonly upstreamMs: number | null;
    /** 上一次文件系统探测的耗时（毫秒）；还没测过时为 null */
    readonly diskMs: number | null;
    /** 系统可用内存（MB） */
    readonly freeMemoryMb: number;
    /** 系统总内存（MB） */
    readonly totalMemoryMb: number;
    /** 进程堆已用（MB） */
    readonly heapUsedMb: number;
    /** 进程堆上限（MB） */
    readonly heapLimitMb: number;
    /** 进程运行以来累计观察到的文件系统错误次数 */
    readonly fsErrors: number;
    /** 进程运行以来累计观察到的内部错误次数 */
    readonly internalErrors: number;
}

/**
 * 调试用的状态注入。只给 /debug 页面用。
 * flag 为具体项时按 forced 点亮/熄灭它；为 "all" 时清掉全部强制项；为 null 时只读不改。
 */
export interface DebugStatusInput {
    readonly flag: SystemStatusFlag | "all" | null;
    readonly forced: boolean;
}

/** 调试注入的结果：注入后的状态，以及当前被强制的那几项 */
export interface DebugStatusResult {
    readonly state: SystemStatusState;
    readonly forced: readonly SystemStatusFlag[];
}

/** 当前状态。active 按严重程度排序，界面按这个顺序摆图标 */
export interface SystemStatusState {
    readonly active: readonly SystemStatusFlag[];
    readonly metrics: SystemStatusMetrics;
    readonly sampledAt: EpochSeconds;
}
