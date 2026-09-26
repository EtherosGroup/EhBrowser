<script setup lang="ts">
/*
 * 关键词组管理页：新建、改名、增删词条、批量删除
 * 组存在服务端，页面只维护「选中项」与「正在改名的组」这类临时状态
 */

import { computed, onMounted, ref } from "vue";

import type { KeywordEntryKind, KeywordGroup, KeywordGroupEntry } from "../../../src/api/index.ts";
import { describeApiError } from "../api.ts";
import Dialog from "./Dialog.vue";
import {
    addKeywordEntries,
    createKeywordGroup,
    keywordGroups,
    loadKeywordGroups,
    removeKeywordGroup,
    removeKeywordGroups,
    updateKeywordGroup,
} from "../keyword-groups.ts";
import { entryKey, entryTerm } from "../tag-search.ts";
import { suggestionText, tagSuggestions, type TagSuggestion } from "../translation.ts";
import { messenger } from "../messenger.ts";

interface Draft {
    readonly kind: KeywordEntryKind;
    readonly value: string;
}

const KINDS: readonly { readonly value: KeywordEntryKind; readonly label: string }[] = [
    { value: "tag", label: "标签" },
    { value: "author", label: "作者" },
    { value: "custom", label: "自定义" },
];

const busy = ref(false);
const newTitle = ref("");
const selected = ref<readonly string[]>([]);
const renaming = ref("");
const renameText = ref("");
const askRemove = ref("");
const askRemoveSelected = ref(false);
/** 每个组各存一份「正在输入的新词条」 */
const drafts = ref<Record<string, Draft>>({});
/** 正在给哪个组做标签建议 */
const suggestFor = ref("");

/** 输入框里正在写的那一段，和搜索页同一条规则 */
const TOKEN_TAIL = /[^\s,]*$/;

/** 按正在写的那一段查词库。作者类型先收窄到 artist 命名空间，否则 12 条名额会被别的占满 */
function suggestionsFor(id: string): readonly TagSuggestion[] {
    const kind = draftKind(id);
    if (kind === "custom") {
        return [];
    }
    const value = draftValue(id);
    const token = value.slice(value.search(TOKEN_TAIL));
    if (kind === "author") {
        const name = token.includes(":") ? token.slice(token.indexOf(":") + 1) : token;
        return tagSuggestions(`artist:${name}`);
    }
    return tagSuggestions(token);
}

/** 只给正在输入的那个组算一次，避免模板里每个组都去扫一遍词库 */
const activeSuggestions = computed<readonly TagSuggestion[]>(() =>
    suggestFor.value === "" ? [] : suggestionsFor(suggestFor.value),
);

/** 建议项对应的词条值：写原始标签，检索写法由 entryTerm 生成 */
function tagValueOf(item: TagSuggestion): string {
    return item.namespace === "" ? item.raw : `${item.namespace}:${item.raw}`;
}

function pickSuggestion(id: string, item: TagSuggestion): void {
    setDraft(id, { value: tagValueOf(item) });
    // 选完就收起，免得挡住刚填进去的内容
    suggestFor.value = "";
}

/** 焦点还在这个组的输入区里时不收起建议 */
function onAddFocusOut(id: string, event: FocusEvent): void {
    const next = event.relatedTarget;
    const box = event.currentTarget;
    if (next instanceof Node && box instanceof HTMLElement && box.contains(next)) {
        return;
    }
    if (suggestFor.value === id) {
        suggestFor.value = "";
    }
}

const groups = computed(() => keywordGroups.value);
const allSelected = computed(
    () => groups.value.length > 0 && selected.value.length === groups.value.length,
);

function draftKind(id: string): KeywordEntryKind {
    return drafts.value[id]?.kind ?? "tag";
}

function draftValue(id: string): string {
    return drafts.value[id]?.value ?? "";
}

function setDraft(id: string, patch: Partial<Draft>): void {
    drafts.value = {
        ...drafts.value,
        [id]: { kind: draftKind(id), value: draftValue(id), ...patch },
    };
}

function onKind(id: string, event: Event): void {
    setDraft(id, { kind: (event.target as HTMLSelectElement).value as KeywordEntryKind });
}

function onValue(id: string, event: Event): void {
    setDraft(id, { value: (event.target as HTMLInputElement).value });
}

function kindLabel(kind: KeywordEntryKind): string {
    return KINDS.find((item) => item.value === kind)?.label ?? kind;
}

/** 写操作统一包一层：失败提示，成功后清掉临时状态 */
async function run(action: () => Promise<void>, done: string, after?: () => void): Promise<void> {
    busy.value = true;
    try {
        await action();
        after?.();
        messenger.success(done);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

function create(): void {
    const title = newTitle.value.trim();
    if (title === "") {
        return;
    }
    void run(() => createKeywordGroup(title, []), `已新建「${title}」`, () => {
        newTitle.value = "";
    });
}

function startRename(group: KeywordGroup): void {
    renaming.value = group.id;
    renameText.value = group.title;
}

function commitRename(group: KeywordGroup): void {
    // 回车会先提交、输入框随即卸载并触发 blur，这里挡掉第二次
    if (renaming.value !== group.id) {
        return;
    }
    const title = renameText.value.trim();
    renaming.value = "";
    if (title === "" || title === group.title) {
        return;
    }
    void run(() => updateKeywordGroup(group.id, { title }), "已改名");
}

function addEntry(group: KeywordGroup): void {
    const value = draftValue(group.id).trim();
    if (value === "") {
        return;
    }
    const entry: KeywordGroupEntry = { kind: draftKind(group.id), value };
    void run(() => addKeywordEntries(group.id, [entry]), "已添加", () => {
        setDraft(group.id, { value: "" });
    });
}

function dropEntry(group: KeywordGroup, entry: KeywordGroupEntry): void {
    const key = entryKey(entry);
    const entries = group.entries.filter((item) => entryKey(item) !== key);
    void run(() => updateKeywordGroup(group.id, { entries }), "已移除");
}

function toggleSelect(id: string): void {
    selected.value = selected.value.includes(id)
        ? selected.value.filter((item) => item !== id)
        : [...selected.value, id];
}

function toggleAll(): void {
    selected.value = allSelected.value ? [] : groups.value.map((group) => group.id);
}

function removeOne(): void {
    const id = askRemove.value;
    askRemove.value = "";
    if (id === "") {
        return;
    }
    void run(() => removeKeywordGroup(id), "已删除关键词组", () => {
        selected.value = selected.value.filter((item) => item !== id);
    });
}

function removeSelected(): void {
    const ids = [...selected.value];
    askRemoveSelected.value = false;
    if (ids.length === 0) {
        return;
    }
    void run(() => removeKeywordGroups(ids), `已删除 ${ids.length} 个关键词组`, () => {
        selected.value = [];
    });
}

onMounted(() => {
    void loadKeywordGroups().catch((caught: unknown) => {
        messenger.error(describeApiError(caught));
    });
});
</script>

<template>
    <div class="panel">
        <header class="head">
            <div class="new">
                <input
                    v-model="newTitle"
                    placeholder="新组名"
                    @keyup.enter="create"
                />
                <button :disabled="busy || newTitle.trim() === ''" @click="create">
                    新建关键词组
                </button>
            </div>
            <div class="acts">
                <button :disabled="busy || groups.length === 0" @click="toggleAll">
                    {{ allSelected ? "取消全选" : "全选" }}
                </button>
                <button
                    class="danger"
                    :disabled="busy || selected.length === 0"
                    @click="askRemoveSelected = true"
                >
                    删除选中（{{ selected.length }}）
                </button>
            </div>
        </header>

        <p v-if="groups.length === 0" class="muted empty">
            还没有关键词组。新建一个，把常用的标签、画师或自定义检索片段存进去；搜索页的「+」可以把整组灌进搜索框。
        </p>

        <ul v-else class="groups">
            <li v-for="group in groups" :key="group.id" class="group">
                <header class="group-head">
                    <input
                        type="checkbox"
                        :checked="selected.includes(group.id)"
                        :aria-label="`选择 ${group.title}`"
                        @change="toggleSelect(group.id)"
                    />
                    <input
                        v-if="renaming === group.id"
                        v-model="renameText"
                        class="rename"
                        @keyup.enter="commitRename(group)"
                        @keyup.esc="renaming = ''"
                        @blur="commitRename(group)"
                    />
                    <button v-else class="name" :disabled="busy" @click="startRename(group)">
                        {{ group.title === "" ? "（未命名）" : group.title }}
                    </button>
                    <span class="muted count">{{ group.entries.length }} 条</span>
                    <button class="drop" :disabled="busy" @click="askRemove = group.id">删除</button>
                </header>

                <ul v-if="group.entries.length > 0" class="entries">
                    <li
                        v-for="entry in group.entries"
                        :key="entryKey(entry)"
                        class="entry"
                        :class="entry.kind"
                        :title="entryTerm(entry)"
                    >
                        <span class="kind">{{ kindLabel(entry.kind) }}</span>
                        <span class="value">{{ entry.value }}</span>
                        <button
                            class="drop"
                            :disabled="busy"
                            aria-label="移除词条"
                            @click="dropEntry(group, entry)"
                        >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M4 4l8 8M12 4l-8 8" />
                            </svg>
                        </button>
                    </li>
                </ul>
                <p v-else class="muted empty">还没有词条</p>

                <div
                    class="add"
                    @focusin="suggestFor = group.id"
                    @focusout="onAddFocusOut(group.id, $event)"
                >
                    <select
                        :value="draftKind(group.id)"
                        :aria-label="`给 ${group.title} 添加的词条类型`"
                        @change="onKind(group.id, $event)"
                    >
                        <option v-for="item in KINDS" :key="item.value" :value="item.value">
                            {{ item.label }}
                        </option>
                    </select>
                    <div class="field">
                        <input
                            :value="draftValue(group.id)"
                            :placeholder="draftKind(group.id) === 'author' ? '画师名' : '词条'"
                            @input="onValue(group.id, $event)"
                            @keyup.enter="addEntry(group)"
                        />
                        <div
                            v-if="suggestFor === group.id && activeSuggestions.length > 0"
                            class="suggest"
                        >
                            <ul>
                                <li
                                    v-for="item in activeSuggestions"
                                    :key="`${item.namespace}:${item.raw}`"
                                >
                                    <button type="button" @click="pickSuggestion(group.id, item)">
                                        {{ suggestionText(item) }}
                                    </button>
                                </li>
                            </ul>
                        </div>
                    </div>
                    <button
                        :disabled="busy || draftValue(group.id).trim() === ''"
                        @click="addEntry(group)"
                    >
                        添加
                    </button>
                </div>
            </li>
        </ul>

        <Dialog v-model="askRemoveSelected" title="删除关键词组">
            <p>要删除选中的 {{ selected.length }} 个关键词组吗？删除后无法恢复。</p>
            <template #buttons>
                <button :disabled="busy" @click="removeSelected">确定</button>
                <button @click="askRemoveSelected = false">取消</button>
            </template>
        </Dialog>

        <Dialog :model-value="askRemove !== ''" title="删除关键词组" @update:model-value="askRemove = ''">
            <p>要删除这个关键词组吗？删除后无法恢复。</p>
            <template #buttons>
                <button :disabled="busy" @click="removeOne">确定</button>
                <button @click="askRemove = ''">取消</button>
            </template>
        </Dialog>
    </div>
</template>

<style scoped lang="scss">
.head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
}

.new {
    display: flex;
    align-items: center;
    gap: 8px;
}

.new input {
    width: 220px;
}

.acts {
    display: flex;
    gap: 8px;
}

.empty {
    margin: 0;
}

.groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.group-head {
    display: flex;
    align-items: center;
    gap: 10px;
}

.group-head input[type="checkbox"] {
    width: auto;
    height: auto;
    flex: none;
}

.name {
    flex: 1;
    padding: 2px 0;
    text-align: left;
    font-size: var(--font-size-base);
    color: var(--accent);
    background: none;
    border: none;
}

.rename {
    flex: 1;
}

.count {
    font-size: var(--font-size-sm);
    flex: none;
}

.entries {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px 3px 8px;
    font-size: var(--font-size-sm);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
}

/* 类型只在左侧用一条竖线区分，不额外上色 */
.entry.tag {
    border-left: 3px solid var(--accent);
}

.entry.author {
    border-left: 3px solid var(--ok);
}

.entry.custom {
    border-left: 3px solid var(--muted);
}

.entry .kind {
    color: var(--muted);
}

.entry .value {
    color: var(--text);
}

.add {
    display: flex;
    align-items: center;
    gap: 8px;
}

.add select {
    width: 90px;
    flex: none;
}

/* 输入框与它下面的标签建议 */
.field {
    position: relative;
    flex: 1;
    min-width: 120px;
}

.field input {
    width: 100%;
}

.suggest {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: var(--z-floating);
    max-height: 220px;
    overflow: auto;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

.suggest ul {
    margin: 0;
    padding: 4px;
    list-style: none;
}

.suggest button {
    display: block;
    width: 100%;
    padding: 4px 8px;
    text-align: left;
    font-size: var(--font-size-sm);
    background: none;
    border: none;
}

.suggest button:hover {
    background: var(--panel);
}

.drop {
    display: grid;
    place-items: center;
    flex: none;
    padding: 2px 6px;
    font-size: var(--font-size-sm);
    background: none;
    border-color: transparent;
}

.drop svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.6;
    stroke-linecap: round;
}

.drop:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
}
</style>
