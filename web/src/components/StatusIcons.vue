<script setup lang="ts">
/**
 * 右上角的状态图标。覆盖展示，尺寸取小，边距与页面留白一致。
 * 层级只低于 messenger（vue3-toastify 的 9999），因此提示弹出来时不会被图标压住。
 * 图标是状态：异常期间一直在，好转后自己消失；点一下把详细说明与采样值弹成一条提示。
 */
import { statusIcons, type StatusIconItem } from "../diagnostics.ts";
import { messenger } from "../messenger.ts";
import { serverStatus } from "../diagnostics.ts";

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
    <div v-if="statusIcons.length > 0" class="status-icons" aria-live="polite">
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
    </div>
</template>

<style scoped lang="scss">
.status-icons {
    position: fixed;
    top: 10px;
    right: 10px;
    /* 只低于 messenger（toastify 的 9999），高于播放器全屏与各种浮层 */
    z-index: var(--z-status);
    display: flex;
    gap: 6px;
}

.icon {
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
</style>
