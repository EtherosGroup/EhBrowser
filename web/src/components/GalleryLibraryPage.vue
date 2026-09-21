<script setup lang="ts">
/*
 * 本地画廊页面。复用结果网格（含多选模式），左下角一列竖排功能按钮：C 批量操作 / B 排列尺寸 / A 更新管理。
 * 按钮默认只显示图标，悬停 0.5 秒后才浮出文字，由 CSS 的 transition-delay 控制，离开时不延时。
 * 点 C 之后，左键卡片的行为从「播放这个画廊」变为「选中这个画廊」。
 */

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";

import type { GallerySummary, LocalGallery } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import type { GalleryGroup } from "../gallery-groups.ts";
import { GRID_COLUMN_CHOICES, columnsLabel, gridColumns } from "../ui-prefs.ts";
import { messenger } from "../messenger.ts";
import { addFavorite, favoriteFolders, loadFavorites } from "../favorites.ts";
import { addToUserPlaylist, removePlaylistItem } from "../playlist.ts";
import { loadUpdates, startUpdateCheck } from "../updater.ts";
import Dialog from "./Dialog.vue";
import GalleryGrid from "./GalleryGrid.vue";
import UpdateManager from "./UpdateManager.vue";

const router = useRouter();

const items = ref<readonly LocalGallery[]>([]);
const loading = ref(true);
/** 多选模式：C 打开后才有意义 */
const selecting = ref(false);
const selected = ref<number[]>([]);
/** 批量操作面板是否展开 */
const batchOpen = ref(false);
const columnsOpen = ref(false);
/** 更新管理器是否打开。 */
const managerOpen = ref(false);
const managerKeys = ref<readonly string[] | undefined>(undefined);
/** 二次确认弹窗的开关。 */
const askDelete = ref(false);
const askUnfavorite = ref(false);
const busy = ref(false);

const groups = computed<GalleryGroup[]>(() => [
    {
        title: `本地画廊${items.value.length > 0 ? `（${items.value.length}）` : ""}`,
        items: items.value.map(toSummary),
    },
]);

/** 本地画廊的卡片数据：优先使用下载时留下的快照，没有快照时按元数据构造。 */
function toSummary(item: LocalGallery): GallerySummary {
    const snapshot = item.summary;
    if (snapshot !== null) {
        return snapshot;
    }
    return {
        gid: item.gid,
        token: item.token,
        title: item.title,
        titleJpn: "",
        category: "Misc",
        thumbUrl: "",
        uploader: "",
        postedAt: item.downloadedAt,
        pageCount: item.pageCount,
        sizeBytes: item.sizeBytes,
        rating: 0,
        torrentCount: 0,
        expunged: false,
        tags: [],
        language: null,
        favorite: null,
    };
}

/** 卡片去向：直接进入播放器。本地副本不发起请求。 */
function to(item: GallerySummary): RouteLocationRaw {
    return { name: "gallery-player", params: { gid: item.gid, token: item.token } };
}

const selectedItems = computed(() =>
    items.value.filter((item) => selected.value.includes(item.gid)),
);

/** 选中项的更新检查 key：<gid>-<分辨率>。 */
const selectedKeys = computed(() =>
    selectedItems.value.map((item) => `${item.gid}-${item.resolution}`),
);

async function load(): Promise<void> {
    loading.value = true;
    try {
        items.value = await request("library.list");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        loading.value = false;
    }
}

/** C：切换多选。退出时清空选中 */
function toggleSelect(): void {
    selecting.value = !selecting.value;
    if (!selecting.value) {
        batchOpen.value = false;
        selected.value = [];
    }
}

/** 打开更新管理器：带选中项时先按规格清空，然后直接检查这些项。 */
async function openManager(keys?: readonly string[]): Promise<void> {
    managerKeys.value = keys;
    managerOpen.value = true;
    if (keys !== undefined && keys.length > 0) {
        await startUpdateCheck({ keys, reset: true });
        return;
    }
    await loadUpdates();
}

async function deleteSelected(): Promise<void> {
    busy.value = true;
    let done = 0;
    try {
        for (const item of selectedItems.value) {
            const result = await request("library.remove", {
                params: { gid: item.gid, resolution: item.resolution },
            });
            if (result.removed) {
                done += 1;
            }
        }
        messenger.success(`已删除 ${done} 个本地画廊`);
        selected.value = [];
        askDelete.value = false;
        await load();
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/** e：继续下载。重新加入同一分辨率的下载任务，缺的页会被补齐。 */
async function continueDownload(): Promise<void> {
    busy.value = true;
    let done = 0;
    try {
        for (const item of selectedItems.value) {
            await request("downloads.create", {
                body: { gid: item.gid, token: item.token, resolution: item.resolution },
            });
            done += 1;
        }
        messenger.success(`已把 ${done} 个画廊加入下载队列`);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/** d：加入用户播放列表。只追加，不清空。 */
async function addSelectedToPlaylist(): Promise<void> {
    busy.value = true;
    let done = 0;
    try {
        for (const item of selectedItems.value) {
            const ok = await addToUserPlaylist({
                gid: item.gid,
                token: item.token,
                title: item.title,
                thumbUrl: item.summary?.thumbUrl ?? "",
                pageCount: item.pageCount,
                resolution: item.resolution,
                bytesPerPage: item.files > 0 ? Math.round(item.sizeBytes / item.files) : 0,
            });
            if (ok) {
                done += 1;
            }
        }
        messenger.success(`已把 ${done} 个画廊加入播放列表`);
    } finally {
        busy.value = false;
    }
}

/** a：收藏选中项。放进第一个本地收藏夹，并同步云端槽位 0 */
async function favoriteSelected(): Promise<void> {
    busy.value = true;
    const folder = favoriteFolders.value[0];
    try {
        if (folder === undefined) {
            await loadFavorites();
        }
        let done = 0;
        for (const item of selectedItems.value) {
            const ok = await addFavorite({
                gid: item.gid,
                token: item.token,
                title: item.title,
                thumbUrl: item.summary?.thumbUrl ?? "",
                pageCount: item.pageCount,
                slot: 0,
            });
            if (ok) {
                done += 1;
            }
        }
        messenger.success(done === 0 ? "没有可收藏的项" : `已收藏 ${done} 个画廊`);
    } finally {
        busy.value = false;
    }
}

/** b：取消收藏选中项。逐个把标记号改成 -1，同时也取消云端收藏 */
async function unfavoriteSelected(): Promise<void> {
    const folder = favoriteFolders.value[0];
    if (folder === undefined) {
        await loadFavorites();
        askUnfavorite.value = false;
        return;
    }
    busy.value = true;
    try {
        await favoriteItemsIn(folder.id);
        askUnfavorite.value = false;
    } finally {
        busy.value = false;
    }
}

/** 把选中项逐个从本地收藏夹移除，标记号一并改为取消。 */
async function favoriteItemsIn(folderId: string): Promise<void> {
    let done = 0;
    for (const item of selectedItems.value) {
        try {
            await request("favorites.items.slot", {
                params: { folderId, gid: item.gid },
                body: { slot: -1 },
            });
            await request("favorites.items.remove", { params: { folderId, gid: item.gid } });
            done += 1;
        } catch (caught) {
            messenger.error(describeApiError(caught));
        }
    }
    messenger.success(`已取消 ${done} 个画廊的收藏`);
}

/** 除 f 之外还有单行移除：从播放列表里去掉相同身份的那一项。 */
async function dropFromPlaylist(): Promise<void> {
    busy.value = true;
    try {
        for (const item of selectedItems.value) {
            await removePlaylistItem(`${item.gid}-${item.resolution}`);
        }
        messenger.info("已尝试从播放列表移除选中项");
    } finally {
        busy.value = false;
    }
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && selecting.value && !batchOpen.value) {
        toggleSelect();
    }
}

onMounted(() => {
    void load();
    window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <h2>本地画廊</h2>
            <span class="muted">
                {{ items.length }} 个 · 共 {{ items.reduce((n, i) => n + i.files, 0) }} 页
            </span>
            <button class="top-manager" title="打开更新管理" @click="openManager()">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4v10M8 10.5l4 4 4-4" />
                    <path d="M5 19h14" />
                </svg>
                更新管理
            </button>
        </header>

        <p v-if="loading && items.length === 0" class="muted">读取本地库中…</p>
        <p v-else-if="items.length === 0" class="muted">
            本地还没有画廊。在画廊详情页或播放器里点下载，落盘后就会出现在这里。
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

        <!-- 左下角竖排功能按钮。默认只有图标，悬停 0.5 秒浮出文字 -->
        <div v-if="items.length > 0" class="rail">
            <div v-if="batchOpen" class="group sub">
                <button title="收藏选中画廊" :disabled="busy" @click="favoriteSelected">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.4 12 20 12 20z"
                        />
                    </svg>
                    <span class="label">收藏选中画廊</span>
                </button>
                <button title="取消收藏选中画廊" :disabled="busy" @click="askUnfavorite = true">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.4 12 20 12 20z"
                        />
                        <path d="M4 4l16 16" />
                    </svg>
                    <span class="label">取消收藏</span>
                </button>
                <button title="升级选中画廊" :disabled="busy" @click="openManager(selectedKeys)">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 20V9M8 13.5l4-4 4 4" />
                        <path d="M5 5h14" />
                    </svg>
                    <span class="label">升级选中画廊</span>
                </button>
                <button title="加入播放列表" :disabled="busy" @click="addSelectedToPlaylist">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 6l10 6-10 6z" />
                        <path d="M18 4v6M15 7h6" />
                    </svg>
                    <span class="label">加入播放列表</span>
                </button>
                <button title="从播放列表移除" :disabled="busy" @click="dropFromPlaylist">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 6l10 6-10 6z" />
                        <path d="M15 7h6" />
                    </svg>
                    <span class="label">移出播放列表</span>
                </button>
                <button title="继续下载选中画廊" :disabled="busy" @click="continueDownload">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 4v10M8 10.5l4 4 4-4" />
                        <path d="M5 19h14" />
                    </svg>
                    <span class="label">继续下载</span>
                </button>
                <button
                    class="danger"
                    title="删除选中画廊"
                    :disabled="busy || selected.length === 0"
                    @click="askDelete = true"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
                        <path d="M11 11v5M13 11v5" />
                    </svg>
                    <span class="label">删除选中画廊</span>
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

                <button class="rail-btn" title="打开更新管理" @click="openManager()">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 19V9M8 12.5l4-4 4 4" />
                        <path d="M5 5h14" />
                    </svg>
                    <span class="label">更新管理</span>
                </button>
            </div>
        </div>

        <!-- 删除的二次确认弹窗 -->
        <Dialog v-model="askDelete" title="删除本地画廊">
            <p>要删除选中的 {{ selected.length }} 个本地画廊吗？文件会从磁盘删掉，无法恢复。</p>
            <template #buttons>
                <button :disabled="busy" @click="askDelete = false">取消</button>
                <button :disabled="busy" @click="deleteSelected">删除</button>
            </template>
        </Dialog>

        <!-- 取消收藏的二次确认。接口未实现，此处如实说明。 -->
        <Dialog v-model="askUnfavorite" title="取消收藏">
            <p>要取消收藏选中的 {{ selected.length }} 个画廊吗？会同时从收藏夹与云端移除。</p>
            <template #buttons>
                <button @click="askUnfavorite = false">取消</button>
                <button :disabled="busy" @click="unfavoriteSelected">确定</button>
            </template>
        </Dialog>

        <UpdateManager v-model:open="managerOpen" :pending-keys="managerKeys" />
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    color: var(--accent);
}

.top-manager {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}

.top-manager svg,
.rail svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 竖排功能按钮：固定在左下角 */
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

/* 默认只有图标，悬停 0.5 秒后才浮出文字，离开时立刻收起。延时只写在 hover 上。 */
.label {
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    opacity: 0;
    transition:
        max-width 140ms ease,
        opacity 140ms ease;
}

.rail:hover .label,
.rail .group:hover .label {
    max-width: 180px;
    opacity: 1;
    transition-delay: 500ms;
}

.rail-btn.on {
    border-color: var(--accent);
    color: var(--accent);
}

.group.sub button {
    color: var(--muted);
}

.group.sub button.danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
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

.popover button {
    min-width: 32px;
    padding: 4px 6px;
}

.popover button.on {
    border-color: var(--accent);
    color: var(--accent);
}

@media (prefers-reduced-motion: reduce) {
    .label {
        transition: none;
    }
}
</style>
