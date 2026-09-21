/*
 * 下载任务。
 * 下载在服务端执行，浏览器仅观察进度。进度经 SSE 推送，不做轮询。
 */

import type { EpochSeconds, EntityId } from "./common.ts";

export type DownloadStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface DownloadTask {
    readonly id: EntityId;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    /** org / res / 1280 等 */
    readonly resolution: string;
    readonly status: DownloadStatus;
    /** 0～1；总量未知时为 null */
    readonly progress: number | null;
    readonly bytesDone: number;
    readonly bytesTotal: number | null;
    /** 字节/秒；未下载时为 null */
    readonly speedBps: number | null;
    /** 逐页下载（resolution 形如 pages-org）时已完成页数；归档任务为 0 */
    readonly pagesDone: number;
    /** 逐页下载的总页数；归档任务为 null */
    readonly pageCount: number | null;
    /** 服务端输出路径，完成后提供 */
    readonly outputPath: string | null;
    readonly error: string | null;
    readonly createdAt: EpochSeconds;
    readonly updatedAt: EpochSeconds;
}

/** 新建下载任务 */
export interface EnqueueDownloadInput {
    readonly gid: number;
    readonly token: string;
    readonly resolution: string;
    /** true 表示经 H@H 下载器（hathdl_xres） */
    readonly viaHath?: boolean;
}

/** 取消或移出的结果 */
export interface CancelDownloadResult {
    readonly id: EntityId;
    readonly cancelled: boolean;
    /** 已完成的任务仅移出列表，文件保留 */
    readonly removedFromList: boolean;
}
