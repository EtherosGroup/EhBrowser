<script setup lang="ts">
/**
 * 播放列表页。只展示用户播放列表：每行一个画廊，最右边是它的播放进度
 * 顶部是两级进度（第几个画廊/总画廊数、已播页数/总页数）与三个动作：播放、从头播放、清空
 * 点某一项就从它记录的页开始播，它前面的项即视为已播放
 */

import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { PlaylistItem } from "../../../src/api/index.ts";
import {
    clearUserPlaylist,
    currentIndex,
    currentPlaylistKey,
    loadUserPlaylist,
    markPlaying,
    playedPages,
    removePlaylistItem,
    userPlaylist,
    userPlaylistPages,
} from "../playlist.ts";
import SkeletonImage from "./SkeletonImage.vue";
import Dialog from "./Dialog.vue";

const router = useRouter();
const askClear = ref(false);
const busy = ref(false);

/** 当前播到第几个画廊（不在列表里就从 0 算起） */
const galleryPosition = computed(() => (currentIndex.value === -1 ? 0 : currentIndex.value + 1));

/** 某一项该显示成什么状态：已播放 / 正在播放 / 未播放 */
function stateOf(item: PlaylistItem, index: number): "done" | "current" | "todo" {
    if (item.key === currentPlaylistKey.value) {
        return "current";
    }
    const at = currentIndex.value;
    if (at !== -1 && index < at) {
        return "done";
    }
    return "todo";
}

/** 从某一项开始播放：先把它设为当前项，再按它记录的页进入播放器 */
async function play(item: PlaylistItem): Promise<void> {
    busy.value = true;
    await markPlaying(item.key);
    busy.value = false;
    void router.push({
        name: "gallery-player",
        params: { gid: item.gid, token: item.token },
        query: item.page > 1 ? { page: String(item.page) } : {},
    });
}

/** 从头播放：清除当前项，从第一项的开头开始 */
async function playFromStart(): Promise<void> {
    const first = userPlaylist.value[0];
    if (first === undefined) {
        return;
    }
    await play({ ...first, page: 1 });
}

/** 播放当前项；没有当前项时播放第一项 */
async function playCurrent(): Promise<void> {
    const item = userPlaylist.value[currentIndex.value] ?? userPlaylist.value[0];
    if (item === undefined) {
        return;
    }
    await play(item);
}

async function confirmClear(): Promise<void> {
    await clearUserPlaylist();
    askClear.value = false;
}

onMounted(() => {
    void loadUserPlaylist();
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <div class="progress">
                <span> 画廊进度 {{ galleryPosition }}/{{ userPlaylist.length }} </span>
                <span class="muted">·</span>
                <span> 播放进度 {{ playedPages }}/{{ userPlaylistPages }} 页 </span>
            </div>
            <div class="acts">
                <button :disabled="busy || userPlaylist.length === 0" @click="playCurrent">
                    播放
                </button>
                <button :disabled="busy || userPlaylist.length === 0" @click="playFromStart">
                    从头播放
                </button>
                <button
                    class="danger"
                    :disabled="busy || userPlaylist.length === 0"
                    @click="askClear = true"
                >
                    清空播放列表
                </button>
            </div>
        </header>

        <p v-if="userPlaylist.length === 0" class="muted empty">
            播放列表是空的。在画廊详情页点「加入播放列表」，或到本地画廊里多选后加入。
        </p>

        <ul v-else class="rows">
            <li
                v-for="(item, index) in userPlaylist"
                :key="item.key"
                class="row"
                :class="stateOf(item, index)"
            >
                <button class="open" :disabled="busy" @click="play(item)">
                    <SkeletonImage
                        class="cover"
                        :src="item.thumbUrl"
                        :alt="item.title"
                        ratio="2 / 3"
                    />
                    <span class="info">
                        <span class="title">{{ item.title }}</span>
                        <span class="sub muted">
                            {{ item.pageCount }} 页 ·
                            {{ item.resolution === null ? "网络" : `本地 ${item.resolution}` }} ·
                            {{
                                stateOf(item, index) === "done"
                                    ? "已播放"
                                    : stateOf(item, index) === "current"
                                      ? "正在播放"
                                      : "未播放"
                            }}
                        </span>
                    </span>
                    <span class="count">{{ item.page }}/{{ item.pageCount }}</span>
                </button>
                <button
                    class="drop"
                    title="从播放列表移除"
                    :disabled="busy"
                    @click="removePlaylistItem(item.key)"
                >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                </button>
            </li>
        </ul>

        <Dialog v-model="askClear" title="清空播放列表">
            <p>要清空播放列表吗？共 {{ userPlaylist.length }} 个画廊，清空后无法恢复。</p>
            <template #buttons>
                <button @click="askClear = false">取消</button>
                <button @click="confirmClear">确定</button>
            </template>
        </Dialog>
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
}

.progress {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--font-size-lg);
}

.acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.acts .danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
}

.empty {
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
    display: flex;
    align-items: stretch;
    gap: 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.row.done {
    opacity: 0.62;
}

.row.current {
    border-color: var(--accent);
}

/* 整行可点：封面 + 标题信息 + 右侧进度 */
.open {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    align-items: center;
    gap: 12px;
    flex: 1;
    padding: 8px;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
}

.cover {
    width: 64px;
    height: 86px;
    border-radius: 4px;
    --skeleton-fit: cover;
}

.info {
    display: flex;
    flex-direction: column;
    gap: 4px;
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
    font-size: var(--font-size-sm);
}

.count {
    padding-right: 8px;
    color: var(--muted);
    font-size: var(--font-size-md);
    font-variant-numeric: tabular-nums;
}

.drop {
    display: grid;
    place-items: center;
    width: 40px;
    padding: 0;
    color: var(--muted);
    background: none;
    border: none;
    border-left: 1px solid var(--line);
    border-radius: 0 6px 6px 0;
}

.drop svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.6;
    stroke-linecap: round;
}

.drop:hover:not(:disabled) {
    color: var(--danger);
}
</style>
