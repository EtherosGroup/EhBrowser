<script setup lang="ts">
/*
 * 下载页。按规格布局：每行是「封面 + 名称 + 进度条 + 百分比 + 速度 + 取消」
 * 左下角一个设置按钮，跳到设置页的「下载」分组
 * 任务列表与导航栏徽标共用 downloads.ts 里那份单例，事件到达由 status 统一刷新
 */

import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";

import type { DownloadTask, LocalGallery } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { refreshDownloads, tasks } from "../downloads.ts";
import { messenger } from "../messenger.ts";
import SkeletonImage from "./SkeletonImage.vue";

const busy = ref(false);
/** 本地库快照：任务完成后用于显示封面 */
const covers = ref<ReadonlyMap<number, LocalGallery>>(new Map());

const active = computed(() =>
    tasks.value.filter((task) => task.status === "queued" || task.status === "running"),
);
const finished = computed(() =>
    tasks.value.filter((task) => task.status !== "queued" && task.status !== "running"),
);

async function load(): Promise<void> {
    await refreshDownloads();
    try {
        const list = await request("library.list");
        covers.value = new Map(list.map((item) => [item.gid, item]));
    } catch {
        // 未取到封面不影响任务列表
    }
}

/** 失败或取消的任务重新排队。服务端复用同一行记录，历史中不会多出一条 */
async function retry(task: DownloadTask): Promise<void> {
    busy.value = true;
    try {
        await request("downloads.retry", { params: { taskId: task.id } });
        await load();
        messenger.info("已重新排队");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

async function cancel(task: DownloadTask): Promise<void> {
    busy.value = true;
    try {
        await request("downloads.cancel", { params: { taskId: task.id } });
        await load();
        messenger.info("任务已取消");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/** 百分比：总量未知时显示已下载的字节数 */
function percent(task: DownloadTask): string {
    if (task.progress === null) {
        return size(task.bytesDone);
    }
    return `${(task.progress * 100).toFixed(1)}%`;
}

function size(bytes: number | null): string {
    if (bytes === null) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function speed(task: DownloadTask): string {
    return task.speedBps === null ? "" : `${size(task.speedBps)}/s`;
}

function coverOf(task: DownloadTask): string {
    return covers.value.get(task.gid)?.summary?.thumbUrl ?? "";
}

function ratioOf(task: DownloadTask): number {
    return task.progress === null ? 0 : Math.max(0, Math.min(1, task.progress));
}

function stateText(task: DownloadTask): string {
    switch (task.status) {
        case "queued":
            return "排队中";
        case "running":
            return "下载中";
        case "completed":
            return "已完成";
        case "cancelled":
            return "已取消";
        default:
            return "失败";
    }
}

onMounted(() => {
    void load();
});
</script>

<template>
    <section class="panel page">
        <header class="head">
            <h2>
                下载<span v-if="active.length > 0" class="muted">
                    · {{ active.length }} 个进行中</span
                >
            </h2>
            <button class="plain" :disabled="busy" @click="load">刷新</button>
        </header>

        <p v-if="tasks.length === 0" class="muted">
            暂无任务。可在画廊详情页或播放器里点下载，落盘后本地画廊里就能看到。
        </p>

        <ul v-else class="rows">
            <li v-for="task in [...active, ...finished]" :key="task.id" class="row">
                <SkeletonImage
                    class="cover"
                    :src="coverOf(task)"
                    :alt="task.title || `#${task.gid}`"
                    ratio="2 / 3"
                />

                <div class="main">
                    <div class="line">
                        <span class="name">{{ task.title || `#${task.gid}` }}</span>
                        <span class="muted tag">{{ task.resolution }} · {{ stateText(task) }}</span>
                    </div>

                    <div class="bar-row">
                        <div
                            class="bar"
                            role="progressbar"
                            :aria-valuenow="Math.round(ratioOf(task) * 100)"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            :aria-label="`${task.title || task.gid} 下载进度`"
                        >
                            <i :style="{ width: `${ratioOf(task) * 100}%` }" />
                        </div>
                        <span class="pct">
                            <template v-if="task.pageCount !== null">
                                第 {{ task.pagesDone }}/{{ task.pageCount }} 页
                            </template>
                            <template v-else>{{ percent(task) }}</template>
                        </span>
                        <span class="speed muted">{{ speed(task) }}</span>
                        <button
                            v-if="task.status === 'queued' || task.status === 'running'"
                            :disabled="busy"
                            @click="cancel(task)"
                        >
                            取消
                        </button>
                        <template v-else>
                            <button
                                v-if="task.status === 'failed' || task.status === 'cancelled'"
                                :disabled="busy"
                                title="重新排队，复用同一条任务"
                                @click="retry(task)"
                            >
                                重试
                            </button>
                            <button :disabled="busy" @click="cancel(task)">移除</button>
                        </template>
                    </div>

                    <p v-if="task.error" class="err">{{ task.error }}</p>
                </div>
            </li>
        </ul>

        <!-- 左下角的设置入口：直接跳到设置页的「下载」分组 -->
        <RouterLink class="settings" :to="{ path: '/config', query: { module: 'download' } }">
            <i class="iconfont icon-setting" aria-hidden="true" />
            下载设置
        </RouterLink>
    </section>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    color: var(--accent);
}

.plain {
    background: none;
    border-color: transparent;
    color: var(--muted);
}

.rows {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.row {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 12px;
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.cover {
    width: 64px;
    height: 86px;
    border-radius: 4px;
    --skeleton-fit: cover;
}

.main {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
}

.name {
    color: var(--text);
    font-size: var(--font-size-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tag {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
}

/* 进度条 + 百分比 + 速度 + 取消 */
.bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

.bar {
    position: relative;
    flex: 1;
    height: 8px;
    background: var(--placeholder-track);
    border-radius: 4px;
    overflow: hidden;
}

.bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 240ms ease-out;
}

.pct {
    min-width: 96px;
    text-align: right;
    font-size: var(--font-size-md);
    font-variant-numeric: tabular-nums;
}

.speed {
    min-width: 92px;
    text-align: right;
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
}

.err {
    margin: 0;
    font-size: var(--font-size-sm);
}

/* 固定左下角 */
.settings {
    position: fixed;
    left: 16px;
    bottom: 18px;
    z-index: var(--z-floating);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: var(--text);
    font-size: var(--font-size-md);
    text-decoration: none;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
    backdrop-filter: blur(4px);
}

.settings:hover {
    border-color: var(--accent);
    color: var(--accent);
}

/* 图标字体。大小与原来的 SVG 相当，颜色跟随按钮（hover 时一起变主色） */
.settings .iconfont {
    font-size: var(--font-size-lg);
}

@media (prefers-reduced-motion: reduce) {
    .bar i {
        transition: none;
    }
}
</style>
