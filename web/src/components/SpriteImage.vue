<script setup lang="ts">
/**
 * 精灵图缩略图。上游把一页的 20 张缩略图拼成一张横向长图，格子靠背景偏移取。
 *
 * 上游的写法是「一个 200×300 的盒子 + 整张图的像素偏移」，但在详情页里一格只有几十像素宽。
 * 直接照搬像素偏移会把原图一角按 1:1 画进小格子里，因此偏移与整张图必须一起缩小。
 *
 * 做法分两层：外层是裁切窗口，尺寸照上游声明的格子；内层按格数铺开整张精灵图，再左移若干格。
 * 两层都用「原图尺寸 ÷ 格子尺寸」的比例表达，缩放随格子宽度自适应，样式里不出现上游的绝对像素。
 * 同一页的 20 格共用一个地址，预载与重试见 sprite-cache.ts，只探测一次。
 */

import { computed, onUnmounted, ref, watch } from "vue";

import { watchSprite, type SpriteResult, type SpriteStatus } from "../sprite-cache.ts";
import ImagePlaceholder from "./ImagePlaceholder.vue";

const props = defineProps<{
    /** 精灵图地址 */
    src: string;
    /** 上游声明的单格尺寸与在精灵图里的偏移 */
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    alt: string;
}>();

const status = ref<SpriteStatus>("loading");
/** 原图尺寸，缩放依据它与上游声明尺寸的比例 */
const natural = ref<{ width: number; height: number } | null>(null);

/**
 * 平移量折成百分比，并夹在 [-100%, 0]。
 * 上游给的偏移就是 background-position 的取值，本身已经是负的（第 20 格是 -3800px）。
 * 内层宽为窗口的 cols 倍，因此该值除以原图宽度即是内层自身的百分比。
 */
function shift(offset: number, total: number): number {
    if (total <= 0) {
        return 0;
    }
    return Math.max(-100, Math.min(0, (offset / total) * 100));
}

const styleVars = computed(() => {
    const vars: Record<string, string> = {};
    const size = natural.value;
    const usable = status.value === "loaded" && size !== null && size.width > 0 && size.height > 0;

    // 窗口比例：上游声明优先，声明缺失时按原图计算（旧版一页一张图的情形）
    vars["--cell-ratio"] =
        props.width > 0 && props.height > 0
            ? `${props.width} / ${props.height}`
            : usable
              ? `${size.width} / ${size.height}`
              : "2 / 3";
    if (!usable) {
        return vars;
    }

    // 上游声明缺失时认为整张图就是一格：不铺开、不偏移，整张缩放进窗口
    const known = props.width > 0 && props.height > 0;
    const cols = known ? size.width / props.width : 1;
    vars["--sprite-url"] = `url("${props.src}")`;
    vars["--sheet-width"] = `${cols * 100}%`;
    vars["--sheet-ratio"] = `${size.width} / ${size.height}`;
    vars["--sheet-shift-x"] = `${shift(props.offsetX, size.width)}%`;
    vars["--sheet-shift-y"] = `${shift(props.offsetY, size.height)}%`;
    return vars;
});

let unsubscribe: () => void = () => undefined;

function subscribe(): void {
    unsubscribe();
    // 换地址（同一格被另一本画廊复用）时先回到加载态：旧的原图尺寸不能用于新地址
    status.value = "loading";
    natural.value = null;
    unsubscribe = watchSprite(props.src, (result: SpriteResult) => {
        status.value = result.status;
        natural.value =
            result.status === "loaded" ? { width: result.width, height: result.height } : null;
    });
}

watch(() => props.src, subscribe, { immediate: true });

onUnmounted(() => {
    unsubscribe();
});
</script>

<template>
    <div
        class="sprite"
        :class="status"
        :style="styleVars"
        role="img"
        :aria-label="alt"
        :aria-busy="status === 'loading'"
    >
        <!-- 精灵图层。宽度按格数铺开，自身比例照原图，因此整张长图不会被拉伸 -->
        <div class="sheet" aria-hidden="true" />
        <ImagePlaceholder :status="status" />
    </div>
</template>

<style scoped lang="scss">
.sprite {
    position: relative;
    overflow: hidden;
    background-color: var(--placeholder-base);
    aspect-ratio: var(--cell-ratio, 2 / 3);
}

/*
 * 宽度是窗口的 cols 倍（整张横向长图平铺在这个盒子里），高度由原图比例决定。
 * 背景图铺满这一层即等于「整张图与偏移按同一个比例缩小」，再平移若干格。
 * 平移的百分比以本层自身尺寸为基准：一格正好是 1/cols，与样式里不写具体像素无关。
 */
.sheet {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--sheet-width, 100%);
    aspect-ratio: var(--sheet-ratio, 4 / 3);
    background-image: var(--sprite-url, none);
    background-repeat: no-repeat;
    background-size: 100% 100%;
    transform: translate(var(--sheet-shift-x, 0%), var(--sheet-shift-y, 0%));
}
</style>
