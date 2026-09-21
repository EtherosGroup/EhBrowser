<script setup lang="ts">
/*
 * 带占位层的图片。上游图片经代理拉取，等待时间明显，加载状态由 ImagePlaceholder 表达
 * 容器用 aspect-ratio 预留高度，图片加载完成只做淡入，不改变布局尺寸
 * src 为空表示地址尚未取到，此时只显示占位层
 */

import { computed, ref, watch } from "vue";

import ImagePlaceholder from "./ImagePlaceholder.vue";

const props = withDefaults(
    defineProps<{
        src: string;
        alt: string;
        /** 预留宽高比，图片尺寸未知时用它占位 */
        ratio?: string;
        /** 首屏图片避开懒加载 */
        eager?: boolean;
        /** 失败时提供重试入口。容器本身是链接或按钮时不应启用 */
        retryable?: boolean;
    }>(),
    { ratio: "4 / 3", eager: false, retryable: false },
);

type Status = "loading" | "loaded" | "error";

const status = ref<Status>("loading");
/** 已换过的地址次数，既用于自动重试也用于手动重试 */
const attempts = ref(0);
/** 加载完成后的真实比例，替换预估比例 */
const naturalRatio = ref("");

const resolved = computed(() => {
    if (props.src === "") {
        return "";
    }
    if (attempts.value === 0) {
        return props.src;
    }
    const separator = props.src.includes("?") ? "&" : "?";
    return `${props.src}${separator}ehb-retry=${attempts.value}`;
});

const styleVars = computed(() => ({
    "--skeleton-ratio": props.ratio,
    ...(naturalRatio.value === "" ? {} : { "--media-ratio": naturalRatio.value }),
}));

function onLoad(event: Event): void {
    const image = event.target as HTMLImageElement;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        naturalRatio.value = `${image.naturalWidth} / ${image.naturalHeight}`;
    }
    status.value = "loaded";
}

/** 更换地址重新请求。地址带递增参数，避免浏览器把上一次的失败记在同一个地址上 */
function retry(): void {
    attempts.value += 1;
    status.value = "loading";
}

function onError(): void {
    // 代理偶发失败，先自动更换地址重试一次，仍然失败时才把重试入口交给用户
    if (attempts.value === 0 && props.src !== "") {
        retry();
        return;
    }
    status.value = "error";
}

watch(
    () => props.src,
    () => {
        attempts.value = 0;
        naturalRatio.value = "";
        status.value = "loading";
    },
);
</script>

<template>
    <div class="skeleton" :class="status" :style="styleVars" :aria-busy="status === 'loading'">
        <img
            v-if="resolved !== ''"
            :src="resolved"
            :alt="alt"
            :loading="eager ? 'eager' : 'lazy'"
            decoding="async"
            @load="onLoad"
            @error="onError"
        />
        <ImagePlaceholder :status="status" :retryable="retryable" @retry="retry" />
    </div>
</template>

<style scoped lang="scss">
.skeleton {
    position: relative;
    display: block;
    overflow: hidden;
    background: var(--placeholder-base);
    // 真实比例优先，其次为调用方传入的比例，最后取兜底值
    aspect-ratio: var(--media-ratio, var(--skeleton-ratio, 4 / 3));
}

/* 图片始终位于下层，淡出由占位层完成，因此这里不再淡入 */
.skeleton img {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: var(--skeleton-fit, cover);
}
</style>
