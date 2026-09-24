<script setup lang="ts">
/*
 * 结果网格。搜索、排行榜、本地画廊、收藏共用同一份。
 *
 * 数据是分组形式：每组一个标题加一串画廊，搜索时只有一组。
 *
 * 卡片 hover 0.5 秒后展开预览，展开区盖住这张卡片。进入与离开按 pointermove 的落点判断，
 * 不使用 mouseenter / mouseleave：预览区会盖住卡片，用后者时展开的瞬间会收到一次离开事件。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRouter, type RouteLocationRaw } from "vue-router";

import type { GallerySummary } from "../../../src/api/index.ts";
import {
    easeInCubic,
    easeOutCubic,
    prefersReducedMotion,
    tween,
    type Tween,
} from "../animation.ts";
import {
    contentAlpha,
    handoff,
    morphTransform,
    poppedPlacement,
    PREVIEW_GAP,
    PREVIEW_PADDING,
    previewBox,
    previewThumbWidth,
    POPPED,
    type Box,
    type Handoff,
} from "../card-preview.ts";
import type { GalleryGroup } from "../gallery-groups.ts";
import { categoryLabel, tagParts } from "../translation.ts";
import SkeletonImage from "./SkeletonImage.vue";

/** 指针在一张卡片上停留多久才展开预览 */
const HOVER_DELAY_MS = 500;
/** 卡片浮起的时长，以及预览展开的时长 */
const POP_MS = 180;
const OPEN_MS = 320;
/** 退场动画的时长。指针已经离开，因此比展开更短 */
const CLOSE_MS = 160;
/** 预览中最多显示多少个标签 */
const PREVIEW_TAG_LIMIT = 18;

const props = withDefaults(
    defineProps<{
        groups: readonly GalleryGroup[];
        /** 卡片的跳转目标。由调用方决定进详情还是进阅读器 */
        to: (item: GallerySummary) => RouteLocationRaw;
        /** select 模式下点卡片改为选中，不再跳转，也不展开悬浮预览 */
        mode?: "browse" | "select";
        /** 多选模式下的选中集合，配合 v-model:selected */
        selected?: readonly number[];
        /** 每行几个。不传按最小宽度自适应；留给「调整排列尺寸」的按钮 */
        columns?: number;
        /** 缩略图高度（像素） */
        thumbHeight?: number;
        /** 一组里没有内容时显示的说明 */
        emptyText?: string;
        /**
         * 暂停悬浮预览。搜索页在输入框有焦点时打开它：这时用户正用鼠标去点输入框下方的
         * 标签建议，指针从结果区上经过不该弹出预览。暂停期间卡片也不浮起。
         */
        previewPaused?: boolean;
    }>(),
    {
        mode: "browse",
        selected: () => [],
        columns: 0,
        thumbHeight: 220,
        emptyText: "",
        previewPaused: false,
    },
);

const emit = defineEmits<{ "update:selected": [selected: number[]] }>();

const router = useRouter();

/** 指针停留的卡片。只用于浮起时的描边与投影 */
const hoveredGid = ref<number | null>(null);
/** 正在展开的预览内容，null 表示没有展开 */
const previewItem = ref<GallerySummary | null>(null);

const previewEl = ref<HTMLElement | null>(null);
const previewInnerEl = ref<HTMLElement | null>(null);

/* 悬浮预览不使用 CSS 过渡，进度全部在 JS 中计算：
   展开的预览区盖在指针停留的那张卡片上，起点与卡片的浮起状态一致，
   指针随时可能移开，动画要能从当前帧反向播放，因此状态与进度都保存在 JS 中 */

/** 指针所在的卡片元素 */
let hoverCard: HTMLElement | null = null;
/** 预览正在展开或已展开的卡片元素 */
let openCard: HTMLElement | null = null;
/** 被 Esc 关闭的那张卡片。指针仍停在它上面时不再自动重开 */
let dismissed: HTMLElement | null = null;
/** 展开用的几何：起点差值来自卡片，终点来自预览区。退场时按同一份几何反向播放 */
let openState: { from: Handoff; target: Box } | null = null;
/** 展开进度。0 表示贴在卡片上，1 表示到达预览区的落位 */
let openProgress = 0;
/** 是否正在播放退场动画。指针仍在移动时该动画照常继续，不因新的落点判断被中断 */
let closing = false;
/** 每张卡片的浮起进度。指针快速划过时各卡片分别回位，不会停在中间状态 */
const pops = new Map<HTMLElement, { value: number; tween: Tween | null }>();

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let activeTween: Tween | null = null;
let pointer = { x: 0, y: 0 };
let frameHandle = 0;
/** 组件是否已卸载。已排入的帧与计时在卸载后不再修改状态 */
let disposed = false;

const allItems = computed(() => props.groups.flatMap((group) => group.items));
/** 指针落点反查用。pointermove 每帧查询一次，按 gid 查找条目 */
const itemsByGid = computed(() => new Map(allItems.value.map((item) => [item.gid, item])));
const gridStyle = computed(() => ({
    "--thumb-height": `${props.thumbHeight}px`,
    ...(props.columns > 0
        ? { gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }
        : {}),
}));
const selectedGids = computed(() => new Set(props.selected));

function isSelected(item: GallerySummary): boolean {
    return selectedGids.value.has(item.gid);
}

/** 多选模式下点卡片即切换选中。浏览模式下由 RouterLink 跳转 */
function onCardClick(item: GallerySummary): void {
    resetPreview();
    if (props.mode !== "select") {
        return;
    }
    const next = [...props.selected];
    const at = next.indexOf(item.gid);
    if (at === -1) {
        next.push(item.gid);
    } else {
        next.splice(at, 1);
    }
    emit("update:selected", next);
}

/* ---------- 悬浮预览 ---------- */

/** 卡片的浮起目标值。指针位于该卡片上，或该卡片的预览正在展开时为 1，否则为 0 */
function popTarget(card: HTMLElement): number {
    return hoverCard === card || openCard === card ? 1 : 0;
}

function applyPop(card: HTMLElement, value: number): void {
    if (value <= 0.0001) {
        card.style.transform = "";
        return;
    }
    const scale = 1 + (POPPED.scale - 1) * value;
    card.style.transform =
        `translateY(${-POPPED.lift * value}px) ` +
        `rotate(${POPPED.rotate * value}deg) scale(${scale})`;
}

/** 浮起或回位。从中间打断时按剩余距离缩短时长，避免后半段变慢 */
function setPop(card: HTMLElement | null, duration = POP_MS): void {
    if (card === null) {
        return;
    }
    let state = pops.get(card);
    if (state === undefined) {
        state = { value: 0, tween: null };
        pops.set(card, state);
    }
    const current = state;
    current.tween?.cancel();
    current.tween = null;
    const target = popTarget(card);
    const from = current.value;
    if (prefersReducedMotion() || duration <= 0 || Math.abs(target - from) < 0.001) {
        current.value = target;
        applyPop(card, target);
        return;
    }
    current.tween = tween({
        duration: duration * Math.abs(target - from),
        easing: target > from ? easeOutCubic : easeInCubic,
        onUpdate: (t): void => {
            current.value = from + (target - from) * t;
            applyPop(card, current.value);
        },
        onDone: (): void => {
            current.value = target;
            current.tween = null;
            applyPop(card, target);
        },
    });
}

/**
 * 卡片的布局盒。getBoundingClientRect 量到的是浮起与倾斜之后的包围盒，
 * 这里把浮起的分量换算回去，得到不受 transform 影响的落位。
 */
function layoutBox(card: HTMLElement): Box {
    const rect = card.getBoundingClientRect();
    const value = pops.get(card)?.value ?? 0;
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2 + POPPED.lift * value;
    return {
        left: centreX - card.offsetWidth / 2,
        top: centreY - card.offsetHeight / 2,
        width: card.offsetWidth,
        height: card.offsetHeight,
    };
}

/** 视口尺寸按布局视口计算。position: fixed 的参照是布局视口，用 innerWidth 会把滚动条的几像素算进来 */
function viewportSize(): { width: number; height: number } {
    const root = document.documentElement;
    return { width: root.clientWidth, height: root.clientHeight };
}

/** 按卡片当前位置计算终点几何，以及贴合卡片的起点差值 */
function measure(card: HTMLElement): { from: Handoff; target: Box } {
    const box = layoutBox(card);
    const target = previewBox(box, viewportSize());
    const value = pops.get(card)?.value ?? 0;
    return { from: handoff(poppedPlacement(box, value), target), target };
}

/** 设置预览区的落位与内部尺寸。首帧之前先隐藏，几何写入完成后再显示，避免在左上角闪现 */
function place(element: HTMLElement, state: { from: Handoff; target: Box }): void {
    element.style.left = `${state.target.left}px`;
    element.style.top = `${state.target.top}px`;
    element.style.width = `${state.target.width}px`;
    element.style.height = `${state.target.height}px`;
    // 缩略图按竖图比例占满内容高度，宽度由此算出，整张图片可以放进格子
    element.style.setProperty("--thumb-w", `${previewThumbWidth(state.target.height)}px`);
    element.style.setProperty("--preview-pad", `${PREVIEW_PADDING}px`);
    element.style.setProperty("--preview-gap", `${PREVIEW_GAP}px`);
    element.style.visibility = "visible";
}

/** 每帧只写 transform 与内容透明度。左距、顶距与尺寸在一次展开中是常量 */
function paint(state: { from: Handoff; target: Box }, progress: number): void {
    const element = previewEl.value;
    if (element === null) {
        return;
    }
    element.style.transform = morphTransform(state.from, progress);
    const inner = previewInnerEl.value;
    if (inner !== null) {
        inner.style.opacity = String(contentAlpha(progress));
    }
}

function clearHoverTimer(): void {
    if (hoverTimer !== null) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
    }
}

function itemOf(card: HTMLElement): GallerySummary | null {
    const gid = Number(card.dataset["gid"]);
    return Number.isFinite(gid) ? (itemsByGid.value.get(gid) ?? null) : null;
}

/** 安排停留计时，到时展开预览。同一张卡片重复安排时只保留最后一次 */
function armTimer(card: HTMLElement): void {
    clearHoverTimer();
    const item = itemOf(card);
    if (item === null) {
        return;
    }
    hoverTimer = setTimeout(() => {
        hoverTimer = null;
        void openPreview(item, card);
    }, HOVER_DELAY_MS);
}

/** 指针所在的卡片发生变化时调用。计时与浮起都在这里统一处理，不在别处重复判断 */
function setHover(card: HTMLElement | null): void {
    // 暂停期间一律当作指针不在卡片上：不浮起、不计时、不展开
    const target = props.previewPaused ? null : card;
    const previous = hoverCard;
    if (previous === target) {
        // 同一张卡片：计时若已被清掉（例如上一张卡片的预览刚退场完），需要重新安排，
        // 否则指针停在这张卡片上不会再展开。被 Esc 关闭的那张卡片除外，需移开后再回来
        if (target !== null && target !== dismissed && target !== openCard && hoverTimer === null) {
            armTimer(target);
        }
        return;
    }
    hoverCard = target;
    clearHoverTimer();
    if (target !== dismissed) {
        dismissed = null;
    }
    hoveredGid.value = target === null ? null : Number(target.dataset["gid"]);
    if (target === openCard) {
        // 指针回到了正在退场的那张卡片上，此时继续展开
        if (closing) {
            resumePreview();
        }
    } else if (target !== null) {
        armTimer(target);
    }
    setPop(previous);
    setPop(target);
}

/**
 * 每帧最多判断一次指针的落点。展开的预览区盖在卡片上，只有按几何判断才能区分指针在预览区上还是在卡片上。
 * 指针一离开卡片与预览区就立即开始退场，这里不安排延时：否则鼠标持续移动时
 * 每次回调都会把延时向后推，预览无法收起。
 */
function resolvePointer(): void {
    frameHandle = 0;
    if (disposed) {
        return;
    }
    const under = document.elementFromPoint(pointer.x, pointer.y);
    const element = previewEl.value;
    if (under !== null && element !== null && element.contains(under)) {
        // 指针回到正在退场的预览区上，中断退场并继续展开
        if (closing) {
            resumePreview();
        }
        return;
    }
    const card = under?.closest<HTMLElement>("[data-gid]") ?? null;
    const valid = card !== null && itemOf(card) !== null ? card : null;
    setHover(valid);
    if (openCard !== null && valid !== openCard) {
        closePreview();
    }
}

function onPointerMove(event: PointerEvent): void {
    pointer = { x: event.clientX, y: event.clientY };
    if (frameHandle !== 0) {
        return;
    }
    frameHandle = requestAnimationFrame(resolvePointer);
}

/** 展开预览。起点取卡片当前的浮起状态，因此与卡片的浮起属于同一段运动 */
async function openPreview(item: GallerySummary, card: HTMLElement): Promise<void> {
    if (disposed || hoverCard !== card) {
        // 计时期间指针已经移开
        return;
    }
    if (openCard === card) {
        // 已经在展开或正在退场：从当前进度继续，不从头开始
        if (closing) {
            resumePreview();
        }
        return;
    }
    dropPreview();
    openCard = card;
    const state = measure(card);
    openState = state;
    openProgress = 0;
    previewItem.value = item;
    await nextTick();
    const element = previewEl.value;
    if (element === null || disposed || openCard !== card) {
        return;
    }
    place(element, state);
    paint(state, 0);
    activeTween?.cancel();
    if (prefersReducedMotion()) {
        openProgress = 1;
        paint(state, 1);
        return;
    }
    activeTween = tween({
        duration: OPEN_MS,
        easing: easeOutCubic,
        onUpdate: (t): void => {
            openProgress = t;
            paint(state, t);
        },
        onDone: (): void => {
            activeTween = null;
            openProgress = 1;
            paint(state, 1);
        },
    });
}

/**
 * 开始退场：缩回卡片上，内容先淡出。
 * 指针一离开就调用，不安排延时。重复调用只处理第一次，动画开始后不会被后续的落点判断
 * 打断或重排，因此鼠标持续移动时也能完成退场。
 */
function closePreview(): void {
    if (closing) {
        return;
    }
    const state = openState;
    if (openCard === null || state === null || previewEl.value === null) {
        dropPreview();
        return;
    }
    activeTween?.cancel();
    activeTween = null;
    const from = openProgress;
    if (prefersReducedMotion() || from <= 0.001) {
        dropPreview();
        return;
    }
    closing = true;
    activeTween = tween({
        // 从中间开始退场时只播放剩余距离
        duration: CLOSE_MS * from,
        easing: easeInCubic,
        onUpdate: (t): void => {
            openProgress = from * (1 - t);
            paint(state, openProgress);
        },
        onDone: (): void => {
            activeTween = null;
            dropPreview();
        },
    });
}

/** 退场途中指针回到这张卡片或预览区上时，从当前进度继续展开 */
function resumePreview(): void {
    const state = openState;
    if (!closing || openCard === null || state === null || previewEl.value === null) {
        return;
    }
    activeTween?.cancel();
    activeTween = null;
    closing = false;
    const from = openProgress;
    if (prefersReducedMotion() || from >= 1) {
        openProgress = 1;
        paint(state, 1);
        return;
    }
    activeTween = tween({
        duration: OPEN_MS * (1 - from),
        easing: easeOutCubic,
        onUpdate: (t): void => {
            openProgress = from + (1 - from) * t;
            paint(state, openProgress);
        },
        onDone: (): void => {
            activeTween = null;
            openProgress = 1;
            paint(state, 1);
        },
    });
}

/** 立即收起并清理状态，不播放动画。跳转、换页、滚动、卸载都调用这里 */
function dropPreview(): void {
    activeTween?.cancel();
    activeTween = null;
    const previous = openCard;
    openCard = null;
    openState = null;
    openProgress = 0;
    closing = false;
    previewItem.value = null;
    if (previous !== null) {
        setPop(previous, 0);
    }
}

/** 连同停留计时一起清除。用于已经跳转、换页、滚动、卸载的场景，这些场景下指针停在哪里都不应再展开 */
function resetPreview(): void {
    clearHoverTimer();
    dropPreview();
}

/** 清除所有卡片的浮起状态。更换结果时卡片已不在文档中，行内样式与进度一并丢弃 */
function resetPops(): void {
    for (const [card, state] of pops) {
        state.tween?.cancel();
        card.style.transform = "";
    }
    pops.clear();
    hoverCard = null;
    hoveredGid.value = null;
}

/** 展开期间发生滚动时卡片与预览的相对位置会变化，因此直接收回，不做位置跟随 */
function onScroll(event: Event): void {
    const element = previewEl.value;
    if (element !== null && event.target instanceof Node && element.contains(event.target)) {
        // 预览区内部滚动标签不属于页面滚动
        return;
    }
    resetPreview();
    setHover(null);
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
        // 记录这张卡片：指针仍停在它上面时不再自动重开，移开后再回来才重新计时
        dismissed = hoverCard;
        closePreview();
    }
}

function onCardFocus(event: FocusEvent): void {
    setHover(event.currentTarget as HTMLElement | null);
}

function onCardBlur(): void {
    setHover(null);
    closePreview();
}

/** 指针离开窗口时调用，收起预览与浮起状态 */
function onPointerLeaveWindow(): void {
    setHover(null);
    closePreview();
}

/** 点击预览区时跳转到这张卡片的目标地址 */
function openTarget(item: GallerySummary): void {
    resetPreview();
    void router.push(props.to(item));
}

watch(
    () => props.groups,
    () => {
        resetPreview();
        resetPops();
    },
);

/*
 * 暂停开关打开时立即收起：常见的情形是用户把鼠标停在某张卡片上、预览刚展开，
 * 然后点进搜索框开始输入——此时指针没有移动，落点判断不会再跑，得由这里收尾。
 */
watch(
    () => props.previewPaused,
    (paused) => {
        if (!paused) {
            return;
        }
        setHover(null);
        closePreview();
    },
);

onMounted(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointermove", onPointerMove);
    // 滚动事件不冒泡，因此用捕获阶段接收任意滚动容器的滚动
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    // 指针离开窗口时不会触发 pointermove，因此单独处理一次
    document.addEventListener("mouseleave", onPointerLeaveWindow);
});

onUnmounted(() => {
    disposed = true;
    if (frameHandle !== 0) {
        cancelAnimationFrame(frameHandle);
        frameHandle = 0;
    }
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("mouseleave", onPointerLeaveWindow);
    resetPreview();
    resetPops();
});
</script>

<template>
    <div class="groups">
        <section v-for="(group, index) in groups" :key="`${index}-${group.title}`" class="group">
            <h3 v-if="group.title !== ''" class="group-title">{{ group.title }}</h3>
            <p v-if="group.items.length === 0 && emptyText !== ''" class="muted empty">
                {{ emptyText }}
            </p>

            <div class="cards" :style="gridStyle">
                <!-- 进入与离开卡片都由 pointermove 按落点判断。预览区会盖住卡片，
                     用 mouseenter / mouseleave 会在预览展开的瞬间收到一次离开事件 -->
                <component
                    :is="mode === 'select' ? 'button' : RouterLink"
                    v-for="item in group.items"
                    :key="item.gid"
                    class="card"
                    :class="{ popped: hoveredGid === item.gid, picked: isSelected(item) }"
                    :data-gid="item.gid"
                    :type="mode === 'select' ? 'button' : undefined"
                    :to="mode === 'select' ? undefined : to(item)"
                    :aria-pressed="mode === 'select' ? isSelected(item) : undefined"
                    @focus="onCardFocus"
                    @blur="onCardBlur"
                    @click="onCardClick(item)"
                >
                    <SkeletonImage class="thumb" :src="item.thumbUrl" :alt="item.title" />
                    <div class="meta">
                        <div class="title">{{ item.title }}</div>
                        <div class="sub muted">
                            {{ categoryLabel(item.category) }} · {{ item.pageCount }} 页 · ★
                            {{ item.rating }}
                        </div>
                    </div>
                </component>
            </div>
        </section>
    </div>

    <!-- 停留后展开的预览。位置与变换由 JS 每帧写入，属于视觉增强，
         无障碍树中的对应内容由卡片链接承担，因此整体对辅助技术隐藏 -->
    <Teleport to="body">
        <div
            v-if="previewItem"
            ref="previewEl"
            class="preview-card"
            aria-hidden="true"
            @click="openTarget(previewItem)"
        >
            <div ref="previewInnerEl" class="preview-inner">
                <SkeletonImage
                    class="preview-thumb"
                    :src="previewItem.thumbUrl"
                    :alt="previewItem.title"
                    eager
                />
                <div class="preview-body">
                    <div class="preview-title">{{ previewItem.title }}</div>
                    <div class="preview-rating">
                        <span class="score">★ {{ previewItem.rating }}</span>
                        <span class="muted">
                            {{ categoryLabel(previewItem.category) }} ·
                            {{ previewItem.pageCount }} 页
                        </span>
                    </div>
                    <div class="preview-tags">
                        <span
                            v-for="tag in previewItem.tags.slice(0, PREVIEW_TAG_LIMIT)"
                            :key="tag"
                            class="chip"
                        >
                            <span v-if="tagParts(tag).namespace" class="ns">
                                {{ tagParts(tag).namespace }}:
                            </span>
                            {{ tagParts(tag).name }}
                        </span>
                        <span v-if="previewItem.tags.length > PREVIEW_TAG_LIMIT" class="muted more">
                            还有 {{ previewItem.tags.length - PREVIEW_TAG_LIMIT }} 个标签
                        </span>
                    </div>
                    <div class="preview-hint muted">点击进入</div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
.group + .group {
    margin-top: 24px;
}

.group-title {
    margin: 0 0 10px;
    font-size: var(--font-size-lg);
    color: var(--accent);
}

.empty {
    margin: 0;
    font-size: var(--font-size-md);
}

.cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
}

.card {
    display: block;
    width: 100%;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    text-decoration: none;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    // 位移与缩放由 JS 逐帧写入 transform，这里只过渡描边与投影。
    // 缓动曲线是 easeOutCubic 的贝塞尔近似，与 JS 中的浮起时长一致，两者同时结束
    transition:
        box-shadow 0.18s cubic-bezier(0.215, 0.61, 0.355, 1),
        border-color 0.18s cubic-bezier(0.215, 0.61, 0.355, 1);
}

.card.popped,
.card:hover {
    border-color: var(--accent);
    box-shadow: 0 12px 30px rgb(0 0 0 / 45%);
    z-index: var(--z-card);
}

.card.picked {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}

.card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

.thumb {
    width: 100%;
    height: var(--thumb-height, 220px);
}

.meta {
    padding: 8px 10px;
}

.title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--font-size-md);
}

.sub {
    font-size: var(--font-size-sm);
    margin-top: 4px;
}

/*
 * 展开的预览区。位置、尺寸与 transform 全部由 JS 写入，
 * 因此这里不设过渡与动画：起始帧即贴在卡片上，中途打断也从当前帧继续
 */
.preview-card {
    position: fixed;
    z-index: var(--z-overlay);
    // 首帧之前先隐藏，JS 写完几何后再显示，避免在左上角闪现
    visibility: hidden;
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 8px;
    box-shadow: 0 20px 60px rgb(0 0 0 / 55%);
    cursor: pointer;
    transform-origin: center;
    will-change: transform;
}

/* 左列宽度由 JS 按竖图比例算出并写入 --thumb-w，与 card-preview.ts 的换算一致。
   行高固定为 100%，缩略图的 height: 100% 因此有确定的参照，不受内容高度影响 */
.preview-inner {
    display: grid;
    grid-template-columns: var(--thumb-w, 200px) 1fr;
    grid-template-rows: 100%;
    gap: var(--preview-gap, 14px);
    height: 100%;
    padding: var(--preview-pad, 14px);
    box-sizing: border-box;
}

/* 竖图整张放入格子：比例与格子一致时正好铺满，宽图只缩放不裁剪 */
.preview-thumb {
    width: 100%;
    height: 100%;
    border-radius: 4px;
    --skeleton-fit: contain;
}

.preview-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
}

.preview-title {
    font-size: var(--font-size-base);
    color: var(--accent);
    font-weight: 600;
    // 标题过长时不会挤走下方的标签
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.preview-rating {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    font-size: var(--font-size-lg);
}

.preview-rating .score {
    color: var(--ok);
}

.preview-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-content: flex-start;
    overflow: auto;
}

.preview-tags .chip {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: var(--font-size-sm);
}

.preview-tags .ns {
    color: var(--muted);
}

.preview-tags .more {
    font-size: var(--font-size-sm);
}

.preview-hint {
    margin-top: auto;
    font-size: var(--font-size-sm);
}
</style>
