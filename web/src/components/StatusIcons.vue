<script setup lang="ts">
/**
 * 右上角的状态图标。覆盖展示，尺寸取小，边距与页面留白一致。
 * 层级只低于 messenger（vue3-toastify 的 9999），因此提示弹出来时不会被图标压住。
 * 图标是状态：异常期间一直在，好转后自己消失；点一下把详细说明与采样值弹成一条提示。
 *
 * 它固定在视口右上角，而页头右侧也有东西（下载入口），因此让应用外壳把页头高度传进来，
 * 整组图标压在页头下方——页头窄窗口下会换行，高度是变的，所以这个偏移不能写死。
 */
import { RouterLink } from "vue-router";

import { activeCount } from "../downloads.ts";
import { statusIcons, type StatusIconItem } from "../diagnostics.ts";
import { messenger } from "../messenger.ts";
import { serverStatus } from "../diagnostics.ts";

const props = withDefaults(defineProps<{ offsetTop?: number }>(), { offsetTop: 10 });

function explain(item: StatusIconItem): void {
    const metrics = serverStatus.value?.metrics;
    const sampled =
        metrics === undefined
            ? ""
            : `\n采样：连接 ${metrics.connections}、在途 ${metrics.inflight}、内存 ${metrics.freeMemoryMb}/${metrics.totalMemoryMb} MB`;
    messenger.warning(
        `${item.label}\n${item.hint}${item.detail === "" ? "" : `\n当前：${item.detail}`}${sampled}`,
    );
}
</script>

<template>
    <div
        v-if="statusIcons.length > 0 || activeCount > 0"
        class="status-icons"
        :style="{ top: `${props.offsetTop}px` }"
        aria-live="polite"
    >
        <button
            v-for="item in statusIcons"
            :key="item.flag"
            type="button"
            class="icon"
            :title="`${item.label}：${item.hint}${item.detail === '' ? '' : `（${item.detail}）`}`"
            :aria-label="item.label"
            @click="explain(item)"
        >
            <img :src="item.icon" alt="" />
        </button>

        <!--
            下载入口：排在最后，也就是整组的最右边。
            它不是「错误状态」，而是「正在干活」，所以用绿色系，数量写在图标块右上角。
            有未结束的任务才出现，做完自己收起来；点它进下载页。
        -->
        <Transition name="downloads">
            <RouterLink
                v-if="activeCount > 0"
                class="icon downloads"
                to="/downloads"
                :title="`下载任务：${activeCount} 个未结束`"
                :aria-label="`下载任务：${activeCount} 个未结束`"
            >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M10 3v9" />
                    <path d="M6 8.5 10 12.5l4-4" />
                    <path d="M4 16h12" />
                </svg>
                <span class="badge">{{ activeCount }}</span>
            </RouterLink>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
.status-icons {
    position: fixed;
    /* top 由调用方按页头高度给（见 offsetTop） */
    right: 10px;
    /* 只低于 messenger（toastify 的 9999），高于播放器全屏与各种浮层 */
    z-index: var(--z-status);
    display: flex;
    gap: 6px;
}

.icon {
    position: relative;
    display: grid;
    place-items: center;
    padding: 3px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgb(0 0 0 / 35%);
    cursor: pointer;
}

.icon:hover {
    border-color: var(--danger);
}

.icon img {
    display: block;
    /* 图标本体尺寸。要更大就改这两个值（外框随 padding 一起长） */
    width: 30px;
    height: 30px;
}

/*
 * 下载入口：这一格是「正在干活」而不是「出错」，因此走绿色系（--download-*），
 * 与左边那几枚红色的错误图标区分开；描边与底色也只在这里覆盖。
 */
.downloads {
    color: var(--download);
    background: var(--download-bg);
    border-color: var(--download);
}

.downloads:hover {
    color: var(--download-strong);
    border-color: var(--download-strong);
}

.downloads svg {
    width: 30px;
    height: 30px;
    fill: none;
    stroke: currentcolor;
    /* 比错误图标细一点，但比默认的线条粗，视觉重量才对得上 */
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 数量角标：压在图标块右上角 */
.downloads .badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 17px;
    padding: 0 4px;
    color: #06140c;
    font-size: var(--font-size-xs);
    font-weight: 600;
    line-height: 17px;
    text-align: center;
    background: var(--download-strong);
    border-radius: 9px;
    box-shadow: 0 0 0 2px var(--panel);
}

/* 出现与收起：轻微放大进场，减弱动效时只留淡入淡出 */
.downloads-enter-active,
.downloads-leave-active {
    transition:
        opacity 180ms ease,
        transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1);
}

.downloads-enter-from,
.downloads-leave-to {
    transform: scale(0.8);
    opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
    .downloads-enter-active,
    .downloads-leave-active {
        transition: opacity 120ms ease;
    }

    .downloads-enter-from,
    .downloads-leave-to {
        transform: none;
    }
}
</style>
