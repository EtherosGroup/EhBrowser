/*
 * 详情页多选的标签 -> 搜索框里的一行关键词
 * 上游的标签搜索语法，与官方搜索规则一致：
 *   - `namespace:tag` 只搜标签；不带命名空间则在标题与标签里都找
 *   - 空格分隔的多个词条是「同时满足」；`-` 前缀表示排除
 *   - 标签里有空格必须用双引号包起来，否则会被当成两个词条
 *     （f:big breasts 表示「f:big 且 breasts」，与 f:"big breasts" 不同）
 *   - 词条末尾的 `$` 表示必须是这个标签本身，不做前缀匹配
 *     （c:sakura$ 不会命中 c:sakura kinomoto）
 * 因此每个选中的标签都写成 `namespace:"多词标签"$`，只匹配这一个标签
 */

import type { KeywordGroup, KeywordGroupEntry } from "../../src/api/index.ts";

/** 上游一次最多识别这么多词条，超出的词条会被忽略（官方搜索规则） */
export const TAG_TERM_LIMIT = 8;

/** 关键词组的词条 -> 搜索框里的一段文本 */
export function entryTerm(entry: KeywordGroupEntry): string {
    const value = entry.value.trim();
    if (value === "") {
        return "";
    }
    if (entry.kind === "custom") {
        return value;
    }
    if (entry.kind === "author") {
        // 作者名不带命名空间，插入时按 artist 标签走；已经写了命名空间的照原样
        return tagTerm(value.includes(":") ? value : `artist:${value}`);
    }
    return tagTerm(value);
}

/** 词条去重键，界面里比较用 */
export function entryKey(entry: KeywordGroupEntry): string {
    return `${entry.kind}:${entry.value}`;
}

/** 整个关键词组 -> 搜索框里的一行 */
export function groupQuery(group: KeywordGroup): string {
    return group.entries
        .map(entryTerm)
        .filter((term) => term !== "")
        .join(" ");
}

/** 把一段词条并进搜索框已有内容，重复的词条不重复插入 */
export function mergeQuery(current: string, addition: string): string {
    const existing = current.trim() === "" ? [] : current.trim().split(/\s+/);
    const seen = new Set(existing);
    const added = addition
        .split(/\s+/)
        .filter((term) => term !== "" && !seen.has(term))
        .filter((term) => {
            seen.add(term);
            return true;
        });
    return [...existing, ...added].join(" ");
}

/** 单个标签 -> 一个词条。空标签返回空串，由调用方过滤 */
export function tagTerm(tag: string): string {
    const text = tag.trim();
    if (text === "") {
        return "";
    }
    const at = text.indexOf(":");
    const namespace = at === -1 ? "" : text.slice(0, at).trim();
    const name = (at === -1 ? text : text.slice(at + 1)).trim();
    if (name === "") {
        return "";
    }
    // 标签本身含引号时将其去掉：保留会破坏整个查询，上游也不支持转义
    const quoted = /[\s"]/.test(name) ? `"${name.replaceAll('"', "")}"` : name;
    return `${namespace === "" ? "" : `${namespace}:`}${quoted}$`;
}

/** 多个标签 -> 搜索框里的一行。顺序按用户点选的顺序，便于对照 */
export function tagQuery(tags: readonly string[]): string {
    return tags
        .map(tagTerm)
        .filter((term) => term !== "")
        .join(" ");
}

/**
 * 用户在输入框里敲的一行 -> 送上游的写法。
 * 逗号是给输入用的分隔（打完一个标签接着写下一个，建议区随之换到下一段），上游按空格切词、
 * 官方搜索规则也写明逗号不作分隔符，因此这里统一换成空格，并把连续分隔与首尾分隔收敛掉。
 * 词库里没有标签名带逗号（44290 条一条都没有），所以这样换不会伤到标签本身。
 */
export function normalizeQuery(text: string): string {
    return text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
}
