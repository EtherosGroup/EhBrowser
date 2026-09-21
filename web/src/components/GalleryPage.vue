<script setup lang="ts">
/*
 * 画廊详情页。左列封面与目录缩略图，右列标题、信息、操作栏与标签。
 * 详情页不翻页：大图只作封面（上游给出的一页），看全部图片走阅读器。
 * 进页的请求挂在本页的取消信号上：中途返回首页会立即中断，不再继续加载。
 */

import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import {
    SEARCH_PAGE_LIMIT,
    type GalleryDetail,
    type GalleryImagePage,
    type GalleryRelation,
    type GallerySummary,
} from "../../../src/api/index.ts";
import { describeApiError, isAbortError, libraryImageUrl, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import { addFavorite, loadFavorites } from "../favorites.ts";
import { addToUserPlaylist } from "../playlist.ts";
import { tagQuery, TAG_TERM_LIMIT } from "../tag-search.ts";
import { categoryLabel, namespaceLabel, tagName } from "../translation.ts";
import Dialog from "./Dialog.vue";
import DownloadDialog from "./DownloadDialog.vue";
import ImagePlaceholder from "./ImagePlaceholder.vue";
import ImageLightbox from "./ImageLightbox.vue";
import SkeletonImage from "./SkeletonImage.vue";
import SpriteImage from "./SpriteImage.vue";

const PREVIEW_LIMIT = 20;

const props = defineProps<{ gid: number; token: string }>();

const route = useRoute();
const router = useRouter();

const detail = ref<GalleryDetail | null>(null);
/** 封面：上游的第一页 */
const cover = ref<GalleryImagePage | null>(null);
/** 本地副本的分辨率；有就用本地第 1 页当封面，不必向上游要图片页 */
const localResolution = ref<string | null>(null);
const error = ref("");
/** 下载弹窗。归档与逐页下载两种方式都在其中，未登录时也有可用的下载路径 */
const askDownload = ref(false);
/** 缩略图灯箱：点缩略图就地放大，进阅读器只由「阅读」按钮负责 */
const lightboxOpen = ref(false);
const lightboxPage = ref(1);
/** 图片质量跟着设置走，与播放器一致 */
const imageQuality = ref<"org" | "res">("res");
/** 上游最新版本，null 表示已是最新或尚未查出 */
const newerVersion = ref<GalleryRelation | null>(null);
/** 「查看新版本」弹窗，打开时才读取新版本信息 */
const versionsOpen = ref(false);
const newerSummary = ref<GallerySummary | null>(null);
const newerLoading = ref(false);

/** 选中的标签，用于组合搜索 */
const selectedTags = ref<string[]>([]);
/** 选中的标签换算成搜索框里的一行：namespace:"多词标签"$ */
const searchQuery = computed(() => tagQuery(selectedTags.value));
/** 上游只接受 8 个词条，超出时给出提示 */
const tooManyTags = computed(() => selectedTags.value.length > TAG_TERM_LIMIT);

const upstreamUrl = computed(() => `https://e-hentai.net/g/${props.gid}/${props.token}/`);
const shownPreviews = computed(() => (detail.value?.previewPages ?? []).slice(0, PREVIEW_LIMIT));
/** 封面地址：本地有副本就读本地文件（零上游请求），否则用上游图片页给的地址 */
const coverSrc = computed(() =>
    localResolution.value === null
        ? (cover.value?.imageUrl ?? "")
        : libraryImageUrl(props.gid, localResolution.value, 1),
);

/** 本页所有请求共用的取消信号，离开页面或重新加载时中断 */
let controller = new AbortController();
let signal = controller.signal;

function restart(): AbortSignal {
    controller.abort();
    controller = new AbortController();
    signal = controller.signal;
    return signal;
}

function toggleTag(tag: string): void {
    selectedTags.value = selectedTags.value.includes(tag)
        ? selectedTags.value.filter((item) => item !== tag)
        : [...selectedTags.value, tag];
}

/** 带着关键词回到搜索页：搜索框填好，搜索由搜索页发起 */
function toSearchPage(key: string): void {
    void router.push({ path: "/", query: { query: key } });
}

/**
 * 搜索选中的标签：回到搜索页，把词条填进搜索框，由搜索页发起搜索
 * 先在本页把这次检索跑完再跳转：提示文案从「正在搜索」变为「找到 N 条结果」，
 * 服务端同时把结果写入检索缓存，搜索页打开时直接渲染，不必再等待一次上游请求；
 * 查询失败时同样跳转，搜索页会自行重试并显示原因，不因一次失败停留在详情页
 */
function searchSelectedTags(): void {
    const key = searchQuery.value;
    if (key === "") {
        return;
    }
    void messenger
        .promise(
            request("galleries.search", {
                query: { query: key, page: 1, limit: SEARCH_PAGE_LIMIT },
                signal,
            }),
            {
                pending: `正在搜索选中的 ${selectedTags.value.length} 个标签…`,
                success: { render: ({ data }) => `找到 ${data.items.length} 条结果` },
                error: {
                    // 中途离开页面会中断请求，这种取消不作为错误提示
                    render: ({ data }) =>
                        isAbortError(data) ? "搜索已取消" : describeApiError(data),
                },
            },
        )
        .then(
            () => toSearchPage(key),
            (caught: unknown) => {
                // 已经离开本页时这次中断没有意义，不再跳转到搜索页
                if (!isAbortError(caught)) {
                    toSearchPage(key);
                }
            },
        );
}

function openPreviews(): void {
    void router.push({ name: "gallery-previews", params: { gid: props.gid, token: props.token } });
}

/**
 * 加入用户播放列表（只追加，不清空）
 * 同时查询本地库是否有该画廊的副本，有则一并记录分辨率，播放时直接使用本地文件
 */
async function addToPlaylist(): Promise<void> {
    const info = detail.value;
    if (info === null) {
        return;
    }
    let resolution: string | null = null;
    let bytesPerPage = 0;
    try {
        const hit = (await request("library.list", { signal })).find(
            (item) => item.gid === props.gid,
        );
        if (hit !== undefined) {
            resolution = hit.resolution;
            bytesPerPage = hit.files > 0 ? Math.round(hit.sizeBytes / hit.files) : 0;
        }
    } catch {
        // 本地库取不到就按网络画廊加入
    }
    const ok = await addToUserPlaylist({
        gid: info.gid,
        token: info.token,
        title: info.title,
        thumbUrl: info.thumbUrl,
        pageCount: info.pageCount,
        resolution,
        bytesPerPage,
    });
    if (ok) {
        messenger.success("已加入播放列表");
    }
}

/** 收藏：先确保收藏夹列表读到了，再放进第一个本地夹并同步云端槽位 0 */
async function collect(): Promise<void> {
    const info = detail.value;
    if (info === null) {
        return;
    }
    await loadFavorites();
    const ok = await addFavorite({
        gid: info.gid,
        token: info.token,
        title: info.title,
        thumbUrl: info.thumbUrl,
        pageCount: info.pageCount,
        slot: 0,
    });
    if (ok) {
        messenger.success("已加入收藏夹");
    }
}

/** 点缩略图：在屏幕中间放大看这一页，不跳转 */
function openLightbox(page: number): void {
    lightboxPage.value = page;
    lightboxOpen.value = true;
}

/**
 * 进阅读器
 * 先检查本地有没有副本：有就直接进入（播放器整本使用本地文件，零上游请求）；
 * 没有则向上游请求一次以确认这一页仍然存在。详情页可能是缓存中读出的旧信息，
 * 画廊删除后仍会显示；上游也取不到时提示「该画廊可能已失效」，不进入空白阅读器
 */
async function openReader(target = 1): Promise<void> {
    try {
        const local = await request("library.list", { signal });
        if (!local.some((item) => item.gid === props.gid)) {
            await request("galleries.page", {
                params: { gid: props.gid, token: props.token, page: 1 },
                // fresh：这一步需要请求上游，不能使用详情缓存
                query: { fresh: true },
                signal,
            });
        }
    } catch (caught) {
        if (signal.aborted || isAbortError(caught)) {
            return;
        }
        messenger.error(`该画廊可能已失效：${describeApiError(caught)}`);
        return;
    }
    void router.push({
        name: "gallery-player",
        params: { gid: props.gid, token: props.token },
        query: target > 1 ? { page: String(target) } : {},
    });
}

/*
 * 后台检查是否存在新版本，不阻塞渲染。详情先渲染，本检查随后执行。
 * 结果由服务端落盘，下次进入直接读盘。
 * 查不到时（断网、未登录）按没有处理，不打扰用户。
 */
async function checkNewer(active: AbortSignal): Promise<void> {
    try {
        const result = await request("galleries.newer", {
            params: { gid: props.gid, token: props.token },
            signal: active,
        });
        if (!active.aborted) {
            newerVersion.value = result.newer;
        }
    } catch {
        // 后台检查失败不提示：可能是断网，也可能是这一本本来就查不到
    }
}

/** 打开版本列表，同时读取新版本的标题与页数，便于比较 */
async function openVersions(): Promise<void> {
    const target = newerVersion.value;
    if (target === null) {
        return;
    }
    versionsOpen.value = true;
    if (newerSummary.value !== null) {
        return;
    }
    newerLoading.value = true;
    try {
        newerSummary.value = await request("galleries.detail", {
            params: { gid: target.gid, token: target.token },
            signal,
        });
    } catch (caught) {
        messenger.error(`新版本信息读取失败：${describeApiError(caught)}`);
    } finally {
        newerLoading.value = false;
    }
}

/** 切换版本即跳转到该版本的详情页，旧地址仍可用，不删除任何内容 */
function switchTo(gid: number, token: string): void {
    versionsOpen.value = false;
    void router.push({ name: "gallery", params: { gid, token } });
}

/** 读一次设置：图片质量决定灯箱取原图还是重采样图 */
async function loadQuality(): Promise<void> {
    try {
        const snapshot = await request("config.get");
        imageQuality.value = snapshot.setting.viewer.imageQuality;
    } catch {
        // 读不到就按重采样图，不影响查看
    }
}

/** 本地是否有该画廊的副本：有则封面读取本地文件，图片页请求整个省去 */
async function findLocalResolution(active: AbortSignal): Promise<string | null> {
    try {
        const list = await request("library.list", { signal: active });
        return list.find((item) => item.gid === props.gid)?.resolution ?? null;
    } catch {
        // 本地库读不到就当没下载，照常走上游
        return null;
    }
}

async function load(): Promise<void> {
    // 旧地址里的 ?page=N 是详情页翻页留下的，转到播放器的同一页
    const legacy = Math.max(1, Number(route.query["page"] ?? 1) || 1);
    if (legacy > 1) {
        void router.replace({
            name: "gallery-player",
            params: { gid: props.gid, token: props.token },
            query: { page: String(legacy) },
        });
        return;
    }

    const active = restart();
    error.value = "";
    detail.value = null;
    cover.value = null;
    localResolution.value = null;
    selectedTags.value = [];
    try {
        // 两件事互不依赖：详情（下载过的画廊由服务端直接给落盘快照）与本地副本的查询
        const [info, local] = await Promise.all([
            request("galleries.detail", {
                params: { gid: props.gid, token: props.token },
                signal: active,
            }),
            findLocalResolution(active),
        ]);
        if (active.aborted) {
            return;
        }
        detail.value = info;
        localResolution.value = local;
        document.title = `${info.title} - EhBrowser`;
        newerVersion.value = null;
        newerSummary.value = null;
        // 后台查有没有新版本，不挡渲染
        void checkNewer(active);
        // 本地有副本：封面用本地第 1 页，一个上游请求都不发（离线也看得到）
        if (local !== null) {
            return;
        }
        const first = await request("galleries.page", {
            params: { gid: props.gid, token: props.token, page: 1 },
            signal: active,
        });
        if (active.aborted) {
            return;
        }
        cover.value = first;
    } catch (caught) {
        // 中途离开页面导致的取消不提示，也不改状态
        if (active.aborted || isAbortError(caught)) {
            return;
        }
        error.value = describeApiError(caught);
        messenger.error(error.value);
    }
}

watch(
    () => [props.gid, props.token],
    () => {
        void load();
        void loadQuality();
    },
    { immediate: true },
);

onUnmounted(() => {
    controller.abort();
});
</script>

<template>
    <div class="panel">
        <p v-if="error" class="err">{{ error }}</p>

        <!-- 加载中：先渲染版面，避免在空白页上等待上游（首次进入要等 gdata 与画廊页） -->
        <div
            v-else-if="detail === null"
            class="gallery loading"
            aria-busy="true"
            aria-live="polite"
        >
            <section class="media">
                <div class="page"><ImagePlaceholder status="loading" /></div>
            </section>
            <section class="info">
                <p class="loading-note">正在读取画廊信息…</p>
                <div class="skeleton-bar wide" />
                <div class="skeleton-bar" />
                <div class="skeleton-bar short" />
                <div class="bar-row">
                    <div class="skeleton-bar button" />
                    <div class="skeleton-bar button" />
                    <div class="skeleton-bar button" />
                </div>
                <p class="muted hint">
                    首次进入要等上游（限流较严，一次请求约几秒）；进过的画廊会命中详情缓存，再进来是秒开
                </p>
            </section>
        </div>

        <div v-else class="gallery">
            <section class="media">
                <SkeletonImage
                    class="page"
                    :src="coverSrc"
                    :alt="`${detail.title} 封面`"
                    ratio="2 / 3"
                    eager
                    retryable
                />
                <p class="cover-note muted">
                    {{
                        localResolution === null
                            ? "封面。点缩略图就地放大，进阅读器请点「阅读」"
                            : "封面（本地副本第 1 页）。点缩略图就地放大，进阅读器请点「阅读」"
                    }}
                </p>
                <div class="previews">
                    <SpriteImage
                        v-for="preview in shownPreviews"
                        :key="preview.page"
                        class="preview"
                        :src="preview.thumbUrl"
                        :width="preview.width"
                        :height="preview.height"
                        :offset-x="preview.offsetX"
                        :offset-y="preview.offsetY"
                        :alt="`第 ${preview.page} 页缩略图`"
                        @click="openLightbox(preview.page)"
                    />
                </div>
                <button class="more" @click="openPreviews">
                    加载更多预览图（共 {{ detail.pageCount }} 页）
                </button>
            </section>

            <section class="info">
                <h2>{{ detail.title }}</h2>
                <p v-if="detail.titleJpn" class="muted jpn">{{ detail.titleJpn }}</p>

                <!-- 存在新版本时的提示，后台检查有结果后出现 -->
                <p v-if="newerVersion !== null" class="update-note">
                    有可用的更新的版本
                    <button :disabled="newerLoading" @click="openVersions">查看新版本</button>
                </p>

                <dl class="meta">
                    <dt>分类</dt>
                    <dd>{{ categoryLabel(detail.category) }}</dd>
                    <dt>上传者</dt>
                    <dd>{{ detail.uploader || "—" }}</dd>
                    <dt>页数 / 体积</dt>
                    <dd>{{ detail.pageCount }} 页 · {{ detail.sizeText }}</dd>
                    <dt>评分</dt>
                    <dd>★ {{ detail.rating }}（{{ detail.ratingCount }} 人）</dd>
                    <dt>收藏</dt>
                    <dd>{{ detail.favoriteCount }}</dd>
                    <dt>可见性</dt>
                    <dd>{{ detail.visibility }}</dd>
                </dl>

                <div class="actions">
                    <button
                        title="下载此画廊：归档或逐页，逐页不需要登录"
                        @click="askDownload = true"
                    >
                        下载
                    </button>
                    <button title="加入收藏（默认放进第一个本地收藏夹）" @click="collect">
                        {{ detail.favorite === null ? "收藏" : "已收藏" }}
                    </button>
                    <button title="进入播放器，逐页看全部图片" @click="openReader()">阅读</button>
                    <button title="加入用户播放列表（只追加，不清空）" @click="addToPlaylist">
                        加入播放列表
                    </button>
                    <a :href="upstreamUrl" target="_blank" rel="noreferrer">上游页面</a>
                    <RouterLink to="/">返回搜索</RouterLink>
                </div>

                <ul class="tags">
                    <li v-for="group in detail.tagGroups" :key="group.namespace">
                        <div class="ns">{{ namespaceLabel(group.namespace) }}</div>
                        <div class="chips">
                            <button
                                v-for="tag in group.tags"
                                :key="tag"
                                class="chip"
                                :class="{ on: selectedTags.includes(`${group.namespace}:${tag}`) }"
                                :aria-pressed="selectedTags.includes(`${group.namespace}:${tag}`)"
                                @click="toggleTag(`${group.namespace}:${tag}`)"
                            >
                                {{ tagName(tag, group.namespace) }}
                            </button>
                        </div>
                    </li>
                </ul>
            </section>
        </div>

        <ImageLightbox
            v-model:open="lightboxOpen"
            v-model:page="lightboxPage"
            :gid="gid"
            :token="token"
            :pages="shownPreviews.map((item) => item.page)"
            :quality="imageQuality"
        />

        <Dialog v-model="versionsOpen" title="选择要切换到的版本">
            <p class="muted">
                同一本画廊在上游分版本时旧地址仍然可用，切换只是打开另一版的详情页，不会删掉任何东西。
            </p>
            <ul class="versions">
                <li>
                    <span class="tag muted">当前</span>
                    <span class="ver-title">{{ detail.title }}</span>
                    <span class="muted">{{ detail.pageCount }} 页</span>
                </li>
                <li v-if="newerSummary !== null">
                    <span class="tag accent">最新</span>
                    <span class="ver-title">{{ newerSummary.title }}</span>
                    <span class="muted">{{ newerSummary.pageCount }} 页</span>
                    <button @click="switchTo(newerSummary.gid, newerSummary.token)">
                        切换到这个版本
                    </button>
                </li>
                <li v-else-if="newerVersion !== null">
                    <span class="tag accent">最新</span>
                    <span class="ver-title muted">正在读取…</span>
                    <button @click="switchTo(newerVersion.gid, newerVersion.token)">
                        直接切换
                    </button>
                </li>
            </ul>
            <p class="muted hint">更新收藏里的标记号（把收藏挪到最新版本）在收藏页的批量操作里。</p>
        </Dialog>

        <DownloadDialog
            v-model:open="askDownload"
            :gid="gid"
            :token="token"
            :page-count="detail?.pageCount ?? 0"
        />

        <!-- 选中标签后出现的搜索入口 -->
        <Transition name="tag-search">
            <button v-if="selectedTags.length > 0" class="tag-search" @click="searchSelectedTags">
                <span class="line">搜索选中的 {{ selectedTags.length }} 个标签</span>
                <span class="preview-of-selection">{{ searchQuery }}</span>
                <span v-if="tooManyTags" class="warn">
                    上游一次最多 {{ TAG_TERM_LIMIT }} 个词条，超出的会被忽略
                </span>
            </button>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
/* 存在新版本时的提示条，位于标题下方，与正文区分 */
.update-note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0 0;
    padding: 6px 10px;
    color: var(--text);
    font-size: var(--font-size-md);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid var(--accent);
    border-radius: 4px;
}

/* 版本列表，一行一个版本 */
.versions {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.versions li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-md);
}

.versions .tag {
    padding: 1px 6px;
    border: 1px solid var(--line);
    border-radius: 3px;
    font-size: var(--font-size-sm);
}

.versions .tag.accent {
    color: var(--accent);
    border-color: var(--accent);
}

.versions .ver-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 加载中的骨架：位置与真正的内容对齐，加载完不发生跳动 */
.loading-note {
    margin: 0 0 10px;
    color: var(--accent);
    font-size: var(--font-size-lg);
}

/*
 * 加载中的骨架条。类名不能包含 skeleton：SkeletonImage 的根元素带这个类，
 * 父组件的规则会顺着作用域属性落到封面图上，把封面压成 16px 高的一条
 */
.skeleton-bar {
    height: 16px;
    margin: 8px 0;
    border-radius: 4px;
    background: var(--panel-2);
    border: 1px solid var(--line);
}

.skeleton-bar.wide {
    width: 70%;
    height: 22px;
}

.skeleton-bar.short {
    width: 40%;
}

.skeleton-bar.button {
    width: 88px;
    height: 30px;
    margin: 0;
}

.loading .bar-row {
    display: flex;
    gap: 8px;
    margin: 14px 0;
}

.gallery {
    display: grid;
    // 左列固定给竖图，右列自适应
    grid-template-columns: minmax(200px, 32%) 1fr;
    gap: 20px;
    align-items: start;
}

.media {
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: sticky;
    top: 16px;
}

.media .page {
    width: 100%;
    max-height: 72vh;
    border: 1px solid var(--line);
    border-radius: 6px;
    --skeleton-fit: contain;
}

/*
 * 加载中的封面：占位层的根元素是 absolute inset:0，宽高加在它自己身上等于没有盒子，
 * 左列会塌成 0 高、占位层再往下溢出压住右列，因此需要一个参与布局的盒子支撑
 */
.loading .media .page {
    position: relative;
    aspect-ratio: 2 / 3;
}

.cover-note {
    margin: 0;
    text-align: center;
    font-size: var(--font-size-sm);
}

.previews {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
    gap: 6px;
}

.previews .preview {
    width: 100%;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 4px;
}

.more {
    width: 100%;
    font-size: var(--font-size-md);
}

.tag-search {
    position: fixed;
    right: 20px;
    bottom: 24px;
    z-index: var(--z-floating);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 320px;
    padding: 10px 14px;
    text-align: right;
    background: var(--panel);
    border: 1px solid var(--accent);
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

.tag-search .line {
    white-space: nowrap;
}

/* 关键词可能很长（多词标签带引号），折行显示完整内容，便于确认检索词 */
.tag-search .preview-of-selection {
    color: var(--muted);
    font-size: var(--font-size-sm);
    word-break: break-all;
    text-align: right;
}

.tag-search .warn {
    color: var(--danger);
    font-size: var(--font-size-sm);
    white-space: normal;
}

.tag-search-enter-active,
.tag-search-leave-active {
    transition:
        opacity 0.18s ease,
        transform 0.18s ease;
}

.tag-search-enter-from,
.tag-search-leave-to {
    opacity: 0;
    transform: translateY(8px);
}

.info h2 {
    margin: 0;
    font-size: var(--font-size-xl);
    color: var(--accent);
}

.jpn {
    margin: 4px 0 0;
    font-size: var(--font-size-md);
}

.meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 14px;
    margin: 14px 0 0;
    font-size: var(--font-size-md);
}

.meta dt {
    color: var(--muted);
}

.meta dd {
    margin: 0;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 16px 0;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
}

.actions a {
    color: var(--accent);
    font-size: var(--font-size-md);
}

.tags {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.tags li {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 8px;
    align-items: start;
}

.ns {
    color: var(--muted);
    font-size: var(--font-size-sm);
    padding-top: 2px;
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.chip {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 6px;
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
}

.chip:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
}

.chip.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
}

.err {
    color: var(--danger);
}

@media (width <= 860px) {
    .gallery {
        grid-template-columns: 1fr;
    }

    .media {
        position: static;
    }
}
</style>
