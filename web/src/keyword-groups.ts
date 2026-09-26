/*
 * 关键词组的本地状态
 *
 * 组存在服务端，这里只缓存一份；每个写操作都回整份列表，收到后直接替换
 * 词条 -> 搜索框文本的规则在 tag-search.ts
 */

import { ref } from "vue";

import type { KeywordGroup, KeywordGroupEntry } from "../../src/api/index.ts";
import { request } from "./api.ts";

export const keywordGroups = ref<readonly KeywordGroup[]>([]);
export const keywordGroupsReady = ref(false);

/** 拉一次列表。失败时保持原样并抛给调用方 */
export async function loadKeywordGroups(): Promise<void> {
    keywordGroups.value = [...(await request("keywords.list"))];
    keywordGroupsReady.value = true;
}

/** 写操作统一走这里：服务端回整份列表，直接替换 */
async function apply(action: () => Promise<readonly KeywordGroup[]>): Promise<void> {
    keywordGroups.value = [...(await action())];
    keywordGroupsReady.value = true;
}

export function createKeywordGroup(
    title: string,
    entries: readonly KeywordGroupEntry[] = [],
): Promise<void> {
    return apply(() => request("keywords.create", { body: { title, entries } }));
}

export function updateKeywordGroup(
    groupId: string,
    patch: { title?: string; entries?: readonly KeywordGroupEntry[] },
): Promise<void> {
    return apply(() => request("keywords.update", { params: { groupId }, body: patch }));
}

export function addKeywordEntries(
    groupId: string,
    entries: readonly KeywordGroupEntry[],
): Promise<void> {
    return apply(() => request("keywords.addEntries", { params: { groupId }, body: { entries } }));
}

export function removeKeywordGroup(groupId: string): Promise<void> {
    return apply(() => request("keywords.remove", { params: { groupId } }));
}

export function removeKeywordGroups(ids: readonly string[]): Promise<void> {
    return apply(() => request("keywords.removeMany", { body: { ids } }));
}

