<script setup lang="ts">
/**
 * 全部预览图。上游每 20 页一组，逐组请求后追加。
 * 上游请求有最小间隔（默认 5 秒），因此内容是逐段出现而不是一次铺满；可随时停止。
 * 点击某张图进入播放器并从那一页开始播放。
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import type { GalleryPreviewPage } from "../../../src/api/index.ts";
import { describeApiError, isAbortError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import SpriteImage from "./SpriteImage.vue";

/** 组数上限，避免上游给出异常值时无限拉取 */
const MAX_GROUPS = 500;

const props = defineProps<{ gid: number; token: string }>();

const title = ref("");
const pageCount = ref(0);
const previews = ref<GalleryPreviewPage[]>([]);
const index = ref(0);
const loading = ref(false);
const stopped = ref(false);
/** 上游已表示没有下一组 */
const finished = ref(false);
const error = ref("");

let controller = new AbortController();
let signal = controller.signal;

const total = computed(() => Math.max(pageCount.value, previews.value.length));

/** 取一组。返回是否还要继续 */
async function loadGroup(): Promise<boolean> {
    const active = signal;
    const set = await request("galleries.previews", {
        params: { gid: props.gid, token: props.token },
        query: { index: index.value },
        signal: active,
    });
    if (active.aborted) {
        return false;
    }
    previews.value = [...previews.value, ...set.previews];
    index.value = set.index + 1;
    return set.hasMore && set.previews.length > 0;
}

async function loadAll(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
        while (!stopped.value && !signal.aborted && index.value < MAX_GROUPS) {
            if (!(await loadGroup())) {
                finished.value = true;
                return;
            }
        }
    } catch (caught) {
        if (signal.aborted || isAbortError(caught)) {
            return;
        }
        error.value = describeApiError(caught);
        messenger.error(error.value);
    } finally {
        if (!signal.aborted) {
            loading.value = false;
        }
    }
}

function stop(): void {
    controller.abort();
    controller = new AbortController();
    signal = controller.signal;
    stopped.value = true;
    loading.value = false;
}

function resume(): void {
    if (!stopped.value) {
        return;
    }
    stopped.value = false;
    void loadAll();
}

async function load(): Promise<void> {
    controller.abort();
    controller = new AbortController();
    signal = controller.signal;
    title.value = "";
    pageCount.value = 0;
    previews.value = [];
    index.value = 0;
    stopped.value = false;
    finished.value = false;
    try {
        const info = await request("galleries.detail", {
            params: { gid: props.gid, token: props.token },
            signal,
        });
        if (signal.aborted) {
            return;
        }
        title.value = info.title;
        pageCount.value = info.pageCount;
        document.title = `全部预览 - ${info.title} - EhBrowser`;
        await loadAll();
    } catch (caught) {
        if (signal.aborted || isAbortError(caught)) {
            return;
        }
        error.value = describeApiError(caught);
        messenger.error(error.value);
    }
}

watch(
    () => [props.gid, props.token],
    () => void load(),
    { immediate: true },
);

onUnmounted(() => {
    controller.abort();
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <div>
                <h2>{{ title || "全部预览" }}</h2>
                <p class="muted count">
                    已加载 {{ previews.length }} 张<template v-if="total > 0">
                        / 共 {{ total }} 页</template
                    ><template v-if="loading">，继续取图中…</template>
                </p>
            </div>
            <div class="head-actions">
                <button v-if="loading" @click="stop">停止加载</button>
                <button v-else-if="stopped" @click="resume">继续加载</button>
                <RouterLink :to="{ name: 'gallery', params: { gid, token } }">返回详情</RouterLink>
            </div>
        </header>

        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="!loading && !stopped && previews.length === 0 && error === ''" class="muted">
            正在读取第一组预览…
        </p>

        <section class="grid">
            <RouterLink
                v-for="preview in previews"
                :key="preview.page"
                class="cell"
                :to="{
                    name: 'gallery-player',
                    params: { gid, token },
                    query: { page: preview.page },
                }"
            >
                <SpriteImage
                    class="thumb"
                    :src="preview.thumbUrl"
                    :width="preview.width"
                    :height="preview.height"
                    :offset-x="preview.offsetX"
                    :offset-y="preview.offsetY"
                    :alt="`第 ${preview.page} 页`"
                />
                <span class="num">{{ preview.page }}</span>
            </RouterLink>
        </section>

        <p v-if="stopped || finished" class="muted foot">
            {{ stopped ? "已停止，可继续加载" : "已到最后一页" }}
        </p>
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    color: var(--accent);
}

.count {
    margin: 4px 0 0;
    font-size: var(--font-size-md);
}

.head-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

.head-actions a {
    color: var(--accent);
    font-size: var(--font-size-md);
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
    margin-top: 16px;
}

.cell {
    position: relative;
    display: block;
    border: 1px solid var(--line);
    border-radius: 4px;
    overflow: hidden;
    transition:
        transform 0.16s cubic-bezier(0.4, 0, 0.2, 1),
        border-color 0.16s cubic-bezier(0.4, 0, 0.2, 1);
}

.cell:hover,
.cell:focus-visible {
    border-color: var(--accent);
    transform: translateY(-2px);
}

.cell:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

.cell .num {
    position: absolute;
    right: 4px;
    bottom: 4px;
    padding: 0 5px;
    font-size: var(--font-size-xs);
    color: var(--text);
    background: rgb(0 0 0 / 55%);
    border-radius: 3px;
}

.err {
    color: var(--danger);
}

.foot {
    margin-top: 14px;
    font-size: var(--font-size-md);
}

@media (prefers-reduced-motion: reduce) {
    .cell {
        transition: none;
    }

    .cell:hover,
    .cell:focus-visible {
        transform: none;
    }
}
</style>
