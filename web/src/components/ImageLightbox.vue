<script setup lang="ts">
/**
 * 图片灯箱。在详情页点击缩略图后在屏幕正中展示这一页，而不是直接进入阅读器。
 * 只做一件事：按页号取图片地址（走 galleries.page），铺满可视区的中间，左右可翻页。
 * 关闭方式：右上角 X、点击空白处、Esc。进入阅读器由详情页的「阅读」按钮负责。
 */

import { computed, onUnmounted, ref, watch } from "vue";

import type { GalleryImagePage } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import ImagePlaceholder from "./ImagePlaceholder.vue";

const props = defineProps<{
    open: boolean;
    gid: number;
    token: string;
    /** 可以翻的页号列表，与详情页显示的缩略图一致 */
    pages: readonly number[];
    /** 当前页号；不在 pages 里时按第一页处理 */
    page: number;
    /** 图片质量，与播放器同一份设置 */
    quality: "org" | "res";
}>();

const emit = defineEmits<{ "update:open": [boolean]; "update:page": [number] }>();

const image = ref<GalleryImagePage | null>(null);
const loading = ref(false);
const error = ref("");
/** 图片字节是否已经到达。地址到位不等于能画出图，这段时间由占位层撑着 */
const ready = ref(false);
let controller = new AbortController();

const index = computed(() => {
    const at = props.pages.indexOf(props.page);
    return at === -1 ? 0 : at;
});
const current = computed(() => props.pages[index.value] ?? 1);
const imageUrl = computed(() => {
    const item = image.value;
    if (item === null) {
        return "";
    }
    return props.quality === "org" && item.originalImageUrl !== null
        ? item.originalImageUrl
        : item.imageUrl;
});
/** 地址取到且没有报错时才算有图可显示 */
const hasImage = computed(() => imageUrl.value !== "" && error.value === "");
/** 地址未取到或图片尚未画出时，都由占位层显示 */
const showPlaceholder = computed(() => !hasImage.value || !ready.value);

function close(): void {
    emit("update:open", false);
}

function step(delta: number): void {
    const next = props.pages[index.value + delta];
    if (next !== undefined) {
        emit("update:page", next);
    }
}

/** 取当前页的图片地址。翻页会中断上一页的请求 */
async function load(): Promise<void> {
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    image.value = null;
    error.value = "";
    ready.value = false;
    loading.value = true;
    try {
        const item = await request("galleries.page", {
            params: { gid: props.gid, token: props.token, page: current.value },
            signal,
        });
        if (!signal.aborted) {
            image.value = item;
        }
    } catch (caught) {
        if (signal.aborted) {
            return;
        }
        error.value = describeApiError(caught);
    } finally {
        if (!signal.aborted) {
            loading.value = false;
        }
    }
}

/** Esc 关闭，← → 翻页。挂在与弹窗同级的位置，避免与页面其他快捷键冲突 */
function onKeydown(event: KeyboardEvent): void {
    if (!props.open) {
        return;
    }
    if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
    }
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
    }
    if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
    }
}

watch(
    () => [props.open, props.page, props.gid, props.token],
    () => {
        if (!props.open) {
            controller.abort();
            window.removeEventListener("keydown", onKeydown, true);
            return;
        }
        window.addEventListener("keydown", onKeydown, true);
        void load();
    },
    { immediate: true },
);

onUnmounted(() => {
    controller.abort();
    window.removeEventListener("keydown", onKeydown, true);
});

/** 展示用：页序位置与总页数 */
const position = computed(
    () => `${current.value} / ${props.pages.length === 0 ? 0 : props.pages.length}`,
);
</script>

<template>
    <Teleport to="body">
        <Transition name="lightbox">
            <!-- 点击空白处关闭：这是查看用的临时层，不遵循弹窗「点击空白无效」的规则 -->
            <div v-if="open" class="mask" @click.self="close">
                <figure class="stage">
                    <!--
                        占位层的外框必须是布局流中的盒子：ImagePlaceholder 的根元素是 absolute inset:0，
                        宽高加在它自身上等于没有盒子，舞台会塌成只剩页脚，占位层则从中心向右下溢出屏幕。
                    -->
                    <div v-if="showPlaceholder" class="placeholder">
                        <ImagePlaceholder
                            :status="error === '' ? 'loading' : 'error'"
                            :error-text="error === '' ? '加载失败' : error"
                        />
                    </div>
                    <img
                        v-if="hasImage"
                        :class="{ waiting: !ready }"
                        :src="imageUrl"
                        :alt="`第 ${current} 页`"
                        @load="ready = true"
                        @error="error = '图片加载失败'"
                    />
                    <figcaption class="bar">
                        <span class="muted">第 {{ position }} 页</span>
                        <span class="grow" />
                        <button :disabled="index === 0" title="上一张（←）" @click="step(-1)">
                            ‹
                        </button>
                        <button
                            :disabled="index >= pages.length - 1"
                            title="下一张（→）"
                            @click="step(1)"
                        >
                            ›
                        </button>
                        <button title="关闭（Esc）" @click="close">×</button>
                    </figcaption>
                </figure>
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
    background: rgb(0 0 0 / 82%);
    cursor: zoom-out;
}

.stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: min(1200px, 100%);
    max-height: 100%;
    margin: 0;
    cursor: default;
}

.stage img {
    max-width: 100%;
    max-height: calc(100vh - 120px);
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 24px 64px rgb(0 0 0 / 60%);
}

/*
 * 图片尚未画出时不参与布局：这段时间占位层已在撑高度。
 * 两个盒子叠加会把图片顶到视口外，而「出了图」与「加载事件到达」之间总有一小段时间差。
 */
.stage img.waiting {
    position: absolute;
}

/*
 * 占位层的外框：竖图比例，宽度还要保证「图 + 页脚」落在视口内，不把页脚挤出屏幕。
 * 内层 ImagePlaceholder 自己铺满这个盒子。
 */
.placeholder {
    position: relative;
    width: min(720px, 80vw, calc((100vh - 120px) * 2 / 3));
    aspect-ratio: 2 / 3;
}

.bar {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    font-size: var(--font-size-md);
}

.bar .grow {
    flex: 1;
}

.bar button {
    min-width: 32px;
    font-size: var(--font-size-lg);
    line-height: 1;
}

.lightbox-enter-active,
.lightbox-leave-active {
    transition: opacity 160ms ease;
}

.lightbox-enter-from,
.lightbox-leave-to {
    opacity: 0;
}
</style>
