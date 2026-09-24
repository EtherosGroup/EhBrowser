<script setup lang="ts">
/*
 * 播放器。图片居中，下方控制栏。网页全屏时图片铺满页面，控制栏改为底部浮层，悬停才出现。
 * 翻页不等待地址解析：地址没解析出来就显示占位，翻过去立刻换页，加载在后台进行。
 * 快捷键：← → 翻页，↑ ↓ 缩放，Shift + 滚轮缩放，滚轮翻页，空格暂停或继续自动播放，Esc 退出网页全屏。
 */

import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import type { ArchiveOption } from "../../../src/api/index.ts";
import { NETWORK_PAGE_BYTES, warmCache } from "../player-cache.ts";
import { serverSession } from "../status.ts";
import type { GalleryTrack } from "../playlist.ts";
import SkeletonImage from "./SkeletonImage.vue";

/** 缩放范围与步长 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.15;
/** 滚轮翻页的节流间隔。触控板一次滑动会连发很多事件。 */
const WHEEL_IDLE_MS = 160;
/** 浮层控制栏在指针离开后多久收起。 */
const BAR_HIDE_MS = 1200;

const props = withDefaults(
    defineProps<{
        /** 第 1 页在下标 0。还没解析出地址的位置为 null */
        tracks: readonly (GalleryTrack | null)[];
        pageCount: number;
        title: string;
        startPage?: number;
        /** 本地已下载。 */
        downloaded?: boolean;
        /** 已收藏。 */
        favorited?: boolean;
        /** 缓存上限（MB），来自播放器设置。 */
        maxCacheMb?: number;
        /** 向后预加载几张。 */
        preloadCount?: number;
        /** 自动播放是否开启，以及间隔与循环，来自设置 */
        autoplayEnabled?: boolean;
        autoplayIntervalSeconds?: number;
        autoplayLoop?: boolean;
        /** 归档选项，非空时下载弹窗可用。 */
        archives?: readonly ArchiveOption[];
    }>(),
    {
        startPage: 1,
        downloaded: false,
        favorited: false,
        maxCacheMb: 512,
        preloadCount: 2,
        autoplayEnabled: false,
        autoplayIntervalSeconds: 5,
        autoplayLoop: false,
        archives: () => [],
    },
);

const emit = defineEmits<{
    /** 当前页变化，宿主据此写回进度。 */
    "update:page": [page: number];
    /** 需要这些页的地址（当前页与预加载窗口） */
    need: [pages: number[]];
    /** 自动播放的开关与参数变化，宿主写回设置。 */
    autoplay: [value: { enabled: boolean; intervalSeconds: number; loop: boolean }];
    /** 点收藏 */
    favorite: [];
    /** 点下载，宿主去拉归档选项并弹窗。 */
    download: [];
    /** 点转义到详情页 */
    detail: [];
}>();

const page = ref(Math.max(1, props.startPage));
const zoom = ref(1);
/** 网页全屏：盖住整个页面，不是浏览器全屏。 */
const fullscreen = ref(false);
/** 自动播放的暂停状态。开启自动播放后默认就在运行 */
const paused = ref(false);
/** 浮层控制栏是否可见 */
const barVisible = ref(false);
/** 指针是否停在控制栏（含它上面的设置弹层）或底部热区上。停在上面时不收起 */
const barHover = ref(false);
/** 自动播放设置弹层。 */
const tuning = ref(false);
/** 进度条是否正在拖动 */
const dragging = ref(false);

const bar = ref<HTMLElement | null>(null);
/*
 * 预热集合是模块级单例：退出画廊、换一本、来回路由、刷新页面都不会丢。
 * 记录按服务端「这一次运行」分区，服务端一重启就作废。上限跟着设置走。
 */
const warm = warmCache(props.maxCacheMb * 1024 * 1024);
let autoplayTimer: ReturnType<typeof setTimeout> | null = null;
let wheelAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const current = computed(() => props.tracks[page.value - 1] ?? null);
const currentUrl = computed(() => current.value?.url ?? "");
const percent = computed(() => (props.pageCount === 0 ? 0 : (page.value / props.pageCount) * 100));
/** 自动播放是否在运行。 */
const playing = computed(() => props.autoplayEnabled && !paused.value);

/** 需要保证已解析与已预热的页：当前页加前后窗口。 */
function windowPages(target: number): number[] {
    const pages: number[] = [];
    for (let offset = -1; offset <= props.preloadCount; offset += 1) {
        const value = target + offset;
        if (value >= 1 && value <= props.pageCount) {
            pages.push(value);
        }
    }
    return pages;
}

function requestWindow(target: number): void {
    emit("need", windowPages(target));
}

/*
 * 预热：把窗口内的地址交给浏览器提前下载。
 * 已经预热过的（含上一次进这本画廊时预热的）不重复下，超出预算的由集合自己淘汰。
 */
function warmWindow(target: number): void {
    for (const value of windowPages(target)) {
        const track = props.tracks[value - 1];
        if (track === null || track === undefined || track.url === "" || warm.has(track.url)) {
            continue;
        }
        const image = new Image();
        image.src = track.url;
        warm.touch(track.url, track.bytes > 0 ? track.bytes : NETWORK_PAGE_BYTES);
    }
}

function goTo(target: number): void {
    const clamped = Math.min(Math.max(1, Math.round(target)), Math.max(1, props.pageCount));
    if (clamped === page.value) {
        return;
    }
    page.value = clamped;
    emit("update:page", clamped);
}

function step(delta: number): void {
    goTo(page.value + delta);
}

function setZoom(value: number): void {
    zoom.value = Math.min(Math.max(MIN_ZOOM, Number(value.toFixed(2))), MAX_ZOOM);
}

function zoomBy(delta: number): void {
    setZoom(zoom.value + delta);
}

function resetZoom(): void {
    zoom.value = 1;
}

/* ---------- 自动播放 ---------- */

function clearAutoplay(): void {
    if (autoplayTimer !== null) {
        clearTimeout(autoplayTimer);
        autoplayTimer = null;
    }
}

function scheduleAutoplay(): void {
    clearAutoplay();
    if (!playing.value) {
        return;
    }
    autoplayTimer = setTimeout(
        () => {
            if (page.value >= props.pageCount) {
                if (props.autoplayLoop) {
                    goTo(1);
                } else {
                    paused.value = true;
                    return;
                }
            } else {
                step(1);
            }
            scheduleAutoplay();
        },
        Math.max(1, props.autoplayIntervalSeconds) * 1000,
    );
}

/** 中间那个 ▶/⏸：切换自动播放是否运行。尚未开启时先开启。 */
function togglePlay(): void {
    if (!props.autoplayEnabled) {
        emit("autoplay", {
            enabled: true,
            intervalSeconds: props.autoplayIntervalSeconds,
            loop: props.autoplayLoop,
        });
        paused.value = false;
        return;
    }
    paused.value = !paused.value;
}

function setAutoplay(
    patch: Partial<{ enabled: boolean; intervalSeconds: number; loop: boolean }>,
): void {
    paused.value = false;
    emit("autoplay", {
        enabled: patch.enabled ?? props.autoplayEnabled,
        intervalSeconds: patch.intervalSeconds ?? props.autoplayIntervalSeconds,
        loop: patch.loop ?? props.autoplayLoop,
    });
}

/* ---------- 交互 ---------- */

function onWheel(event: WheelEvent): void {
    if (event.shiftKey) {
        // Shift + 滚轮是按比例的缩放，与 ↑ ↓ 走同一段范围。
        event.preventDefault();
        zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
        return;
    }
    event.preventDefault();
    const now = Date.now();
    if (now - wheelAt < WHEEL_IDLE_MS) {
        return;
    }
    wheelAt = now;
    step(event.deltaY > 0 ? 1 : -1);
}

function onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
    }
    switch (event.key) {
        case "ArrowLeft": {
            step(-1);
            break;
        }
        case "ArrowRight": {
            step(1);
            break;
        }
        case "ArrowUp": {
            event.preventDefault();
            zoomBy(ZOOM_STEP);
            break;
        }
        case "ArrowDown": {
            event.preventDefault();
            zoomBy(-ZOOM_STEP);
            break;
        }
        case " ": {
            // 空格只在开启自动播放时有效，用于暂停与继续。
            if (props.autoplayEnabled) {
                event.preventDefault();
                paused.value = !paused.value;
            }
            break;
        }
        case "Escape": {
            if (fullscreen.value) {
                fullscreen.value = false;
            }
            break;
        }
        default: {
            return;
        }
    }
}

/** 进度条拖动：按下即跳转，移动时跟着走 */
function pageFromPointer(clientX: number): number {
    const element = bar.value;
    if (element === null) {
        return page.value;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1) {
        return page.value;
    }
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    return Math.max(1, Math.round(ratio * props.pageCount));
}

function onBarDown(event: PointerEvent): void {
    dragging.value = true;
    goTo(pageFromPointer(event.clientX));
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onBarMove(event: PointerEvent): void {
    if (dragging.value) {
        goTo(pageFromPointer(event.clientX));
    }
}

function onBarUp(event: PointerEvent): void {
    dragging.value = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

function showBar(): void {
    barVisible.value = true;
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

/*
 * 收起浮层控制栏：指针闲下来 BAR_HIDE_MS 后隐藏，延时避免指针擦边就消失。
 * 指针正停在控制栏或底部热区上时不排收起，否则鼠标停在按钮上也会被收走。
 */
function scheduleHideBar(): void {
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    if (barHover.value) {
        return;
    }
    hideTimer = setTimeout(() => {
        barVisible.value = false;
        hideTimer = null;
        tuning.value = false;
    }, BAR_HIDE_MS);
}

/** 指针在舞台上移动：显示控制栏并重新计时，停住不动就自动收起。 */
function onStageMove(): void {
    if (!fullscreen.value) {
        return;
    }
    showBar();
    scheduleHideBar();
}

/** 指针进入控制栏或底部热区：显示，并一直留着直到指针离开。 */
function onBarEnter(): void {
    barHover.value = true;
    showBar();
}

/** 指针离开控制栏与热区：重新排收起。 */
function onBarLeave(): void {
    barHover.value = false;
    scheduleHideBar();
}

function toggleFullscreen(): void {
    fullscreen.value = !fullscreen.value;
    if (fullscreen.value) {
        // 进入时先露一下，让用户知道控制栏在哪，随后自动收起
        showBar();
        scheduleHideBar();
    }
}

/*
 * 退出网页全屏（按钮或 Esc）时清掉浮层状态。
 * 指针可能正停在底部热区上，热区随全屏一起消失，不会再有 pointerleave 来复位。
 */
watch(fullscreen, (value) => {
    if (value) {
        return;
    }
    barHover.value = false;
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
});

watch(
    () => props.startPage,
    (value) => goTo(value),
);

watch(
    () => [page.value, props.tracks, props.preloadCount, props.pageCount],
    () => {
        requestWindow(page.value);
        warmWindow(page.value);
    },
    { immediate: true },
);

watch(
    () => [playing.value, props.autoplayIntervalSeconds, props.autoplayLoop, props.pageCount],
    () => scheduleAutoplay(),
    { immediate: true },
);

watch(
    () => props.maxCacheMb,
    (value) => {
        // 只改上限，不重建集合：重建会把跨画廊攒下来的预热记录一次清掉。
        warm.resize(Math.max(64, value) * 1024 * 1024);
        warmWindow(page.value);
    },
);

/*
 * 服务端会话到手（或换了会话）时按它恢复预热记录。
 * 深链直接进播放器时首帧还拿不到，等 refreshStatus 回来再补一次即可。
 */
watch(
    serverSession,
    (scope) => {
        if (scope === 0) {
            return;
        }
        warm.useScope(scope);
        warmWindow(page.value);
    },
    { immediate: true },
);

/** 换页把缩放复位：新的一页按原始比例查看。 */
watch(page, () => resetZoom());

onMounted(() => {
    window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown);
    clearAutoplay();
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
    }
});
</script>

<template>
    <div class="player" :class="{ full: fullscreen }">
        <!-- 网页全屏时左上角显示进度，右上角显示 AUTO -->
        <div v-if="fullscreen" class="corner left">{{ page }}/{{ pageCount }}</div>
        <div v-if="fullscreen && autoplayEnabled" class="corner right">AUTO</div>

        <div
            class="stage"
            :class="{ zoomed: zoom !== 1 }"
            @wheel="onWheel"
            @pointermove="onStageMove"
        >
            <!-- 左右翻页按钮，图标为自绘 SVG -->
            <button
                class="side prev"
                :disabled="page <= 1"
                title="上一张（←）"
                aria-label="上一张"
                @click="step(-1)"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
            </button>

            <div class="frame">
                <SkeletonImage
                    :key="currentUrl === '' ? `p${page}` : currentUrl"
                    class="sheet"
                    :style="{ transform: `scale(${zoom})` }"
                    :src="currentUrl"
                    :alt="`${title} 第 ${page} 页`"
                    eager
                    retryable
                />
            </div>

            <button
                class="side next"
                :disabled="page >= pageCount"
                title="下一张（→）"
                aria-label="下一张"
                @click="step(1)"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
            </button>

            <!--
                网页全屏时的底部热区。控制栏收起后指针移进这一条就把控制栏叫回来，
                不必先在画面上晃动鼠标。热区只在全屏时存在，且位于控制栏之下（z-index 更低）。
            -->
            <div
                v-if="fullscreen"
                class="hotzone"
                @pointerenter="onBarEnter"
                @pointerleave="onBarLeave"
            />
        </div>

        <!-- 控制栏。普通模式位于图片下方；网页全屏时浮在底部中央，悬停或指针移动时才出现。 -->
        <div
            class="controls"
            :class="{ floating: fullscreen, shown: !fullscreen || barVisible }"
            @pointerenter="onBarEnter"
            @pointerleave="onBarLeave"
        >
            <span class="count">{{ page }}/{{ pageCount }}</span>

            <div
                ref="bar"
                class="track"
                role="slider"
                :aria-valuemin="1"
                :aria-valuemax="pageCount"
                :aria-valuenow="page"
                aria-label="播放进度"
                tabindex="0"
                @pointerdown="onBarDown"
                @pointermove="onBarMove"
                @pointerup="onBarUp"
            >
                <i :style="{ width: `${percent}%` }" />
            </div>

            <button class="icon" :disabled="page <= 1" title="上一张" @click="step(-1)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
            <button
                class="icon"
                :title="playing ? '暂停自动播放' : '继续自动播放'"
                @click="togglePlay"
            >
                <svg v-if="playing" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 6v12M15 6v12" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5l11 7-11 7z" />
                </svg>
            </button>
            <button class="icon" :disabled="page >= pageCount" title="下一张" @click="step(1)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
            </button>

            <label class="auto">
                <span class="muted">自动播放</span>
                <select
                    :value="autoplayEnabled ? 'on' : 'off'"
                    @change="
                        setAutoplay({
                            enabled: ($event.target as HTMLSelectElement).value === 'on',
                        })
                    "
                >
                    <option value="off">off</option>
                    <option value="on">on</option>
                </select>
            </label>

            <div class="tune">
                <button class="icon" title="自动播放设置" @click="tuning = !tuning">
                    <!-- 设置图标取自 iconfont（与下载页左下角的设置入口同一个字形），不再自绘 -->
                    <i class="iconfont icon-setting" aria-hidden="true" />
                </button>
                <div v-if="tuning" class="popover">
                    <label>
                        <span class="muted">间隔（秒）</span>
                        <input
                            type="number"
                            min="1"
                            max="120"
                            :value="autoplayIntervalSeconds"
                            @change="
                                setAutoplay({
                                    intervalSeconds: Number(
                                        ($event.target as HTMLInputElement).value,
                                    ),
                                })
                            "
                        />
                    </label>
                    <label>
                        <span class="muted">播完循环</span>
                        <select
                            :value="autoplayLoop ? 'on' : 'off'"
                            @change="
                                setAutoplay({
                                    loop: ($event.target as HTMLSelectElement).value === 'on',
                                })
                            "
                        >
                            <option value="off">off</option>
                            <option value="on">on</option>
                        </select>
                    </label>
                </div>
            </div>

            <label class="auto">
                <span class="muted">翻译</span>
                <select disabled title="图片翻译尚未实现">
                    <option>off</option>
                </select>
            </label>
            <button class="icon" title="图片翻译设置：功能尚未实现" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h10M9 4v2M6 6c0 4 3 7 7 8M14 6c0 4-3 7-7 8" />
                    <path d="M13 19l3-7 3 7M14 17h4" />
                </svg>
            </button>

            <button
                class="icon heart"
                :class="{ on: favorited }"
                :title="favorited ? '已收藏' : '收藏此画廊'"
                @click="$emit('favorite')"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                        d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.4 12 20 12 20z"
                    />
                </svg>
            </button>

            <button
                class="icon"
                :class="{ on: downloaded }"
                :title="downloaded ? '已下载' : '下载此画廊'"
                @click="$emit('download')"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4v10M8 10.5l4 4 4-4M5 19h14" />
                </svg>
            </button>

            <button
                class="icon zoom"
                :title="`重置缩放（当前 ${Math.round(zoom * 100)}%）`"
                @click="resetZoom"
            >
                {{ Math.round(zoom * 100) }}%
            </button>

            <button class="icon" title="返回详情" @click="$emit('detail')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 6l-6 6 6 6" /></svg>
            </button>

            <!-- 网页全屏开关：图标是四个角。 -->
            <button
                class="icon"
                :title="fullscreen ? '退出网页全屏（Esc）' : '网页全屏'"
                @click="toggleFullscreen"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
.player {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.player.full {
    position: fixed;
    inset: 0;
    z-index: var(--z-player);
    gap: 0;
    background: var(--bg);
}

.corner {
    position: absolute;
    z-index: 2;
    padding: 6px 10px;
    color: var(--text);
    font-size: var(--font-size-lg);
    background: rgb(0 0 0 / 45%);
    border-radius: 4px;
    pointer-events: none;
}

.corner.left {
    top: 14px;
    left: 16px;
}

.corner.right {
    top: 14px;
    right: 16px;
    color: var(--ok);
    letter-spacing: 0.08em;
}

.stage {
    position: relative;
    display: grid;
    grid-template-columns: 56px 1fr 56px;
    align-items: center;
    gap: 8px;
    min-height: 320px;
}

.player.full .stage {
    height: 100%;
    grid-template-columns: 68px 1fr 68px;
}

/* 网页全屏时的底部热区：指针移进来就显示控制栏，见 onBarEnter */
.hotzone {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 90px;
    z-index: 1;
}

.frame {
    display: grid;
    place-items: center;
    overflow: hidden;
    min-height: 0;
}

/* 缩放走 transform，不动布局，也不重新解码。 */
.sheet {
    width: 100%;
    height: 74vh;
    border: 1px solid var(--line);
    border-radius: 6px;
    --skeleton-fit: contain;
    transition: transform 120ms ease-out;
}

.player.full .sheet {
    height: calc(100vh - 8px);
    border: none;
    border-radius: 0;
}

.side {
    display: grid;
    place-items: center;
    height: 56px;
    padding: 0;
    color: var(--text);
    background: rgb(0 0 0 / 35%);
    border-color: transparent;
    border-radius: 50%;
}

.side svg {
    width: 26px;
    height: 26px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.side:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
}

/* 控制栏：普通模式位于图片下方，网页全屏时浮在底部中央 */
.controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.controls.floating {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    margin: 0 auto;
    width: max-content;
    max-width: calc(100% - 32px);
    z-index: 3;
    background: rgb(20 22 27 / 88%);
    box-shadow: 0 12px 32px rgb(0 0 0 / 55%);
    backdrop-filter: blur(6px);
    opacity: 0;
    transform: translateY(14px);
    transition:
        opacity 180ms ease,
        transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1);
    pointer-events: none;
}

.controls.floating.shown {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
    bottom: 14px;
}

.count {
    font-size: var(--font-size-md);
    color: var(--muted);
    white-space: nowrap;
}

.track {
    position: relative;
    flex: 1 1 160px;
    min-width: 120px;
    height: 6px;
    background: var(--placeholder-track);
    border-radius: 3px;
    cursor: pointer;
    touch-action: none;
}

.track i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
}

.icon {
    display: grid;
    place-items: center;
    min-width: 32px;
    height: 30px;
    padding: 0 6px;
    font-size: var(--font-size-sm);
}

.icon svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 图标字体。大小与同一排的 SVG 相当，颜色跟随按钮（hover 时一起变主色） */
.icon .iconfont {
    font-size: var(--font-size-lg);
}

.icon.on {
    color: var(--danger);
    border-color: var(--danger);
}

.icon.heart.on svg {
    fill: currentcolor;
}

.auto {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: var(--font-size-sm);
}

.auto select {
    width: auto;
    padding: 3px 4px;
    font-size: var(--font-size-sm);
}

.tune {
    position: relative;
}

.popover {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 4;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    min-width: 180px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    box-shadow: 0 16px 40px rgb(0 0 0 / 55%);
}

.popover label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
}

.popover input,
.popover select {
    width: 90px;
}

.zoom {
    font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
    .controls.floating,
    .sheet {
        transition: none;
    }
}
</style>
