/*
 * 关键词组：搜索页与详情页共用的一组词条
 *
 * tag 插进搜索框时按标签语法（`namespace:"名字"$`）
 * author 是画师名，插入时补 artist 命名空间
 * custom 原样插入，用来放自定义检索片段
 */

import type { EntityId, EpochSeconds } from "./common.ts";

export type KeywordEntryKind = "tag" | "author" | "custom";

export interface KeywordGroupEntry {
    readonly kind: KeywordEntryKind;
    readonly value: string;
}

export interface KeywordGroup {
    readonly id: EntityId;
    readonly title: string;
    /** 有序，插入搜索框时按这个顺序 */
    readonly entries: readonly KeywordGroupEntry[];
    readonly createdAt: EpochSeconds;
    readonly updatedAt: EpochSeconds;
}

export interface KeywordGroupCreateInput {
    readonly title: string;
    readonly entries?: readonly KeywordGroupEntry[];
}

export interface KeywordGroupUpdateInput {
    readonly title?: string;
    /** 整份替换；组内同 kind 同 value 只留一条 */
    readonly entries?: readonly KeywordGroupEntry[];
}

export interface KeywordGroupAddEntriesInput {
    readonly entries: readonly KeywordGroupEntry[];
}

export interface KeywordGroupRemoveManyInput {
    readonly ids: readonly string[];
}
