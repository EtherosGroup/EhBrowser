<script setup lang="ts">
/*
 * 下载确认弹窗。详情页与播放器共用同一份，两边的下载入口都使用它。
 * 按规格：标题「下载此画廊」、正文「要下载此画廊吗？共 N 页。」、按钮为取消与各分辨率。
 * 打开时读一次归档选项：读得到就按分辨率列出（带体积）；读不到（多为未登录）时只列出逐页下载，
 * 并把原因写在弹窗里。逐页下载只走 showpage，未登录也能用，因此未登录时仍有可用的下载方式。
 */

import { ref, watch } from "vue";

import type { ArchiveOption } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import Dialog from "./Dialog.vue";

const props = defineProps<{
    open: boolean;
    gid: number;
    token: string;
    /** 正文里的总页数 */
    pageCount: number;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const archives = ref<readonly ArchiveOption[]>([]);
/** 归档选项读不到的原因；读不到不影响逐页下载 */
const archiveError = ref("");
const loading = ref(false);
const busy = ref(false);

function close(): void {
    emit("update:open", false);
}

/** 读取归档选项。失败时只记录原因：下面还有逐页下载，不因此阻塞弹窗 */
async function loadArchives(): Promise<void> {
    loading.value = true;
    archives.value = [];
    archiveError.value = "";
    try {
        const catalog = await request("galleries.archives", {
            params: { gid: props.gid, token: props.token },
        });
        archives.value = catalog.options;
    } catch (caught) {
        archiveError.value = describeApiError(caught);
    } finally {
        loading.value = false;
    }
}

/** 排队。resolution 为 org/res 时是归档下载，pages-* 是逐页下载 */
async function enqueue(resolution: string): Promise<void> {
    busy.value = true;
    try {
        await request("downloads.create", {
            body: { gid: props.gid, token: props.token, resolution },
        });
        close();
        messenger.success(`已加入下载队列（${resolution}）`);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

// 每次打开（或换了画廊）都重读一次：归档选项与体积都跟着画廊走，不缓存
watch(
    () => [props.open, props.gid, props.token],
    () => {
        if (props.open) {
            void loadArchives();
        }
    },
    { immediate: true },
);
</script>

<template>
    <Dialog
        :model-value="open"
        title="下载此画廊"
        width="520px"
        @update:model-value="emit('update:open', $event)"
    >
        <p>要下载此画廊吗？共 {{ pageCount }} 页。</p>
        <p class="muted hint">
            逐页下载不需要登录：一页一次请求上游，页数多时耗时较长（上游限流约 5 秒一次）。
            归档下载更快，但需要登录并消耗 GP。
        </p>
        <p v-if="loading" class="muted hint">正在读取归档选项…</p>
        <p v-else-if="archiveError !== ''" class="muted hint">
            归档选项读不到（{{ archiveError }}），下面只列出逐页下载。
        </p>
        <template #buttons>
            <button :disabled="busy" @click="close">取消</button>
            <button
                v-for="option in archives"
                :key="option.resolution"
                :disabled="busy"
                @click="enqueue(option.resolution)"
            >
                下载{{ option.resolution }}{{ option.sizeText }}
            </button>
            <button :disabled="busy" @click="enqueue('pages-res')">逐页下载（重采样图）</button>
            <button :disabled="busy" @click="enqueue('pages-org')">逐页下载（原图）</button>
        </template>
    </Dialog>
</template>

<style scoped lang="scss">
.hint {
    font-size: var(--font-size-sm);
    margin: 6px 0 0;
}
</style>
