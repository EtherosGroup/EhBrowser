<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";

import {
    GALLERY_CATEGORIES,
    GALLERY_LANGUAGES,
    SEARCH_PAGE_LIMIT,
    type GalleryCategory,
    type GalleryLanguage,
    type GallerySearchCache,
    type GallerySearchQuery,
    type GallerySummary,
    type KeywordGroup,
} from "../../../src/api/index.ts";
import GalleryGrid from "./GalleryGrid.vue";
import Dialog from "./Dialog.vue";
import { searchGroupTitle, type GalleryGroup } from "../gallery-groups.ts";
import { normalizeQuery, groupQuery, mergeQuery } from "../tag-search.ts";
import { keywordGroups, loadKeywordGroups } from "../keyword-groups.ts";
import { GRID_COLUMN_CHOICES, columnsLabel, gridColumns } from "../ui-prefs.ts";
import { describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import { autoSearch, searchSettingsReady } from "../auto-search.ts";
import { clearSearchHistory, rememberSearch, searchHistory } from "../search-history.ts";
import {
    categoryLabel,
    suggestionQuery,
    suggestionText,
    tagName,
    tagSuggestions,
    type TagSuggestion,
} from "../translation.ts";

const route = useRoute();
const router = useRouter();

const query = ref("");
const language = ref("");
const minRating = ref<number | null>(null);
const selected = ref<GalleryCategory[]>([]);
const items = ref<GallerySummary[]>([]);
const page = ref(1);
/** 关键词组选择弹窗 */
const askGroups = ref(false);
const hasNext = ref(false);
const busy = ref(false);
/** 当前这批结果对应的关键词。标题按它生成，不受输入框中正在输入的内容影响 */
const searchedKey = ref("");
/** 关键词输入框。点建议或历史后把焦点放回去，方便接着改 */
const input = ref<HTMLInputElement | null>(null);

/**
 * 正在输入的那一段：最后一个空格或逗号之后的部分。
 * 空格与逗号都是标签之间的分隔，所以敲下逗号就等于「开始写下一个标签」，
 * 建议区随之换到下一段——这就是逗号触发下一次关联搜索的做法。
 */
const TOKEN_TAIL = /[^\s,]*$/;

/** 输入框里正在写的这一段标签 */
const typingToken = computed(() => query.value.slice(query.value.search(TOKEN_TAIL)));

/** 按正在输入的那一段从词库里找标签 */
const suggestions = computed<readonly TagSuggestion[]>(() => tagSuggestions(typingToken.value));

/*
 * 悬浮层的显示时机：焦点落在筛选框里的时候才出来（搜索历史尤其如此，默认不显示，点输入框才出来）。
 * 用 focusin / focusout 而不是 input 的 blur：点浮层里的按钮时焦点仍在这个框里，不该因此收起。
 */
const boxFocused = ref(false);
/** 检索发出后先收起浮层，让新结果完整露出来；再敲字或再点输入框时又出来 */
const panelDismissed = ref(false);
/**
 * 输入框有没有焦点。这时用户是在用鼠标点输入框下方的标签建议，
 * 指针从结果区上经过不该弹出卡片预览，因此把网格的悬浮预览暂停掉。
 */
const inputFocused = ref(false);

function onFiltersFocusIn(): void {
    boxFocused.value = true;
}

function onFiltersFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    const box = event.currentTarget;
    if (next instanceof Node && box instanceof Node && box.contains(next)) {
        return;
    }
    boxFocused.value = false;
}

/** 敲字就取消「检索后收起」的状态，建议区跟着回来 */
watch(query, () => {
    panelDismissed.value = false;
});

/** 自动搜索关闭且没有内容可展示：结果区显示一句说明，等用户自己发起 */
const idle = ref(false);

/** 结果区的空文案：区分「自动搜索关闭」「正在搜索」与「筛出来是空的」 */
const emptyText = computed(() => {
    if (busy.value) {
        return "";
    }
    if (idle.value) {
        return "自动搜索已关闭（设置 > 搜索）：输入关键词后回车或点「搜索」开始";
    }
    return "没有符合条件的结果，换个关键词或放宽筛选试试";
});

/** 浮层里有没有要展示的东西 */
const panelOpen = computed(
    () =>
        boxFocused.value &&
        !panelDismissed.value &&
        (suggestions.value.length > 0 || searchHistory.value.length > 0),
);

/** 分组：搜索页只有一组，排行榜之类的多组页面另作处理 */
const groups = computed<GalleryGroup[]>(() => [
    { title: searchGroupTitle(searchedKey.value), items: items.value },
]);

const ratingOptions = computed(() => [1, 2, 3, 4, 5]);
/** 排列尺寸的弹出层 */
const columnsOpen = ref(false);

/** 卡片点击后的去向：详情页。本地画廊之类的复用方会给出其他目标 */
function cardTarget(item: GallerySummary): RouteLocationRaw {
    return { name: "gallery", params: { gid: item.gid, token: item.token } };
}

function toggleCategory(category: GalleryCategory): void {
    const index = selected.value.indexOf(category);
    if (index === -1) {
        selected.value = [...selected.value, category];
    } else {
        selected.value = selected.value.filter((item) => item !== category);
    }
}

/** 把光标放到输入框末尾。等 v-model 把新值刷进 DOM 之后再定位 */
function focusInput(): void {
    void nextTick(() => {
        const node = input.value;
        if (node === null) {
            return;
        }
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
    });
}

/**
 * 把一段文字填进输入框。
 * 关键词里可以写多个标签（`language:chinese 男` 或 `男娘,fem`），因此只替换正在写的这一段，
 * 前面的标签与它们之间的分隔符都留着；这一段为空（结尾是分隔符）时相当于追加。
 */
function insert(text: string): void {
    const current = query.value;
    query.value = `${current.slice(0, current.search(TOKEN_TAIL))}${text}`;
    focusInput();
}

/** 点一条标签建议：换成上游的检索写法填进去 */
function pickTag(item: TagSuggestion): void {
    insert(suggestionQuery(item));
}

/** 点一条历史：整条填回输入框 */
function pickHistory(text: string): void {
    query.value = text;
    focusInput();
}

/** 把当前条件写回地址，返回搜索页时据此恢复 */
function syncQuery(target: number): void {
    const params: Record<string, string> = {};
    if (query.value.trim() !== "") {
        params["query"] = query.value.trim();
    }
    if (language.value !== "") {
        params["language"] = language.value;
    }
    if (minRating.value !== null) {
        params["minRating"] = String(minRating.value);
    }
    if (selected.value.length > 0) {
        params["categories"] = selected.value.join(",");
    }
    if (target > 1) {
        params["page"] = String(target);
    }
    void router.replace({ path: route.path, query: params });
}

/** 从地址恢复条件，返回要请求的页码 */
function readQuery(): number {
    const raw = route.query;
    query.value = typeof raw["query"] === "string" ? raw["query"] : "";
    language.value = typeof raw["language"] === "string" ? raw["language"] : "";
    minRating.value = typeof raw["minRating"] === "string" ? Number(raw["minRating"]) : null;
    const categories = typeof raw["categories"] === "string" ? raw["categories"].split(",") : [];
    selected.value = categories.filter((item): item is GalleryCategory =>
        (GALLERY_CATEGORIES as readonly string[]).includes(item),
    );
    return typeof raw["page"] === "string" ? Math.max(1, Number(raw["page"])) : 1;
}

/** 当前输入框里的条件换算成检索参数。page 与 limit 每次都写明，与缓存的比对才能对上 */
function currentQuery(target: number): GallerySearchQuery {
    // 输入框里允许用逗号分隔标签，送上游前统一整成空格（见 normalizeQuery）
    const trimmed = normalizeQuery(query.value);
    return {
        ...(trimmed === "" ? {} : { query: trimmed }),
        ...(language.value === "" ? {} : { language: language.value as GalleryLanguage }),
        ...(minRating.value === null ? {} : { minRating: minRating.value }),
        ...(selected.value.length === 0 ? {} : { categories: [...selected.value] }),
        page: target,
        limit: SEARCH_PAGE_LIMIT,
    };
}

/** 两组检索条件是不是同一组。只比实际给出的字段，缺失与 undefined 视为相同 */
function sameQuery(a: GallerySearchQuery, b: GallerySearchQuery): boolean {
    const shape = (item: GallerySearchQuery): string =>
        JSON.stringify([
            item.query ?? "",
            item.language ?? "",
            item.minRating ?? 0,
            [...(item.categories ?? [])].sort(),
            item.page ?? 1,
            item.limit ?? 0,
        ]);
    return shape(a) === shape(b);
}

/** 把缓存中的结果铺到界面上，条件一并恢复，输入框与结果不会不一致 */
function applyCache(entry: GallerySearchCache): void {
    const conditions = entry.query;
    query.value = conditions.query ?? "";
    searchedKey.value = conditions.query ?? "";
    language.value = conditions.language ?? "";
    minRating.value = conditions.minRating ?? null;
    selected.value = [...(conditions.categories ?? [])];
    items.value = [...entry.result.items];
    page.value = entry.result.page;
    hasNext.value = entry.result.hasNext;
    syncQuery(entry.result.page);
}

/** 打开关键词组选择窗；每次都重新拉一份，别处刚改的组也能看到 */
async function openGroups(): Promise<void> {
    try {
        await loadKeywordGroups();
    } catch (caught) {
        messenger.error(describeApiError(caught));
        return;
    }
    askGroups.value = true;
}

/** 整组并进搜索框 */
function insertGroup(group: KeywordGroup): void {
    query.value = mergeQuery(query.value, groupQuery(group));
    askGroups.value = false;
}

async function run(target = 1): Promise<void> {
    busy.value = true;
    // 浮层先收起来：新结果马上铺出来，别让它盖在上面
    panelDismissed.value = true;
    const asked = currentQuery(target);
    // 记进历史：记用户自己敲的那一行（保留逗号写法），语种与分类是筛选项，不重复记
    const typed = query.value.trim();
    if (asked.query !== undefined && typed !== "") {
        rememberSearch(typed);
    }
    try {
        const result = await request("galleries.search", { query: asked });
        searchedKey.value = asked.query ?? "";
        items.value = [...result.items];
        page.value = result.page;
        hasNext.value = result.hasNext;
        syncQuery(result.page);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

/**
 * 打开搜索页时展示的内容。
 * 地址中带了条件时按条件处理（缓存正好是同一组才直接铺，否则发起检索）；
 * 地址未带条件时先看缓存，缓存中有什么就铺什么，没有才请求一次默认列表。
 *
 * 「自动搜索」关掉后（设置 > 搜索，默认关闭）不主动发起检索：
 * 缓存里有东西照旧铺出来（那不算新检索），没有就给一句说明，等用户自己点搜索或回车。
 * 地址带条件时仍然检索——那是用户从详情页带过来的意图，不是我们自作主张。
 */
async function restore(): Promise<void> {
    // 等设置读回来（最多 2 秒）：否则 autoSearch 还是默认值，会把「开着」误判成「关着」
    await Promise.race([searchSettingsReady, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    const fromUrl = readQuery();
    const hasUrlConditions = Object.keys(route.query).length > 0;
    busy.value = true;
    let cached: GallerySearchCache | null = null;
    try {
        cached = await request("galleries.searchCache", {});
    } catch {
        // 取缓存失败时按没有缓存处理，下面照常发起检索
        cached = null;
    } finally {
        busy.value = false;
    }
    if (cached !== null && (!hasUrlConditions || sameQuery(cached.query, currentQuery(fromUrl)))) {
        applyCache(cached);
        return;
    }
    if (hasUrlConditions || autoSearch.value) {
        await run(fromUrl);
        return;
    }
    // 自动搜索关闭：不请求上游，把输入框让给用户
    idle.value = true;
}

onMounted(() => {
    // 打开搜索页：先看缓存再决定是否请求，见 restore 的注释
    void restore();
});
</script>

<template>
    <div class="panel">
        <section class="filters" @focusin="onFiltersFocusIn" @focusout="onFiltersFocusOut">
            <div class="row">
                <div class="grow">
                    <label for="q">关键词</label>
                    <div class="with-groups">
                        <input
                            id="q"
                            ref="input"
                            v-model="query"
                            placeholder="留空表示不限定"
                            @click="panelDismissed = false"
                            @focus="inputFocused = true"
                            @blur="inputFocused = false"
                            @keyup.enter="run(1)"
                        />
                        <button
                            type="button"
                            class="groups"
                            title="从关键词组插入"
                            aria-label="从关键词组插入"
                            @click="openGroups"
                        >
                            +
                        </button>
                    </div>
                </div>
                <div>
                    <label for="lang">语言</label>
                    <select id="lang" v-model="language">
                        <option value="">不限</option>
                        <option v-for="item in GALLERY_LANGUAGES" :key="item" :value="item">
                            {{ tagName(item, "language") }}
                        </option>
                    </select>
                </div>
                <div>
                    <label for="rate">最低评分</label>
                    <select
                        id="rate"
                        :value="minRating ?? ''"
                        @change="
                            minRating =
                                ($event.target as HTMLSelectElement).value === ''
                                    ? null
                                    : Number(($event.target as HTMLSelectElement).value)
                        "
                    >
                        <option value="">不限</option>
                        <option v-for="item in ratingOptions" :key="item" :value="item">
                            {{ item }} 星
                        </option>
                    </select>
                </div>
                <div class="size">
                    <button title="调整排列尺寸" @click="columnsOpen = !columnsOpen">
                        {{
                            columnsLabel(gridColumns) === "自动"
                                ? "排列：自动"
                                : `排列：每行 ${gridColumns}`
                        }}
                    </button>
                    <div v-if="columnsOpen" class="popover">
                        <button
                            v-for="choice in GRID_COLUMN_CHOICES"
                            :key="choice"
                            :class="{ on: gridColumns === choice }"
                            @click="
                                gridColumns = choice;
                                columnsOpen = false;
                            "
                        >
                            {{ choice === 0 ? "自动" : choice }}
                        </button>
                    </div>
                </div>
                <button class="search" :disabled="busy" @click="run(1)">
                    <i class="iconfont icon-search" aria-hidden="true" />
                    {{ busy ? "搜索中…" : "搜索" }}
                </button>
            </div>

            <!--
                语法说明放在整行下面。原来它跟在 input 那一列的后面，而这一行是底部对齐的，
                input 因此被顶高一截，与同一行的下拉框、按钮不在一条水平线上。
            -->
            <p class="muted hint">
                标签写成 namespace:tag；多词标签加引号，尾部 $ 表示精确匹配该标签；
                多个标签用空格或逗号分开（逗号只是为了好接着往下写，搜索时按空格处理）。
                详情页选中标签后会自动填成这种写法
            </p>

            <div class="cats">
                <button
                    v-for="category in GALLERY_CATEGORIES"
                    :key="category"
                    :class="{ on: selected.includes(category) }"
                    :title="categoryLabel(category)"
                    @click="toggleCategory(category)"
                >
                    {{ categoryLabel(category) }}
                </button>
            </div>

            <!--
                标签建议与搜索历史：悬浮在结果之上，不占结果的位置（.filters 是定位父级）。
                两块都只在有条目时出现，顺序是标签在上、历史在下。
            -->
            <div v-if="panelOpen" class="drop">
                <!-- 标签建议：按输入框里的内容从词库（未装词库时用内置常用表）里找，点一条填进输入框 -->
                <div v-if="suggestions.length > 0" class="pick">
                    <p class="muted line">标签</p>
                    <ul class="list">
                        <li v-for="item in suggestions" :key="`${item.namespace}:${item.raw}`">
                            <button
                                type="button"
                                :title="`填入 ${suggestionQuery(item)}`"
                                @click="pickTag(item)"
                            >
                                {{ suggestionText(item) }}
                            </button>
                        </li>
                    </ul>
                </div>

                <!-- 搜索历史：点一条整条填回输入框 -->
                <div v-if="searchHistory.length > 0" class="pick">
                    <p class="muted line">
                        搜索历史
                        <button type="button" class="clear" @click="clearSearchHistory()">
                            清空
                        </button>
                    </p>
                    <ul class="list">
                        <li v-for="item in searchHistory" :key="item">
                            <button
                                type="button"
                                :title="`填入 ${item}`"
                                @click="pickHistory(item)"
                            >
                                {{ item }}
                            </button>
                        </li>
                    </ul>
                </div>
            </div>
        </section>

        <GalleryGrid
            class="results"
            :groups="groups"
            :to="cardTarget"
            :columns="gridColumns"
            :preview-paused="inputFocused"
            :empty-text="emptyText"
        />

        <footer v-if="items.length > 0">
            <button :disabled="busy || page <= 1" @click="run(page - 1)">上一页</button>
            <span class="muted">第 {{ page }} 页</span>
            <button :disabled="busy || !hasNext" @click="run(page + 1)">下一页</button>
        </footer>

        <Dialog v-model="askGroups" title="从关键词组插入" width="560px">
            <p v-if="keywordGroups.length === 0" class="muted">
                还没有关键词组。到「关键词组」页新建一个，把常用的标签、画师或自定义检索片段存进去。
            </p>
            <ul v-else class="picker">
                <li v-for="group in keywordGroups" :key="group.id">
                    <button class="pick" @click="insertGroup(group)">
                        <span class="pick-head">
                            <span class="pick-name">{{ group.title }}</span>
                            <span class="muted">{{ group.entries.length }} 条</span>
                        </span>
                        <span class="pick-preview muted">{{ groupQuery(group) }}</span>
                    </button>
                </li>
            </ul>
            <template #buttons>
                <button @click="askGroups = false">取消</button>
            </template>
        </Dialog>
    </div>
</template>

<style scoped lang="scss">
.filters {
    /* 悬浮层（.drop）以它为定位父级 */
    position: relative;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 14px 16px;
}

.row {
    display: flex;
    gap: 12px;
    align-items: flex-end;
}

.grow {
    flex: 1;
}

/* 关键词输入 + 关键词组入口 */
.with-groups {
    display: flex;
    align-items: center;
    gap: 6px;
}

.with-groups input {
    flex: 1;
    min-width: 0;
}

/* 与旁边输入框同高：输入框是固定高度的，按钮默认只有内边距撑高，会显得扁 */
.with-groups .groups {
    flex: none;
    height: var(--control-height);
    padding: 0 12px;
    font-size: var(--font-size-lg);
}

.picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 52vh;
    overflow: auto;
}

.pick {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    padding: 8px 10px;
    text-align: left;
}

.pick-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
}

.pick-name {
    color: var(--accent);
}

.pick-preview {
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 搜索按钮：图标 + 文字，图标跟随按钮颜色与字号 */
.search {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

/* 条件行下面的一行说明：标签语法不直观，在此处说明 */
.hint {
    margin: 10px 0 0;
    font-size: var(--font-size-sm);
}

/*
 * 标签建议与搜索历史：悬浮在结果网格之上（绝对定位，不参与布局），
 * 因此结果的位置不随它的出现而移动。层级取 --z-floating，盖住卡片但低于悬浮预览与弹窗。
 */
.drop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    left: 0;
    z-index: var(--z-floating);
    /* 两块都放大后（各 280px）仍装得下；窗口矮时整层自己滚 */
    max-height: min(80vh, 660px);
    padding: 10px 12px;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

/* 两块都是「标题 + 可滚动的按钮列表」，每行一个 */
.pick + .pick {
    margin-top: 10px;
    border-top: 1px solid var(--line);
    padding-top: 10px;
}

.pick .line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    font-size: var(--font-size-sm);
}

.pick .clear {
    padding: 0 6px;
    font-size: var(--font-size-xs);
}

/* 条目多时滚动。约 9 行，剩下的自己滚 */
.list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 280px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
}

/* 行也放高一点：一屏能看的条数不变太多，但点起来更从容 */
.list button {
    display: block;
    width: 100%;
    padding: 5px 10px;
    overflow: hidden;
    font-size: var(--font-size-md);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.list button:hover {
    border-color: var(--accent);
    color: var(--accent);
}

.cats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
}

.cats button {
    padding: 4px 10px;
    font-size: var(--font-size-md);
}

.cats button.on {
    border-color: var(--accent);
    color: var(--accent);
}

/* 排列尺寸：与本地画廊、收藏页共用同一份偏好 */
.size {
    position: relative;
}

.popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: var(--z-overlay);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    width: 200px;
    padding: 8px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

.popover button {
    min-width: 32px;
    padding: 4px 6px;
    font-size: var(--font-size-sm);
}

.popover button.on {
    border-color: var(--accent);
    color: var(--accent);
}

.results {
    margin-top: 16px;
}

footer {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: center;
    margin-top: 20px;
}
</style>
