<script setup lang="ts">
/**
 * 播放器页。负责把「一个画廊」变成「一串可播放的曲目」，播放本身交给 Player。
 * 本地已下载时直接用本地文件铺满整份列表，不发出任何上游请求；
 * 未下载时按窗口异步解析地址，播放器翻页不会等待解析结果。
 * 阅读进度写回本地库（下载过的画廊）或留在地址里。
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import type { GalleryDetail } from "../../../src/api/index.ts";
import { describeApiError, isAbortError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import { createTrackProvider, type TrackProvider } from "../player-source.ts";
import {
    currentPlaylistKey,
    galleryPlaylist,
    playingGallery,
    savePlaylistProgress,
    type PlaylistGallery,
} from "../playlist.ts";
import DownloadDialog from "./DownloadDialog.vue";
import Player from "./Player.vue";
import { addFavorite, favoriteFolders, loadFavorites } from "../favorites.ts";

const props = defineProps<{ gid: number; token: string }>();

const route = useRoute();
const router = useRouter();

interface PlayerSettings {
    maxCacheMb: number;
    maxConcurrentLoads: number;
    preloadCount: number;
    autoplayEnabled: boolean;
    autoplayIntervalSeconds: number;
    autoplayLoop: boolean;
    quality: "org" | "res";
}

const detail = ref<GalleryDetail | null>(null);
const error = ref("");
const page = ref(1);
const provider = ref<TrackProvider | null>(null);
/** 播放器需要的设置项，取自配置 */
const settings = ref<PlayerSettings>({
    maxCacheMb: 512,
    maxConcurrentLoads: 3,
    preloadCount: 2,
    autoplayEnabled: false,
    autoplayIntervalSeconds: 5,
    autoplayLoop: false,
    quality: "res",
});
/** 下载弹窗。归档选项与逐页下载都在它里面，详情页用的是同一个组件 */
const askDownload = ref(false);

/** 本地库里的这一份（有的话），决定用本地文件还是网络图 */
const localResolution = ref<string | null>(null);
const localBytesPerPage = ref(0);
const localPageCount = ref(0);

let controller = new AbortController();
let signal = controller.signal;

/** 本地副本的页数以解压出来的文件数为准，它才代表实际能读的页数 */
const pageCount = computed(() =>
    localResolution.value === null ? (detail.value?.pageCount ?? 0) : localPageCount.value,
);
/** 本次点击之后的收藏状态。null 表示还没点过，以详情里的 favorite 为准 */
const favoriteOverride = ref<boolean | null>(null);
const tracks = computed(() => provider.value?.tracks ?? []);
/** 详情里的 favorite 为 null（未登录、或不在任何夹里）时算未收藏 */
const favorited = computed(
    () => favoriteOverride.value ?? (detail.value?.favorite?.slot ?? -1) >= 0,
);
const downloaded = computed(() => localResolution.value !== null);

/** 播放器设置的读取。配置改动经 SSE 回来时会重新走一遍 */
async function loadSettings(): Promise<void> {
    try {
        const snapshot = await request("config.get");
        const viewer = snapshot.setting.viewer;
        settings.value = {
            maxCacheMb: viewer.maxCacheMb,
            preloadCount: viewer.preloadCount,
            maxConcurrentLoads: viewer.maxConcurrentLoads,
            autoplayEnabled: viewer.autoplay.enabled,
            autoplayIntervalSeconds: viewer.autoplay.intervalSeconds,
            autoplayLoop: viewer.autoplay.loop,
            quality: viewer.imageQuality,
        };
    } catch {
        // 取不到设置时使用默认值，不应因此挡住播放
    }
}

/** 写回自动播放设置 */
async function saveAutoplay(value: {
    enabled: boolean;
    intervalSeconds: number;
    loop: boolean;
}): Promise<void> {
    settings.value = {
        ...settings.value,
        autoplayEnabled: value.enabled,
        autoplayIntervalSeconds: value.intervalSeconds,
        autoplayLoop: value.loop,
    };
    try {
        await request("config.patch", { body: { viewer: { autoplay: value } } });
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 有本地副本时使用本地：整个列表直接铺好，不发出任何上游请求 */
async function findLocalCopy(): Promise<{
    resolution: string;
    bytesPerPage: number;
    pageCount: number;
} | null> {
    try {
        const list = await request("library.list");
        const hit = list.find((item) => item.gid === props.gid);
        if (hit === undefined) {
            return null;
        }
        return {
            resolution: hit.resolution,
            bytesPerPage: hit.files > 0 ? Math.round(hit.sizeBytes / hit.files) : 0,
            pageCount: hit.files > 0 ? hit.files : hit.pageCount,
        };
    } catch {
        // 本地库取不到时按未下载处理
        return null;
    }
}

function buildProvider(total: number): void {
    provider.value?.dispose();
    provider.value = createTrackProvider({
        gid: props.gid,
        token: props.token,
        resolution: localResolution.value,
        pageCount: total,
        bytesPerPage: localBytesPerPage.value,
        maxConcurrent: settings.value.maxConcurrentLoads,
        quality: settings.value.quality,
        signal,
    });
}

/** 已解析出来的地址同步进画廊播放列表：本地画廊是一次铺满，网络画廊边解析边补 */
watch(
    () => provider.value?.tracks,
    (list) => {
        if (list === undefined) {
            return;
        }
        galleryPlaylist.value = list
            .filter((track): track is NonNullable<typeof track> => track !== null)
            .map((track) => ({ page: track.page, url: track.url, bytes: track.bytes }));
    },
);

/** 写回阅读进度。本地画廊写入 .ehbrowser，未下载时只留在地址里 */
function rememberPage(value: number): void {
    void router.replace({ path: route.path, query: value > 1 ? { page: String(value) } : {} });
    // 位于用户播放列表中的画廊：进度也写回列表，播放列表页对应行才显示正确
    const inList = currentPlaylistKey.value?.startsWith(`${props.gid}-`) === true;
    if (inList && currentPlaylistKey.value !== null) {
        void savePlaylistProgress(currentPlaylistKey.value, value);
    }
    const resolution = localResolution.value;
    if (resolution === null) {
        return;
    }
    void request("library.progress", {
        params: { gid: props.gid, resolution },
        body: { page: value },
    }).catch(() => undefined);
}

async function load(): Promise<void> {
    controller.abort();
    controller = new AbortController();
    signal = controller.signal;
    error.value = "";
    detail.value = null;
    // 换了画廊：上次点击记下的收藏状态作废，回到按详情判断
    favoriteOverride.value = null;
    provider.value?.dispose();
    provider.value = null;
    page.value = Math.max(1, Number(route.query["page"] ?? 1) || 1);
    await Promise.all([loadSettings(), startGallery()]);
}

/** 情景 1：进画廊阅读时清空画廊播放列表，把这个画廊的每一页重新装进去 */
async function startGallery(): Promise<void> {
    const local = await findLocalCopy();
    try {
        const info = await request("galleries.detail", {
            params: { gid: props.gid, token: props.token },
            signal,
        });
        if (signal.aborted) {
            return;
        }
        detail.value = info;
        document.title = `${info.title} - EhBrowser`;
    } catch (caught) {
        if (signal.aborted || isAbortError(caught)) {
            return;
        }
        // 本地有副本时上游不可达也能阅读
        if (local === null) {
            error.value = describeApiError(caught);
            messenger.error(error.value);
            return;
        }
    }

    localResolution.value = local?.resolution ?? null;
    localBytesPerPage.value = local?.bytesPerPage ?? 0;
    localPageCount.value = local?.pageCount ?? 0;
    const total = pageCount.value;

    const item: PlaylistGallery = {
        gid: props.gid,
        token: props.token,
        title: detail.value?.title ?? `#${props.gid}`,
        thumbUrl: detail.value?.thumbUrl ?? "",
        pageCount: total,
        resolution: local?.resolution ?? null,
        page: page.value,
        bytesPerPage: localBytesPerPage.value,
    };
    playingGallery.value = item;
    // 情景 1：清空画廊播放列表后重建；本地画廊在这一步就把所有页的地址装好了
    galleryPlaylist.value = [];
    buildProvider(total);
    if (total > 0) {
        rememberPage(page.value);
    }
}

/**
 * 点击下载：打开下载弹窗。
 * 归档选项与逐页下载都在弹窗里，读不到归档（多为未登录）时仍可逐页下载，
 * 因此这里不再预先请求归档：预请求失败会导致弹窗打不开，游客将无法下载。
 */
function openDownload(): void {
    askDownload.value = true;
}

/**
 * 收藏 / 取消收藏。与详情页、本地画廊页同一套做法：放进第一个本地收藏夹并同步云端槽位 0，
 * 取消时把标记号改成 -1 再从本地夹移除。未登录也能用，云端那一步服务端只记日志。
 * 详情页的 favorite 字段不会因为这次点击重新请求上游，因此本页自己记下结果。
 */
async function toggleFavorite(): Promise<void> {
    const info = detail.value;
    await loadFavorites();
    const folder = favoriteFolders.value[0];
    try {
        if (favorited.value) {
            if (folder === undefined) {
                messenger.warning("没有可用的本地收藏夹");
                return;
            }
            await request("favorites.items.slot", {
                params: { folderId: folder.id, gid: props.gid },
                body: { slot: -1 },
            });
            await request("favorites.items.remove", {
                params: { folderId: folder.id, gid: props.gid },
            });
            favoriteOverride.value = false;
            messenger.success("已取消收藏");
            return;
        }
        const ok = await addFavorite({
            gid: props.gid,
            token: props.token,
            title: info?.title ?? `#${props.gid}`,
            thumbUrl: info?.thumbUrl ?? "",
            pageCount: pageCount.value,
            slot: 0,
        });
        if (ok) {
            favoriteOverride.value = true;
            messenger.success("已加入收藏夹");
        }
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

function backToDetail(): void {
    void router.push({ name: "gallery", params: { gid: props.gid, token: props.token } });
}

watch(
    () => [props.gid, props.token],
    () => void load(),
    { immediate: true },
);

onUnmounted(() => {
    controller.abort();
    provider.value?.dispose();
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <RouterLink class="title" :to="{ name: 'gallery', params: { gid, token } }">
                {{ detail?.title ?? `#${gid}` }}
            </RouterLink>
            <span v-if="downloaded" class="tag muted">本地</span>
            <span class="muted">{{ pageCount }} 页</span>
            <span class="actions">
                <RouterLink
                    :to="{ name: 'gallery-previews', params: { gid, token } }"
                    class="muted"
                >
                    全部预览
                </RouterLink>
                <RouterLink :to="{ name: 'gallery', params: { gid, token } }" class="muted">
                    返回详情
                </RouterLink>
            </span>
        </header>

        <p v-if="error" class="err">{{ error }}</p>

        <Player
            v-if="pageCount > 0"
            :tracks="tracks"
            :page-count="pageCount"
            :title="detail?.title ?? ''"
            :start-page="page"
            :downloaded="downloaded"
            :favorited="favorited"
            :max-cache-mb="settings.maxCacheMb"
            :preload-count="settings.preloadCount"
            :autoplay-enabled="settings.autoplayEnabled"
            :autoplay-interval-seconds="settings.autoplayIntervalSeconds"
            :autoplay-loop="settings.autoplayLoop"
            :archives="archives"
            @update:page="rememberPage"
            @need="(pages) => provider?.ensure(pages)"
            @autoplay="saveAutoplay"
            @favorite="toggleFavorite"
            @download="openDownload"
            @detail="backToDetail"
        />
        <p v-else-if="!error" class="muted">读取画廊中…</p>

        <!-- 下载确认。按规格：标题、页数、取消与各分辨率的下载按钮 -->
        <DownloadDialog
            v-model:open="askDownload"
            :gid="gid"
            :token="token"
            :page-count="pageCount"
        />
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    text-decoration: none;
}

.title:hover {
    text-decoration: underline;
}

.tag {
    padding: 1px 6px;
    font-size: var(--font-size-sm);
    border: 1px solid var(--line);
    border-radius: 3px;
}

.actions {
    display: flex;
    gap: 12px;
    margin-left: auto;
    font-size: var(--font-size-md);
}

.hint {
    margin: 8px 0 0;
    font-size: var(--font-size-sm);
}

.err {
    color: var(--danger);
}
</style>
