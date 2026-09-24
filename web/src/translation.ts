/*
 * 标签与类别的中文翻译
 * 开关来自设置（设置 > 翻译 > 开启标签翻译），未开启时所有函数原样返回上游文本
 * 翻译来源有两层：
 *   1. 内置表：常用标签与全部类别、命名空间，安装后即可使用，不联网
 *   2. 词库：从 EhTagTranslation/Database 的发布包按需下载，覆盖全部标签（含画师、角色、原作）
 * 词库未安装或未开启时一律回落到内置表；查不到的原样返回
 * 词库还供搜索框做标签补全（tagSuggestions），这部分与显示开关无关
 */

import { ref } from "vue";

import type { TranslateStatus } from "../../src/api/index.ts";
import { describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";
import {
    categoryText,
    namespaceText,
    searchTags,
    setDatabase,
    tagText,
    type TagSuggestion,
} from "./translation-db.ts";

/** 是否开启标签翻译。由 status 读取配置后写入，界面各处直接引用 */
export const tagTranslation = ref(false);

/** 词库状态，设置页显示 */
export const translateStatus = ref<TranslateStatus | null>(null);

/** 词库是否已经问过一次（含「未安装」的结果）。搜索框每次输入都问一遍没有意义 */
let fetched = false;

/**
 * 词库版本号：载入、替换、清空时自增。
 * 词库是异步到位的，界面上的标签建议要跟着重算，因此让它在计算属性里被读到。
 */
export const tagDatabaseVersion = ref(0);

/** 建议项的展示文本与点进去要填入的检索词 */
export { suggestionQuery, suggestionText } from "./translation-db.ts";
export type { TagSuggestion } from "./translation-db.ts";

/** 拆成命名空间与标签名两段，供需要分开排版的地方使用（详情页的标签组、悬浮预览的标签） */
export function tagParts(raw: string): { namespace: string; name: string } {
    const at = raw.indexOf(":");
    if (at === -1) {
        return { namespace: "", name: tagName(raw) };
    }
    const namespace = raw.slice(0, at);
    const name = raw.slice(at + 1);
    if (!tagTranslation.value) {
        return { namespace, name };
    }
    return {
        namespace: namespaceLabel(namespace),
        name: tagName(name, namespace),
    };
}

/** 命名空间翻译。详情页按命名空间分组时用 */
export function namespaceLabel(name: string): string {
    if (!tagTranslation.value) {
        return name;
    }
    return namespaceText(name);
}

/**
 * 标签名翻译。给出命名空间时先按命名空间查词库，结果更准确
 * 不给时查兜底索引与内置表，适合只知道标签名的场合
 */
export function tagName(name: string, namespace = ""): string {
    if (!tagTranslation.value) {
        return name;
    }
    return tagText(name, namespace);
}

/** 类别翻译。开关关闭或表中没有时原样返回。类别不在词库里，词库只管标签 */
export function categoryLabel(name: string): string {
    if (!tagTranslation.value) {
        return name;
    }
    return categoryText(name);
}

/** 读词库状态。设置页与状态同步均调用该函数 */
export async function refreshTranslateStatus(): Promise<void> {
    try {
        translateStatus.value = await request("translate.status");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/**
 * 把整份词库读入内存。词库未安装时后端返回 null，界面继续使用内置表
 * 只在开关变化、词库更新与搜索框首次需要时调用，不必每次渲染都调用
 */
export async function loadTagDatabase(): Promise<void> {
    try {
        const database = await request("translate.tags");
        setDatabase(database);
        fetched = true;
        tagDatabaseVersion.value += 1;
        translateStatus.value = await request("translate.status");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/**
 * 装了就载入一次。搜索框的标签补全要用整份词库，因此与「开启标签翻译」这个显示开关无关：
 * 关掉开关只是不显示译名（tagName 里判断），词库本身留在内存里（约几 MB）。
 * 载入过一次就不再请求；没装词库时同样只问一次。
 */
export async function ensureTagDatabase(): Promise<void> {
    if (fetched) {
        return;
    }
    await loadTagDatabase();
}

/**
 * 搜索框的标签建议：按已经输入的内容在词库里找标签。
 * 词库没装时用内置的常用表，因此不装也能用，只是条目少。
 * 先读一次版本号：词库晚于输入到位时，界面据此重算一次，不必再敲一下键盘。
 */
export function tagSuggestions(query: string, limit?: number): readonly TagSuggestion[] {
    void tagDatabaseVersion.value;
    return searchTags(query, limit);
}

/** 从上游发布包下载并重建词库 */
export async function updateTagDatabase(): Promise<void> {
    try {
        const status = await request("translate.update");
        translateStatus.value = status;
        if (status.error !== null) {
            messenger.error(`词库更新失败：${status.error}`);
            return;
        }
        await loadTagDatabase();
        messenger.success(
            `词库已更新到 ${status.version ?? "未知版本"}：${status.namespaceCount} 个命名空间、${status.tagCount} 条标签`,
        );
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 删掉本地词库，回到内置的常用翻译 */
export async function removeTagDatabase(): Promise<void> {
    try {
        translateStatus.value = await request("translate.remove");
        setDatabase(null);
        // 词库已经不存在，别再问一次
        fetched = true;
        tagDatabaseVersion.value += 1;
        messenger.info("词库已删除，标签翻译回到内置的常用表");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}
