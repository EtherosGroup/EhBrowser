<script setup lang="ts">
/*
 * 弹窗。遮罩与进出场过渡。
 * 按规格来：只有「取消」「右上角 X」以及键盘 Esc 能关闭，点遮罩空白处无效。
 * 组件只管框、遮罩、动画与焦点，标题与按钮由调用方给出：
 *   <Dialog v-model="open" title="关闭服务器">
 *       <p>要关闭服务器吗？</p>
 *       <template #buttons><button @click="confirm">确定</button><button @click="open = false">取消</button></template>
 *   </Dialog>
 */

import { nextTick, onUnmounted, ref, watch } from "vue";

const props = withDefaults(
    defineProps<{
        modelValue: boolean;
        title: string;
        /** 面板宽度，默认 420px */
        width?: string;
    }>(),
    { width: "420px" },
);

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const panel = ref<HTMLElement | null>(null);
/** 打开前焦点所在的元素，关闭后焦点还给该元素 */
let restoreFocus: HTMLElement | null = null;

function close(): void {
    emit("update:modelValue", false);
}

/*
 * Esc 关闭。用捕获阶段并阻止继续传播：弹窗压在播放器之上时，
 * Esc 只关闭弹窗，不退出播放器的网页全屏，也不收起别的东西。
 */
function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") {
        return;
    }
    event.stopPropagation();
    close();
}

watch(
    () => props.modelValue,
    (open) => {
        if (open) {
            restoreFocus =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            window.addEventListener("keydown", onKeydown, true);
            void nextTick(() => panel.value?.focus());
            return;
        }
        window.removeEventListener("keydown", onKeydown, true);
        restoreFocus?.focus();
        restoreFocus = null;
    },
    { immediate: true },
);

onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
    <Teleport to="body">
        <Transition name="dialog">
            <!-- 遮罩不接点击：点空白处不关闭。 -->
            <div v-if="modelValue" class="mask">
                <div
                    ref="panel"
                    class="dialog"
                    :style="{ '--dialog-width': width }"
                    role="dialog"
                    aria-modal="true"
                    :aria-label="title"
                    tabindex="-1"
                >
                    <header class="head">
                        <h2>{{ title }}</h2>
                        <button type="button" class="close" aria-label="关闭" @click="close">
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                        </button>
                    </header>

                    <div class="body"><slot /></div>

                    <footer class="foot">
                        <slot name="buttons">
                            <button type="button" @click="close">取消</button>
                        </slot>
                    </footer>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped lang="scss">
.mask {
    position: fixed;
    inset: 0;
    z-index: var(--z-dialog);
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(0 0 0 / 58%);
}

.dialog {
    width: min(var(--dialog-width, 420px), 100%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 24px 64px rgb(0 0 0 / 55%);
    outline: none;
}

.head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
}

.head h2 {
    margin: 0;
    font-size: var(--font-size-lg);
    color: var(--accent);
}

.close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: none;
    border-color: transparent;
}

.close svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.6;
    stroke-linecap: round;
}

.close:hover {
    border-color: var(--accent);
}

.body {
    padding: 14px;
    overflow: auto;
    font-size: var(--font-size-md);
}

.body :deep(p) {
    margin: 0;
}

.body :deep(p + p) {
    margin-top: 8px;
}

.foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--line);
}

/* 进出场：遮罩淡入淡出，面板同时轻微位移与缩放 */
.dialog-enter-active,
.dialog-leave-active {
    transition: opacity 180ms ease;
}

.dialog-enter-active .dialog,
.dialog-leave-active .dialog {
    transition:
        transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1),
        opacity 180ms ease;
}

.dialog-enter-from,
.dialog-leave-to {
    opacity: 0;
}

.dialog-enter-from .dialog,
.dialog-leave-to .dialog {
    transform: translateY(10px) scale(0.97);
    opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
    .dialog-enter-active,
    .dialog-leave-active,
    .dialog-enter-active .dialog,
    .dialog-leave-active .dialog {
        transition: opacity 120ms ease;
    }

    .dialog-enter-from .dialog,
    .dialog-leave-to .dialog {
        transform: none;
    }
}
</style>
