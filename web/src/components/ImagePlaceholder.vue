<script setup lang="ts">
/*
 * 图片占位层，SkeletonImage 与 SpriteImage 共用。
 * 只有两层：一层底色，加底部一条进度条。没有扫光，也没有循环动画。
 * 进度条按已等待的时长推进，30 秒走到 90% 就停住。图片由浏览器直接向上游获取（跨域、没有 CORS），
 * 真正的字节进度读不到，因此这条进度条只表达「仍在等待」，走到头的那一下留给加载完成。
 * 等待超过 3s 补一句文字，久等时给出解释；失败则换成图标加说明，调用方允许时再给重试入口。
 */

import { onUnmounted, ref, watch } from "vue";

/** 超过这个时长算久等，补一句文字说明 */
const SLOW_AFTER_MS = 3000;

const props = withDefaults(
    defineProps<{
        status: "loading" | "loaded" | "error";
        /** 失败时给出重试入口。容器本身是链接或按钮时不启用，按钮不能嵌套在其中 */
        retryable?: boolean;
        /** 失败说明 */
        errorText?: string;
    }>(),
    { retryable: false, errorText: "加载失败" },
);

const emit = defineEmits<{ retry: [] }>();

/** 是否已判定为久等 */
const slow = ref(false);
let slowTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
    if (slowTimer !== null) {
        clearTimeout(slowTimer);
        slowTimer = null;
    }
}

/** 按当前状态重排计时。状态变化时重新计时，不残留上一轮的定时器 */
function schedule(): void {
    clearTimer();
    if (props.status !== "loading") {
        slow.value = false;
        return;
    }
    slowTimer = setTimeout(() => {
        slow.value = true;
    }, SLOW_AFTER_MS);
}

watch(() => props.status, schedule, { immediate: true });

onUnmounted(clearTimer);
</script>

<template>
    <div class="veil" :class="status">
        <p v-if="slow && status === 'loading'" class="slow" aria-hidden="true">仍在加载…</p>

        <div v-if="status === 'error'" class="failure">
            <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                <path d="M3.6 16.2 8.4 11l4 4.2 2.6-2.4 5.4 5" />
                <path d="M4.4 4.2 19.6 19.8" />
            </svg>
            <span class="label">{{ errorText }}</span>
            <button
                v-if="retryable"
                type="button"
                class="retry"
                title="重新加载图片"
                @click="emit('retry')"
            >
                重试
            </button>
        </div>

        <!-- 进度条只出现在加载态，失败态换成说明与重试 -->
        <div v-else class="bar" aria-hidden="true"><i /></div>
    </div>
</template>

<style scoped lang="scss">
.veil {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    // 占位层铺自己的底色，父级只负责预留尺寸与裁切
    background: var(--placeholder-base);
    // 容器查询让格子里的小图自动减到只剩底色
    container-type: inline-size;
    // 加载中不拦截下层交互，只有失败态需要能点到重试按钮
    pointer-events: none;
    transition: opacity 220ms cubic-bezier(0.4, 0, 0.2, 1);
}

// 图片已在下一层渲染完成，占位层淡出即可显示图片
.veil.loaded {
    opacity: 0;
}

.veil.error {
    pointer-events: auto;
}

/* 进度条：只动 transform，不触发布局，也不做循环动画 */
.bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 3px;
    background: var(--placeholder-track);
}

.bar i {
    display: block;
    height: 100%;
    background: var(--placeholder-fill);
    transform: scaleX(0);
    transform-origin: left center;
    // 30 秒走到 90%：1 秒 8%、3 秒 25%、10 秒 65%，之后越来越慢并停在 90%
    // 节奏有意放缓，避免前期推进过快再停顿
    animation: placeholder-progress 30s cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
}

@keyframes placeholder-progress {
    to {
        transform: scaleX(0.9);
    }
}

// 加载完成时：从当前位置补完到满，再随占位层一起淡出
.veil.loaded .bar i {
    animation: none;
    transform: scaleX(1);
    transition: transform 180ms ease-out;
}

/* 久等说明：一行灰字，压在底色上 */
.slow {
    margin: 0;
    padding: 3px 9px;
    color: var(--muted);
    font-size: var(--font-size-xs);
    background: color-mix(in srgb, var(--bg) 76%, transparent);
    border-radius: 3px;
}

.failure {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px;
    color: var(--muted);
    text-align: center;
}

.glyph {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.label {
    font-size: var(--font-size-xs);
}

.retry {
    padding: 2px 8px;
    font-size: var(--font-size-xs);
}

/* 小格子里放不下文字与进度条，只留底色 */
@container (width < 104px) {
    .bar,
    .slow {
        display: none;
    }

    .failure {
        gap: 4px;
        padding: 4px;
    }

    .label {
        display: none;
    }
}

@container (width < 56px) {
    .failure {
        gap: 2px;
    }

    .glyph {
        width: 18px;
        height: 18px;
    }

    .retry {
        padding: 0 5px;
    }
}

@media (prefers-reduced-motion: reduce) {
    .veil {
        transition: none;
    }

    // 减弱动效下不留推进动画，只给一段静止的进度，收尾也不做补间
    .bar i,
    .veil.loaded .bar i {
        animation: none;
        transition: none;
    }

    .bar i {
        transform: scaleX(0.35);
    }
}
</style>
