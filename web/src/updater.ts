/*
 * 更新检查的界面侧状态。模块级单例：本地画廊页与更新管理器共用
 * 数据来自 library.updates，检查过程中每查完一条会经 SSE 的 library.update 推过来，
 * 因此可以随查随显示，不必等整批检查完成
 */

import { ref } from "vue";

import type { UpdateCheckTarget, UpdateEntry, UpdateState } from "../../src/api/index.ts";
import { ApiCallError, describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";

export const updateChecking = ref(false);
export const updatePending = ref(0);
/** 已查完的条目，按检查顺序 */
export const updateEntries = ref<readonly UpdateEntry[]>([]);

/** 每查完一条即并入列表：同 key 覆盖，保持原有顺序 */
export function mergeUpdateEntry(entry: UpdateEntry): void {
    const next = [...updateEntries.value];
    const at = next.findIndex((item) => item.key === entry.key);
    if (at === -1) {
        next.push(entry);
    } else {
        next[at] = entry;
    }
    updateEntries.value = next;
}

function apply(state: UpdateState): void {
    updateChecking.value = state.checking;
    updatePending.value = state.pending;
    updateEntries.value = state.entries;
}

/**
 * 只更新进度（还剩几条、是否还在查）
 * SSE 的 library.progress 使用该函数。若不更新，查完最后一条后按钮会一直停在「正在检查…」上
 */
export function applyUpdateProgress(progress: { checking: boolean; pending: number }): void {
    updateChecking.value = progress.checking;
    updatePending.value = progress.pending;
}

/** 读缓存。打开更新管理器时只调用该函数，不触发检查 */
export async function loadUpdates(): Promise<void> {
    try {
        apply(await request("library.updates"));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/**
 * 发起检查。keys 为要查的项（不传即全部），reset 表示先清空已有结果
 * 本地画廊多选后点更新即 reset 与 keys 的用法；
 * 收藏条目没有本地画廊身份，直接作为 targets 传入
 */
export async function startUpdateCheck(input: {
    targets?: readonly UpdateCheckTarget[];
    keys?: readonly string[];
    reset?: boolean;
}): Promise<void> {
    try {
        apply(await request("library.check", { body: input }));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 「删除更新任务」：把该条从更新列表移除，只修改列表，不删除本地文件 */
export async function forgetUpdate(key: string): Promise<void> {
    try {
        const state = await request("library.updates.forget", { body: { keys: [key] } });
        apply(state);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/**
 * 把一条更新加入下载队列。分辨率沿用本地这一版
 * 本地这一版为归档（org/res）时需要账号才能下载：未登录时退回逐页下载，
 * 画质仍按原本的 org/res 走，速度较慢，但不会因此更新失败
 */
export async function upgradeEntry(entry: UpdateEntry): Promise<boolean> {
    const latest = entry.latest;
    if (latest === null) {
        return false;
    }
    const body = { gid: latest.gid, token: latest.token, resolution: entry.resolution };
    try {
        await request("downloads.create", { body });
        return true;
    } catch (caught) {
        const pageMode = `pages-${entry.resolution}`;
        if (!(caught instanceof ApiCallError && caught.code === "not_logged_in")) {
            messenger.error(describeApiError(caught));
            return false;
        }
        try {
            await request("downloads.create", { body: { ...body, resolution: pageMode } });
            messenger.info(`未登录，归档下不了：已改为逐页下载（${pageMode}）`);
            return true;
        } catch (second) {
            messenger.error(describeApiError(second));
            return false;
        }
    }
}
