/*
 * 标签与类别的中文翻译
 * 开关来自设置（设置 > 翻译 > 开启标签翻译），未开启时所有函数原样返回上游文本
 * 翻译来源有两层：
 *   1. 内置表：常用标签与全部类别、命名空间，安装后即可使用，不联网
 *   2. 词库：从 EhTagTranslation/Database 的发布包按需下载，覆盖全部标签（含画师、角色、原作）
 * 词库未安装或未开启时一律回落到内置表；查不到的原样返回
 */

import { ref } from "vue";

import type { TranslateStatus } from "../../src/api/index.ts";
import { describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";
import { categoryText, namespaceText, setDatabase, tagText } from "./translation-db.ts";

/** 是否开启标签翻译。由 status 读取配置后写入，界面各处直接引用 */
export const tagTranslation = ref(false);

/** 词库状态，设置页显示 */
export const translateStatus = ref<TranslateStatus | null>(null);

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
 * 把整份词库读入内存。仅在开启翻译时调用，词库未安装时后端返回 null，界面继续使用内置表
 * 只在开关变化与词库更新后调用，不必每次渲染都调用
 */
export async function loadTagDatabase(): Promise<void> {
    if (!tagTranslation.value) {
        setDatabase(null);
        return;
    }
    try {
        const database = await request("translate.tags");
        setDatabase(database);
        translateStatus.value = await request("translate.status");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
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
        messenger.info("词库已删除，标签翻译回到内置的常用表");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}
