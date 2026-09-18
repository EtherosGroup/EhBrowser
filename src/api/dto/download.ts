/** 下载任务 */
// 下载跑在服务端，浏览器只看进度；进度走 SSE 推，别轮询
import type { EpochSeconds, EntityId } from "./common.ts";

export type DownloadStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface DownloadTask {
    readonly id: EntityId;
    readonly gid: number;
    readonly token: string;
    readonly title: string;
    /** org / res / 1280 这些 */
    readonly resolution: string;
    readonly status: DownloadStatus;
    /** 0～1，不知道总量就 null */
    readonly progress: number | null;
    readonly bytesDone: number;
    readonly bytesTotal: number | null;
    /** 字节/秒，没在下就 null */
    readonly speedBps: number | null;
    /** 服务端存哪了，完成后才有 */
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
    /** true 走 H@H 下载器（hathdl_xres） */
    readonly viaHath?: boolean;
}

/** 取消/删除的返回 */
export interface CancelDownloadResult {
    readonly id: EntityId;
    readonly cancelled: boolean;
    /** 已完成的只是从列表里挪走，文件不动 */
    readonly removedFromList: boolean;
}
