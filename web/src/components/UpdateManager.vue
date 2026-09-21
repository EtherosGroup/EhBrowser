<script setup lang="ts">
/**
 * 更新管理器。悬浮层，不是独立页面。两种用法共用一套界面与检查逻辑：
 * - download：本地画廊是否有更新版本，动作是「更新」（把新版本加入下载队列）
 * - favorite：收藏的标记号是否需要挪到新版本，动作是「更新标记号」
 *
 * 按规格：只有右上角 X 能关闭，点击空白处无效；内容全局共享，且只存在于本次运行期内。
 * 检查为异步逐条进行（上游限流严格），查到一个就显示一个；打开时不自动检查，有缓存就显示缓存。
 */

import { computed, onUnmounted, ref, watch } from "vue";

import type { UpdateCheckTarget, UpdateEntry } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { refreshDownloads, tasks } from "../downloads.ts";
import { messenger } from "../messenger.ts";
import SkeletonImage from "./SkeletonImage.vue";
import {
    forgetUpdate,
    loadUpdates,
    startUpdateCheck,
    updateChecking,
    updateEntries,
    updatePending,
    upgradeEntry,
} from "../updater.ts";

const props = defineProps<{
    open: boolean;
    /** 检查哪一类，默认是本地画廊的更新 */
    mode?: "download" | "favorite";
    /** 收藏条目定位：mode 为 favorite 时执行「更新标记号」要用 */
    folderId?: string;
    /** 打开时要先检查的项（本地画廊多选后点更新会传进来） */
    pendingKeys?: readonly string[];
    /** 收藏页把收藏条目转成检查目标传进来，与 pendingKeys 二选一 */
    targets?: readonly UpdateCheckTarget[];
}>();

const emit = defineEmits<{ "update:open": [boolean]; moved: [] }>();

const isFavorite = computed(() => props.mode === "favorite");
/** 标题与无障碍名随用法变 */
const head = computed(() => (isFavorite.value ? "更新标记号" : "更新管理器"));
const busy = ref(false);
/**
 * 收藏侧的检查目标。footer 的「检查标记号*」再次检查时使用的就是这一份：
 * 收藏没有「全部」这个范围（服务端不传 targets 即查本地画廊），
 * 挪过一条之后就地把目标换成新版本，避免再次检查时查到已经不在收藏夹里的旧版本。
 */
const targets = ref<readonly UpdateCheckTarget[]>([]);
/** 本次已经点过更新的项，按钮据此变成「已加入」 */
const queued = ref<Set<string>>(new Set());
/** 本次已经挪过标记号的项，按钮据此变成「已更新」 */
const moved = ref<Set<string>>(new Set());

/**
 * 面板上显示的条目：按来源分开，两类检查共用一份缓存，各页只看自己那一类。
 * 已经在下载的条目隐去，对应规格中「点击更新后清空内容并且配置下载任务」：
 * 条目已经变成下载任务，不应再留在待更新列表里；任务取消后重新出现，因为此时它确实尚未更新。
 */
const entries = computed(() => {
    const source = isFavorite.value ? "favorites" : "library";
    const downloading = new Set(
        tasks.value
            .filter((task) => task.status === "queued" || task.status === "running")
            .map((task) => task.gid),
    );
    return updateEntries.value.filter((entry) => {
        if (entry.source !== source) {
            return false;
        }
        if (isFavorite.value) {
            // 收藏侧挪完仍留在列表里，只是按钮变成「已更新」，便于看出已执行过哪些操作
            return true;
        }
        return entry.latest === null || !downloading.has(entry.latest.gid);
    });
});

/** 还可以执行更新的条数 */
const upgradeable = computed(() =>
    entries.value.filter((entry) => entry.latest !== null && !moved.value.has(entry.key)),
);
const upgradeableCount = computed(() => upgradeable.value.length);

/** 检查按钮的字样按规格在两种状态间切换 */
const checkLabel = computed(() => {
    const verb = isFavorite.value ? "标记号" : "画廊更新";
    if (updateChecking.value) {
        return `正在检查可用${verb}${updatePending.value > 0 ? `（还剩 ${updatePending.value}）` : ""}`;
    }
    return isFavorite.value ? "检查标记号*" : "检查更新*";
});

function close(): void {
    emit("update:open", false);
}

function percentOf(entry: UpdateEntry): string {
    if (entry.localPageCount === 0) {
        return "—";
    }
    return isFavorite.value
        ? `${entry.localPageCount} 页`
        : `${entry.resolution} · ${entry.localPageCount} 页`;
}

function date(seconds: number): string {
    if (seconds <= 0) {
        return "—";
    }
    const value = new Date(seconds * 1000);
    return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

async function check(keys?: readonly string[]): Promise<void> {
    /*
     * 收藏侧必须带着目标查询：服务端不传 targets 就退回「查全部本地画廊」，
     * 此时点「检查标记号*」会变成查本地画廊，这条面板什么也显示不出来。
     */
    if (isFavorite.value) {
        if (targets.value.length === 0) {
            messenger.info("没有要检查的收藏项：请在收藏页选中画廊后再更新标记号");
            return;
        }
        await startUpdateCheck({ targets: targets.value, reset: true });
        return;
    }
    await startUpdateCheck({ keys, reset: true });
}

/** 更新一条：加入下载队列 */
async function upgrade(entry: UpdateEntry): Promise<void> {
    if (entry.latest === null) {
        return;
    }
    if (await upgradeEntry(entry)) {
        const next = new Set(queued.value);
        next.add(entry.key);
        queued.value = next;
        // 立即刷新任务列表：这一条随即从待更新列表里隐去
        await refreshDownloads();
        messenger.success(`已加入下载队列：${entry.title}`);
    }
}

/** 更新全部：逐个加入队列 */
async function upgradeAll(): Promise<void> {
    busy.value = true;
    let done = 0;
    try {
        for (const entry of entries.value) {
            if (entry.latest === null || queued.value.has(entry.key)) {
                continue;
            }
            if (await upgradeEntry(entry)) {
                done += 1;
                const next = new Set(queued.value);
                next.add(entry.key);
                queued.value = next;
            }
        }
        await refreshDownloads();
        messenger.success(done === 0 ? "没有需要更新的画廊" : `已把 ${done} 个画廊加入下载队列`);
    } finally {
        busy.value = false;
    }
}

/**
 * 更新标记号：让服务端把收藏从本地已有这一版挪到最新版本。
 * 传入多条即为一次批量，服务端仍然逐条向上游查询。
 */
async function updateMarks(list: readonly UpdateEntry[]): Promise<void> {
    const pending = list.filter((entry) => entry.latest !== null && !moved.value.has(entry.key));
    if (pending.length === 0 || props.folderId === undefined) {
        return;
    }
    busy.value = true;
    try {
        const result = await request("favorites.items.refresh", {
            params: { folderId: props.folderId },
            body: { gids: pending.map((entry) => entry.gid) },
        });
        const next = new Set(moved.value);
        let done = 0;
        let failed = 0;
        for (const entry of result.entries) {
            if (!entry.moved) {
                continue;
            }
            done += 1;
            // 结果按原 gid 返回，据此找到列表里的那一行
            const source = pending.find((item) => item.gid === entry.gid);
            if (source !== undefined) {
                next.add(source.key);
            }
            if (entry.reason !== null) {
                failed += 1;
            }
        }
        moved.value = next;
        // 本地这一版已经换成新版本，再次检查时应查新版本
        const movedTo = new Map(
            result.entries
                .filter((entry) => entry.moved && entry.latestGid !== null)
                .map((entry) => [entry.gid, entry.latestGid as number]),
        );
        targets.value = targets.value.map((target) => {
            const latestGid = movedTo.get(target.gid);
            const checked = pending.find((item) => item.gid === target.gid);
            return latestGid === undefined || checked?.latest == null
                ? target
                : {
                      ...target,
                      gid: latestGid,
                      token: checked.latest.token,
                      postedAt: checked.latest.postedAt,
                      pageCount: checked.latest.pageCount,
                  };
        });
        emit("moved");
        if (done === 0) {
            messenger.info("没有需要挪到新版本的收藏");
        } else if (failed > 0) {
            messenger.warning(`已更新 ${done} 条标记号，其中 ${failed} 条只改了本地`);
        } else {
            messenger.success(`已把 ${done} 条收藏挪到最新版本`);
        }
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/** 取消全部更新：撤销这一批新加入的下载任务 */
async function cancelAll(): Promise<void> {
    busy.value = true;
    try {
        const tasks = await request("downloads.list");
        const targets = tasks.filter(
            (task) =>
                (task.status === "queued" || task.status === "running") &&
                entries.value.some((entry) => entry.latest?.gid === task.gid),
        );
        for (const task of targets) {
            await request("downloads.cancel", { params: { taskId: task.id } });
        }
        queued.value = new Set();
        messenger.info(
            targets.length === 0 ? "没有可取消的更新任务" : `已取消 ${targets.length} 个更新任务`,
        );
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/**
 * 删除更新任务：把这一条从更新列表里去掉。
 * 只操作列表，不涉及本地文件：按钮位于更新管理器，名称也是「更新任务」，
 * 不应连带删除用户已下载的画廊（删除本地画廊需在本地画廊页执行批量操作）。
 */
async function forget(entry: UpdateEntry): Promise<void> {
    await forgetUpdate(entry.key);
    messenger.info("已从更新列表移除");
}

/** 打开时：有指定项就按规格清空并直接查这些项，否则只显示缓存 */
watch(
    () => props.open,
    (open) => {
        if (!open) {
            window.removeEventListener("keydown", onKeydown, true);
            return;
        }
        window.addEventListener("keydown", onKeydown, true);
        // 按规格：直接打开时不自动检查，有缓存就显示缓存；带着选中项进来才先清空再查
        if (props.targets !== undefined && props.targets.length > 0) {
            targets.value = props.targets;
            void check();
            return;
        }
        if (props.pendingKeys !== undefined && props.pendingKeys.length > 0) {
            void check(props.pendingKeys);
            return;
        }
        void loadUpdates();
    },
);

/** Esc 与 X 等效；遮罩空白处照规格不接点击 */
function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && props.open) {
        event.stopPropagation();
        close();
    }
}

onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
    <Teleport to="body">
        <Transition name="manager">
            <!-- 遮罩不接收点击：按规格点击空白处不关闭 -->
            <div v-if="open" class="mask">
                <section class="manager" role="dialog" aria-modal="true" :aria-label="head">
                    <header class="head">
                        <h2>{{ head }}</h2>
                        <button class="close" aria-label="关闭" @click="close">
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                        </button>
                    </header>

                    <div class="body">
                        <p v-if="entries.length === 0" class="muted empty">
                            {{
                                updateChecking
                                    ? "正在检查…"
                                    : `还没有检查结果。点下方「${checkLabel}」开始，有缓存时会直接显示缓存。`
                            }}
                        </p>

                        <ul v-else class="rows">
                            <li v-for="entry in entries" :key="entry.key" class="row">
                                <SkeletonImage
                                    class="cover"
                                    :src="entry.thumbUrl"
                                    :alt="entry.title"
                                    ratio="2 / 3"
                                />
                                <div class="info">
                                    <div class="title">{{ entry.title }}</div>
                                    <div class="sub muted">
                                        {{ percentOf(entry) }}
                                        <template v-if="entry.error !== null">
                                            · <span class="err">{{ entry.error }}</span>
                                        </template>
                                    </div>
                                </div>
                                <div class="dates">
                                    <span class="muted">{{ date(entry.localPostedAt) }}</span>
                                    <span class="arrow">→</span>
                                    <span v-if="entry.latest === null" class="muted">已是最新</span>
                                    <span v-else class="latest">
                                        {{ date(entry.latest.postedAt) }}
                                        <span class="badge">v</span>
                                    </span>
                                </div>
                                <div class="acts">
                                    <button
                                        v-if="!isFavorite"
                                        :disabled="busy"
                                        title="从更新列表里移除这一条（不会删除已下载的本地文件）"
                                        @click="forget(entry)"
                                    >
                                        删除更新任务
                                    </button>
                                    <button
                                        v-if="isFavorite"
                                        :disabled="
                                            busy || entry.latest === null || moved.has(entry.key)
                                        "
                                        @click="updateMarks([entry])"
                                    >
                                        {{ moved.has(entry.key) ? "已更新" : "更新标记号" }}
                                    </button>
                                    <button
                                        v-else
                                        :disabled="
                                            busy || entry.latest === null || queued.has(entry.key)
                                        "
                                        @click="upgrade(entry)"
                                    >
                                        {{ queued.has(entry.key) ? "已加入" : "更新" }}
                                    </button>
                                </div>
                            </li>
                        </ul>
                    </div>

                    <footer class="foot">
                        <button :disabled="updateChecking" @click="check()">
                            {{ checkLabel }}
                        </button>
                        <span class="grow" />
                        <span class="muted summary">{{ upgradeableCount }} 个可更新</span>
                        <button
                            v-if="isFavorite"
                            :disabled="busy || upgradeableCount === 0"
                            @click="updateMarks(entries)"
                        >
                            全部更新标记号
                        </button>
                        <template v-else>
                            <button :disabled="busy || upgradeableCount === 0" @click="upgradeAll">
                                更新全部
                            </button>
                            <button :disabled="busy" @click="cancelAll">取消全部更新</button>
                        </template>
                    </footer>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped lang="scss">
.mask {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(0 0 0 / 58%);
}

.manager {
    display: flex;
    flex-direction: column;
    width: min(880px, 100%);
    max-height: 82vh;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 24px 64px rgb(0 0 0 / 55%);
}

.head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-lg);
    color: var(--accent);
}

.close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: none;
    border-color: transparent;
}

.close svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.6;
    stroke-linecap: round;
}

.body {
    flex: 1;
    overflow: auto;
    padding: 12px 14px;
}

.empty {
    margin: 0;
    font-size: var(--font-size-md);
}

.rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.row {
    display: grid;
    grid-template-columns: 56px 1fr max-content max-content;
    align-items: center;
    gap: 12px;
    padding: 8px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.cover {
    width: 56px;
    height: 76px;
    border-radius: 4px;
    --skeleton-fit: cover;
}

.info {
    min-width: 0;
}

.title {
    color: var(--accent);
    font-size: var(--font-size-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.sub {
    margin-top: 2px;
    font-size: var(--font-size-sm);
}

.dates {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-md);
    white-space: nowrap;
}

.dates .arrow {
    color: var(--muted);
}

.dates .latest {
    color: var(--ok);
}

.dates .badge {
    padding: 0 4px;
    font-size: var(--font-size-xs);
    border: 1px solid currentcolor;
    border-radius: 3px;
}

.acts {
    display: flex;
    gap: 6px;
}

.foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--line);
}

.foot .grow {
    flex: 1;
}

.foot .summary {
    font-size: var(--font-size-sm);
}

.err {
    color: var(--danger);
}

.manager-enter-active,
.manager-leave-active {
    transition: opacity 180ms ease;
}

.manager-enter-active .manager,
.manager-leave-active .manager {
    transition:
        transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 180ms ease;
}

.manager-enter-from,
.manager-leave-to {
    opacity: 0;
}

.manager-enter-from .manager,
.manager-leave-to .manager {
    transform: translateY(12px) scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
    .manager-enter-active,
    .manager-leave-active,
    .manager-enter-active .manager,
    .manager-leave-active .manager {
        transition: opacity 120ms ease;
    }

    .manager-enter-from .manager,
    .manager-leave-to .manager {
        transform: none;
    }
}
</style>
