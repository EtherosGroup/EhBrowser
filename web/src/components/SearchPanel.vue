<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
} from "../../../src/api/index.ts";
import GalleryGrid from "./GalleryGrid.vue";
import { searchGroupTitle, type GalleryGroup } from "../gallery-groups.ts";
import { GRID_COLUMN_CHOICES, columnsLabel, gridColumns } from "../ui-prefs.ts";
import { describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import { categoryLabel, tagName } from "../translation.ts";

const route = useRoute();
const router = useRouter();

const query = ref("");
const language = ref("");
const minRating = ref<number | null>(null);
const selected = ref<GalleryCategory[]>([]);
const items = ref<GallerySummary[]>([]);
const page = ref(1);
const hasNext = ref(false);
const busy = ref(false);
/** 当前这批结果对应的关键词。标题按它生成，不受输入框中正在输入的内容影响 */
const searchedKey = ref("");

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
    const trimmed = query.value.trim();
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

async function run(target = 1): Promise<void> {
    busy.value = true;
    const asked = currentQuery(target);
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
 */
async function restore(): Promise<void> {
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
    await run(fromUrl);
}

onMounted(() => {
    // 打开搜索页：先看缓存再决定是否请求，见 restore 的注释
    void restore();
});
</script>

<template>
    <div class="panel">
        <section class="filters">
            <div class="row">
                <div class="grow">
                    <label for="q">关键词</label>
                    <input
                        id="q"
                        v-model="query"
                        placeholder="留空表示不限定"
                        @keyup.enter="run(1)"
                    />
                    <p class="muted hint">
                        标签写成 namespace:tag；多词标签加引号，尾部 $
                        表示精确匹配该标签。详情页选中标签后会自动填成这种写法
                    </p>
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
        </section>

        <GalleryGrid
            class="results"
            :groups="groups"
            :to="cardTarget"
            :columns="gridColumns"
            :empty-text="busy ? '' : '没有符合条件的结果，换个关键词或放宽筛选试试'"
        />

        <footer v-if="items.length > 0">
            <button :disabled="busy || page <= 1" @click="run(page - 1)">上一页</button>
            <span class="muted">第 {{ page }} 页</span>
            <button :disabled="busy || !hasNext" @click="run(page + 1)">下一页</button>
        </footer>
    </div>
</template>

<style scoped lang="scss">
.filters {
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

/* 搜索按钮：图标 + 文字，图标跟随按钮颜色与字号 */
.search {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

/* 关键词下面的一行说明：标签语法不直观，在此处说明 */
.hint {
    margin: 4px 0 0;
    font-size: var(--font-size-sm);
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
