/*
 * 下载任务的界面侧状态。模块级单例，导航栏的徽标与下载页共用同一份。
 * 数据来自 downloads.list，download.changed 事件到达时由 status 重新获取。
 */

import { computed, ref } from "vue";

import type { DownloadTask } from "../../src/api/index.ts";
import { request } from "./api.ts";

/** 最近一次取到的任务列表，最新在上 */
export const tasks = ref<DownloadTask[]>([]);

/** 未结束的任务：排队中与进行中 */
export const activeTasks = computed(() =>
    tasks.value.filter((task) => task.status === "queued" || task.status === "running"),
);

/** 徽标数量：未结束的任务数 */
export const activeCount = computed(() => activeTasks.value.length);

/** 重新获取任务列表。静默失败：导航栏不应因为一次获取失败就报错，下载页会自行提示 */
export async function refreshDownloads(): Promise<void> {
    try {
        tasks.value = [...(await request("downloads.list"))];
    } catch {
        // 服务刚启动或已关闭时获取失败属于常见情况
    }
}
