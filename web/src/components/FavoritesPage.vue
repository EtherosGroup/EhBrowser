<script setup lang="ts">
/*
 * 收藏页。与本地画廊页使用同一套网格与批量操作，差别在于：
 * 顶部多一行收藏夹选择（本地收藏夹与云端分类，可滚动），下方隔开一个「+ 新建本地收藏夹」。
 * 批量操作里的「更新标记号」把收藏从旧版本移到最新版本，复用更新管理器的界面。
 * 「设置标记号」修改的是云端槽位，与版本无关。
 * 左键点击卡片跳到对应画廊详情。
 */

import { computed, onMounted, ref, watch } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";

import type { FavoriteItem, GallerySummary, UpdateCheckTarget } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import {
    activeFolder,
    cloudError,
    cloudFolders,
    createFavoriteFolder,
    favoriteFolders,
    favoriteItems,
    loadFavoriteItems,
    loadFavorites,
    removeFavorite,
    removeFavoriteFolder,
    setFavoriteSlot,
} from "../favorites.ts";
import type { GalleryGroup } from "../gallery-groups.ts";
import { GRID_COLUMN_CHOICES, columnsLabel, gridColumns } from "../ui-prefs.ts";
import { messenger } from "../messenger.ts";
import Dialog from "./Dialog.vue";
import GalleryGrid from "./GalleryGrid.vue";
import UpdateManager from "./UpdateManager.vue";

const router = useRouter();

const selecting = ref(false);
const selected = ref<number[]>([]);
const batchOpen = ref(false);
const columnsOpen = ref(false);
const slotsOpen = ref(false);
const folderListOpen = ref(false);
const newFolder = ref("");
const askRemoveFolder = ref(false);
const askUnfavorite = ref(false);
/** 批量下载的确认弹窗，选择分辨率后才入队 */
const askDownload = ref(false);
const busy = ref(false);
/** 更新标记号所用的管理器：打开时把选中项作为检查目标传入。 */
const marksOpen = ref(false);
const markTargets = ref<readonly UpdateCheckTarget[]>([]);

/** 当前是云端收藏夹时不允许修改本地条目。 */
const isCloud = computed(() => activeFolder.value.startsWith("cloud:"));

const items = computed<readonly FavoriteItem[]>(() =>
    isCloud.value ? favoriteItems.value : favoriteItems.value,
);
const groups = computed<GalleryGroup[]>(() => [
    {
        title: `${titleOf(activeFolder.value)}${items.value.length > 0 ? `（${items.value.length}）` : ""}`,
        items: items.value.map(toSummary),
    },
]);
const selectedItems = computed(() =>
    items.value.filter((item) => selected.value.includes(item.gid)),
);

function titleOf(folder: string): string {
    if (folder.startsWith("cloud:")) {
        const slot = Number(folder.slice("cloud:".length));
        return cloudFolders.value.find((item) => item.slot === slot)?.name ?? `云端收藏 ${slot}`;
    }
    return favoriteFolders.value.find((item) => item.id === folder)?.name ?? "收藏";
}

/** 收藏项转换成网格组件使用的结构。 */
function toSummary(item: FavoriteItem): GallerySummary {
    return {
        gid: item.gid,
        token: item.token,
        title: item.title,
        titleJpn: "",
        category: "Misc",
        thumbUrl: item.thumbUrl,
        uploader: "",
        postedAt: item.addedAt,
        pageCount: item.pageCount,
        sizeBytes: 0,
        rating: 0,
        torrentCount: 0,
        expunged: false,
        tags: [],
        language: null,
        favorite: item.slot >= 0 ? { slot: item.slot, name: "" } : null,
    };
}

/** 左键点击时，收藏夹里的画廊跳到详情页 */
function to(item: GallerySummary): RouteLocationRaw {
    return { name: "gallery", params: { gid: item.gid, token: item.token } };
}

function toggleSelect(): void {
    selecting.value = !selecting.value;
    if (!selecting.value) {
        batchOpen.value = false;
        selected.value = [];
    }
}

/** 设置标记号：把选中项改到某个云端槽位，-1 表示取消云端收藏。该操作与「更新标记号」（换版本）无关。 */
async function applySlot(slot: number): Promise<void> {
    if (isCloud.value) {
        messenger.info("云端收藏夹里的条目不能改本地标记号，请选中一个本地收藏夹");
        return;
    }
    busy.value = true;
    try {
        for (const item of selectedItems.value) {
            await setFavoriteSlot(activeFolder.value, item.gid, slot);
        }
        slotsOpen.value = false;
        messenger.success(
            `已把 ${selectedItems.value.length} 项标记号改为 ${slot < 0 ? "取消收藏" : slot}`,
        );
    } finally {
        busy.value = false;
    }
}

/** 收藏条目转换为更新检查目标。key 用 fav:<gid>，与本地画廊的 <gid>-<分辨率> 区分开。 */
function markTargetOf(item: FavoriteItem): UpdateCheckTarget {
    return {
        key: `fav:${item.gid}`,
        gid: item.gid,
        token: item.token,
        title: item.title,
        thumbUrl: item.thumbUrl,
        postedAt: item.addedAt,
        pageCount: item.pageCount,
    };
}

/**
 * 打开「更新标记号」：把选中项交给更新管理器，由它向上游查询是否有更新的版本。
 * 未选中任何项时只显示上次的缓存，与本地画廊页打开管理器的行为一致。
 */
function openMarks(): void {
    if (isCloud.value) {
        messenger.info("云端收藏夹里的条目不能更新本地标记号，请选中一个本地收藏夹");
        return;
    }
    markTargets.value = selectedItems.value.map(markTargetOf);
    slotsOpen.value = false;
    marksOpen.value = true;
}

async function unfavoriteSelected(): Promise<void> {
    busy.value = true;
    try {
        for (const item of selectedItems.value) {
            await removeFavorite(activeFolder.value, item.gid);
        }
        selected.value = [];
        askUnfavorite.value = false;
        messenger.success("已从收藏夹移除");
    } finally {
        busy.value = false;
    }
}

async function favoriteSelected(): Promise<void> {
    busy.value = true;
    try {
        let done = 0;
        for (const item of selectedItems.value) {
            if (item.slot >= 0) {
                continue;
            }
            await setFavoriteSlot(activeFolder.value, item.gid, 0);
            done += 1;
        }
        messenger.success(done === 0 ? "选中项都已在云端收藏里" : `已收藏 ${done} 项到云端槽位 0`);
    } finally {
        busy.value = false;
    }
}

async function removeFolder(): Promise<void> {
    await removeFavoriteFolder(activeFolder.value);
    askRemoveFolder.value = false;
    messenger.info("收藏夹已删除");
}

async function submitFolder(): Promise<void> {
    if (newFolder.value.trim() === "") {
        return;
    }
    await createFavoriteFolder(newFolder.value);
    newFolder.value = "";
}

/** 把当前收藏夹里的画廊整批加入播放列表（与本地画廊页的写法一致） */
async function addToPlaylist(): Promise<void> {
    busy.value = true;
    let done = 0;
    try {
        for (const item of selectedItems.value) {
            const ok = await request("playlist.add", {
                body: {
                    gid: item.gid,
                    token: item.token,
                    title: item.title,
                    thumbUrl: item.thumbUrl,
                    pageCount: item.pageCount,
                    resolution: null,
                },
            });
            if (ok !== undefined) {
                done += 1;
            }
        }
        messenger.success(`已把 ${done} 个画廊加入播放列表`);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/*
 * 批量加入下载队列。弹窗中选择归档分辨率（org 原档、res 重采样），逐条入队。
 * 归档下载需要登录并消耗 GP，未登录时服务端返回 not_logged_in。
 * 失败的条数与原因如实提示。
 */
async function downloadSelected(resolution: "org" | "res"): Promise<void> {
    askDownload.value = false;
    busy.value = true;
    let queued = 0;
    let refused = 0;
    let reason = "";
    try {
        for (const item of selectedItems.value) {
            try {
                await request("downloads.create", {
                    body: { gid: item.gid, token: item.token, resolution },
                });
                queued += 1;
            } catch (caught) {
                refused += 1;
                reason = describeApiError(caught);
            }
        }
    } finally {
        busy.value = false;
    }
    if (refused === 0) {
        messenger.success(`已把 ${queued} 个画廊加入下载队列（${resolution}）`);
        return;
    }
    if (queued > 0) {
        messenger.info(`${queued} 个已加入队列，${refused} 个没排上：${reason}`);
        return;
    }
    messenger.error(`${refused} 个都没排上：${reason}`);
}

watch(activeFolder, () => {
    selected.value = [];
    void loadFavoriteItems();
});
onMounted(async () => {
    await loadFavorites();
    await loadFavoriteItems();
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <h2>收藏</h2>
            <div class="picker">
                <span class="muted">收藏夹：</span>
                <button class="folder" :disabled="busy" @click="folderListOpen = !folderListOpen">
                    {{ titleOf(activeFolder) }}
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
                </button>

                <div v-if="folderListOpen" class="menu">
                    <div class="group-title muted">本地收藏夹</div>
                    <button
                        v-for="folder in favoriteFolders"
                        :key="folder.id"
                        :class="{ on: activeFolder === folder.id }"
                        @click="
                            activeFolder = folder.id;
                            folderListOpen = false;
                        "
                    >
                        {{ folder.name }} <span class="muted">({{ folder.count }})</span>
                    </button>

                    <div class="group-title muted">
                        云端收藏夹
                        <span v-if="cloudError !== null" class="err">· {{ cloudError }}</span>
                    </div>
                    <button
                        v-for="folder in cloudFolders"
                        :key="folder.slot"
                        :class="{ on: activeFolder === `cloud:${folder.slot}` }"
                        @click="
                            activeFolder = `cloud:${folder.slot}`;
                            folderListOpen = false;
                        "
                    >
                        {{ folder.name }} <span class="muted">({{ folder.count }})</span>
                    </button>
                    <p v-if="cloudFolders.length === 0" class="muted empty">
                        没有可显示的云端收藏夹
                    </p>

                    <div class="divider" />
                    <div class="new-row">
                        <input
                            v-model="newFolder"
                            placeholder="新收藏夹名称"
                            @keyup.enter="submitFolder"
                        />
                        <button :disabled="busy" @click="submitFolder">+ 新建本地收藏夹</button>
                    </div>
                    <button
                        v-if="!isCloud"
                        class="danger"
                        :disabled="busy || favoriteFolders.length <= 1"
                        @click="
                            folderListOpen = false;
                            askRemoveFolder = true;
                        "
                    >
                        删除当前收藏夹
                    </button>
                </div>
            </div>
            <span class="muted">{{ items.length }} 项</span>
        </header>

        <p v-if="items.length === 0" class="muted">
            {{
                isCloud
                    ? "这个云端收藏夹里没有内容，或需要登录才能读取。"
                    : "这个收藏夹还是空的。在画廊详情页点「加入收藏」，或在本地画廊里批量收藏。"
            }}
        </p>

        <GalleryGrid
            v-else
            :groups="groups"
            :to="to"
            :mode="selecting ? 'select' : 'browse'"
            :selected="selected"
            :columns="gridColumns"
            :thumb-height="200"
            @update:selected="(value) => (selected = value)"
        />

        <div v-if="items.length > 0" class="rail">
            <div v-if="batchOpen" class="group sub">
                <button
                    title="收藏选中项到云端"
                    :disabled="busy || isCloud"
                    @click="favoriteSelected"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.4 12 20 12 20z"
                        />
                    </svg>
                    <span class="label">收藏选中项</span>
                </button>
                <button
                    title="取消收藏选中项"
                    :disabled="busy || isCloud"
                    @click="askUnfavorite = true"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.4 12 20 12 20z"
                        />
                        <path d="M4 4l16 16" />
                    </svg>
                    <span class="label">取消收藏</span>
                </button>

                <div class="size">
                    <button
                        title="更新标记号：把收藏挪到该画廊的最新版本"
                        :disabled="busy || isCloud"
                        @click="openMarks"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 20V9M8 13.5l4-4 4 4" />
                            <path d="M5 5h14" />
                        </svg>
                        <span class="label">更新标记号</span>
                    </button>
                </div>

                <div class="size">
                    <button
                        title="设置标记号：改这条收藏的云端槽位"
                        :disabled="busy || isCloud"
                        @click="slotsOpen = !slotsOpen"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 7h16M4 12h16M4 17h16" />
                        </svg>
                        <span class="label">设置标记号</span>
                    </button>
                    <div v-if="slotsOpen" class="popover wrap">
                        <button :disabled="busy" @click="applySlot(-1)">取消云端</button>
                        <button v-for="n in 10" :key="n" :disabled="busy" @click="applySlot(n - 1)">
                            {{ n - 1 }}
                        </button>
                    </div>
                </div>

                <button title="加入播放列表" :disabled="busy" @click="addToPlaylist">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 6l10 6-10 6z" />
                        <path d="M18 4v6M15 7h6" />
                    </svg>
                    <span class="label">加入播放列表</span>
                </button>

                <button
                    title="把选中项加入下载队列，归档分辨率二选一"
                    :disabled="busy || selected.length === 0"
                    @click="askDownload = true"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 4v10M8 10.5l4 4 4-4" />
                        <path d="M5 19h14" />
                    </svg>
                    <span class="label">下载选中项</span>
                </button>
            </div>

            <div class="group main">
                <button
                    class="rail-btn"
                    :class="{ on: selecting }"
                    :title="selecting ? '退出批量操作' : '批量操作'"
                    @click="
                        toggleSelect();
                        batchOpen = selecting;
                    "
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 7h16M4 12h16M4 17h10" />
                        <path d="M17 15l2 2 3-4" />
                    </svg>
                    <span class="label">{{
                        selecting ? `批量操作（已选 ${selected.length}）` : "批量操作"
                    }}</span>
                </button>

                <div class="size">
                    <button
                        class="rail-btn"
                        title="调整排列尺寸"
                        @click="columnsOpen = !columnsOpen"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                        </svg>
                        <span class="label">每行 {{ columnsLabel(gridColumns) }}</span>
                    </button>
                    <div v-if="columnsOpen" class="popover">
                        <button
                            v-for="choice in GRID_COLUMN_CHOICES"
                            :key="choice"
                            :class="{ on: gridColumns === choice }"
                            @click="gridColumns = choice"
                        >
                            {{ choice === 0 ? "自动" : choice }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <Dialog v-model="askDownload" title="下载选中项">
            <p>要把选中的 {{ selected.length }} 个画廊加入下载队列吗？归档分辨率二选一。</p>
            <p class="muted">
                归档下载需要登录并消耗 GP。未登录时请到画廊详情页用逐页下载（游客可用）。
            </p>
            <template #buttons>
                <button :disabled="busy" @click="askDownload = false">取消</button>
                <button :disabled="busy" @click="downloadSelected('res')">重采样 res</button>
                <button :disabled="busy" @click="downloadSelected('org')">原档 org</button>
            </template>
        </Dialog>

        <Dialog v-model="askUnfavorite" title="取消收藏">
            <p>要把选中的 {{ selected.length }} 项从当前收藏夹移除吗？</p>
            <template #buttons>
                <button @click="askUnfavorite = false">取消</button>
                <button :disabled="busy" @click="unfavoriteSelected">确定</button>
            </template>
        </Dialog>

        <Dialog v-model="askRemoveFolder" title="删除收藏夹">
            <p>要删除「{{ titleOf(activeFolder) }}」及其中的条目吗？无法恢复。</p>
            <template #buttons>
                <button @click="askRemoveFolder = false">取消</button>
                <button :disabled="busy" @click="removeFolder">删除</button>
            </template>
        </Dialog>

        <!-- 更新标记号复用更新管理器：同一套逐条检查与展示，动作改为「挪到最新版本」。 -->
        <UpdateManager
            v-model:open="marksOpen"
            mode="favorite"
            :folder-id="activeFolder"
            :targets="markTargets"
            @moved="loadFavoriteItems()"
        />
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    flex-wrap: wrap;
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    color: var(--accent);
}

.picker {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
}

.folder {
    display: flex;
    align-items: center;
    gap: 6px;
}

.folder svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.8;
    stroke-linecap: round;
}

/* 收藏夹菜单：内容多时可滚动，本地与云端两段之间用分隔线隔开 */
.menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: var(--z-overlay);
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 260px;
    max-height: 60vh;
    overflow: auto;
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    box-shadow: 0 16px 40px rgb(0 0 0 / 55%);
}

.menu button {
    text-align: left;
}

.menu button.on {
    border-color: var(--accent);
    color: var(--accent);
}

.menu .group-title {
    margin-top: 4px;
    font-size: var(--font-size-sm);
}

.menu .empty {
    margin: 0;
    font-size: var(--font-size-sm);
}

.divider {
    height: 1px;
    margin: 6px 0;
    background: var(--line);
}

.new-row {
    display: flex;
    gap: 6px;
}

.menu .danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
}

/* 与本地画廊页一致：固定在左下角，悬停 0.5 秒后才浮出文字。 */
.rail {
    position: fixed;
    left: 16px;
    bottom: 18px;
    z-index: var(--z-floating);
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
}

.group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
}

.rail-btn,
.group.sub button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
    backdrop-filter: blur(4px);
}

.label {
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    opacity: 0;
    transition:
        max-width 140ms ease,
        opacity 140ms ease;
}

.rail:hover .label {
    max-width: 180px;
    opacity: 1;
    transition-delay: 500ms;
}

.rail-btn.on {
    border-color: var(--accent);
    color: var(--accent);
}

.rail svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.size {
    position: relative;
}

.popover {
    position: absolute;
    bottom: 0;
    left: calc(100% + 8px);
    display: flex;
    gap: 4px;
    padding: 8px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

.popover.wrap {
    flex-wrap: wrap;
    width: 200px;
}

.popover button {
    min-width: 32px;
    padding: 4px 6px;
}

.popover button.on {
    border-color: var(--accent);
    color: var(--accent);
}

.err {
    color: var(--danger);
}

@media (prefers-reduced-motion: reduce) {
    .label {
        transition: none;
    }
}
</style>
