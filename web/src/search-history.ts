/*
 * 搜索历史。只存在 localStorage 里，不写配置文件：属于本机的临时记录，
 * 与 welcome.ts 一样，换浏览器或清掉站点数据后重新开始即可。
 * 重复的词提到最前，最多留 HISTORY_LIMIT 条。
 */

import { ref } from "vue";

const STORAGE_KEY = "ehbrowser.search-history";

/** 最多留多少条。再多就要滚很久，也没有意义 */
export const HISTORY_LIMIT = 20;

/** 历史记录，最新在前 */
export const searchHistory = ref<readonly string[]>(read());

/** 记一次搜索。空白串与超长的串不记（上游的 f_search 上限是 200 字） */
export function rememberSearch(text: string): void {
    const value = text.trim();
    if (value === "" || value.length > 200) {
        return;
    }
    const rest = searchHistory.value.filter((item) => item !== value);
    searchHistory.value = [value, ...rest].slice(0, HISTORY_LIMIT);
    save();
}

/** 清空历史 */
export function clearSearchHistory(): void {
    searchHistory.value = [];
    save();
}

/** localStorage 不可用时退化为只留本次会话 */
function browserStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        // 隐私模式等场景下无法访问存储
        return null;
    }
}

function read(): readonly string[] {
    const storage = browserStorage();
    if (storage === null) {
        return [];
    }
    try {
        const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw
            .filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .slice(0, HISTORY_LIMIT);
    } catch {
        // 内容损坏时按没有历史处理，下次写入会覆盖掉
        return [];
    }
}

/** 写入失败（隐私模式）时忽略：本次会话里历史照常可用 */
function save(): void {
    const storage = browserStorage();
    if (storage === null) {
        return;
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(searchHistory.value));
    } catch {
        // 忽略
    }
}
