/*
 * 播放器的预热集合（模块级单例 + 本地存储）
 * 图片字节由浏览器缓存，这里只记录哪些图片已经预热过，以及占用了多少预算。
 * 该记录属于应用，而不是某个页面：
 *   - 退出画廊、切换画廊、来回路由：保留
 *   - 刷新页面（F5）：保留（记录在 localStorage 里）
 *   - 重启服务端：清空。服务端每次启动的 startedAt 是「这一次运行」的标识，
 *     该值一变就把旧记录作废（图片地址里的 keystamp 跟随会话，旧记录已不可用）
 * 超出上限时按最近使用淘汰：最久未使用的一端先淘汰，正在看的那几页每次都会 touch，因此不会被淘汰。
 * 预算按每页估算字节计算：本地页用画廊的平均页大小，网络页按未知情况取一个保守值。
 */

/** 网络页的保守估算：上游图片经重采样后大多在 1～3MB */
export const NETWORK_PAGE_BYTES = 2 * 1024 * 1024;

const STORAGE_KEY = "ehbrowser.player-warm";

/** 只用到这三个方法，便于单测注入替代实现 */
export interface WarmStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface WarmCache {
    readonly size: number;
    readonly bytes: number;
    /** 当前记录所属的服务端会话；0 表示尚未确定（记录只留在内存，不写入存储） */
    readonly scope: number;
    /** 该图片是否已经预热过。键为图片地址，同一页号在不同画廊中对应不同的图片 */
    has(key: string): boolean;
    /** 记录该图片已预热。重复 touch 会把它移到最近使用的位置 */
    touch(key: string, bytes: number): void;
    /** 缓存上限变化时立即按新预算淘汰，从最久未使用的开始 */
    resize(maxBytes: number): void;
    /** 服务端会话变化（服务端已重启）时丢弃内存中的记录，按新会话从存储恢复 */
    useScope(scope: number): void;
    clear(): void;
}

function browserStorage(): WarmStorage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        // 隐私模式等场景下无法访问存储，此时退化为纯内存
        return null;
    }
}

export function createWarmCache(
    maxBytes: number,
    storage: WarmStorage | null = browserStorage(),
): WarmCache {
    // Map 保持插入顺序，可直接用作 LRU：队首为最久未使用，队尾为最近使用
    const entries = new Map<string, number>();
    let used = 0;
    let limit = Math.max(0, maxBytes);
    let scope = 0;
    /** 上次写入存储的内容，内容未变化时不重复写入 */
    let saved = "";

    /** 超出预算时从队首（最久未使用）开始清理，至少保留一页供当前正在观看 */
    function trim(): void {
        while (used > limit && entries.size > 1) {
            const oldest = entries.keys().next();
            if (oldest.done) {
                break;
            }
            used -= entries.get(oldest.value) ?? 0;
            entries.delete(oldest.value);
        }
    }

    function persist(): void {
        if (storage === null || scope === 0) {
            return;
        }
        const payload = JSON.stringify({ scope, entries: [...entries] });
        if (payload === saved) {
            return;
        }
        try {
            storage.setItem(STORAGE_KEY, payload);
            saved = payload;
        } catch {
            // 写入失败（配额不足、隐私模式）不影响播放
        }
    }

    /** 按当前会话恢复记录。存储中的记录属于其他会话（服务端重启过）时丢弃 */
    function restore(): void {
        entries.clear();
        used = 0;
        saved = "";
        if (storage === null || scope === 0) {
            return;
        }
        let raw: string | null = null;
        try {
            raw = storage.getItem(STORAGE_KEY);
        } catch {
            return;
        }
        if (raw === null) {
            return;
        }
        try {
            const parsed = JSON.parse(raw) as { scope?: unknown; entries?: unknown };
            if (Number(parsed.scope) !== scope || !Array.isArray(parsed.entries)) {
                // 属于上一次运行的记录，直接删除
                storage.removeItem(STORAGE_KEY);
                return;
            }
            for (const item of parsed.entries) {
                if (!Array.isArray(item) || typeof item[0] !== "string") {
                    continue;
                }
                const bytes = Number(item[1]) || 0;
                entries.set(item[0], bytes);
                used += bytes;
            }
            trim();
            saved = JSON.stringify({ scope, entries: [...entries] });
        } catch {
            // 数据损坏时按没有记录处理
        }
    }

    return {
        get size(): number {
            return entries.size;
        },

        get bytes(): number {
            return used;
        },

        get scope(): number {
            return scope;
        },

        has(key) {
            return entries.has(key);
        },

        touch(key, bytes) {
            const previous = entries.get(key);
            if (previous !== undefined) {
                used -= previous;
                entries.delete(key);
            }
            entries.set(key, bytes);
            used += bytes;
            trim();
            persist();
        },

        resize(next) {
            limit = Math.max(0, next);
            trim();
            persist();
        },

        useScope(next) {
            if (next === scope) {
                return;
            }
            scope = next;
            restore();
        },

        clear() {
            entries.clear();
            used = 0;
            saved = "";
            if (storage !== null) {
                try {
                    storage.removeItem(STORAGE_KEY);
                } catch {
                    // 删除失败不影响其余状态
                }
            }
        },
    };
}

/**
 * 全局共用的预热集合
 * 首次使用时按当时的配置创建；之后配置变化走 resize，不重建。重建会清空记录，
 * 早先的写法正是重建，因此表现为退出画廊后缓存丢失
 */
let shared: WarmCache | null = null;

export function warmCache(maxBytes?: number): WarmCache {
    if (shared === null) {
        shared = createWarmCache(maxBytes ?? 512 * 1024 * 1024);
    } else if (maxBytes !== undefined) {
        shared.resize(maxBytes);
    }
    return shared;
}
