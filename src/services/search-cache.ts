/*
 * 搜索结果缓存。存的是「最后一次检索的条件 + 结果」，界面重进搜索页时可以据此直接铺出列表。
 * 只存在于本次运行期内：文件落在缓存目录的 temp 下，启动时先删除，之后由预热检索重新写入。
 * 读取以内存中的副本为准，文件只是本次的落盘副本（便于排查，也让同一进程内的语义清楚）。
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { GallerySearchCache } from "../api/index.ts";
import { ensureDir, isNotFound, readTextIfExists, writeFileAtomic } from "../config/atomic.ts";

/** 缓存目录下的临时子目录，内容可随时删除 */
export const TEMP_SUBDIR = "temp";
const CACHE_FILENAME = "search.json";

export interface SearchCache {
    /** 落盘位置 */
    readonly file: string;
    /** 上一次检索。内存中没有时尝试读一次盘，仍然没有则为 null */
    read(): Promise<GallerySearchCache | null>;
    /** 记下这次检索；落盘异步进行，不阻塞响应 */
    save(entry: GallerySearchCache): void;
    /** 丢弃缓存：清空内存并删除文件。启动时调用 */
    discard(): Promise<void>;
    /** 等待在途的落盘写完，退出前调用 */
    flush(): Promise<void>;
}

function isCache(value: unknown): value is GallerySearchCache {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const entry = value as Partial<GallerySearchCache>;
    return (
        typeof entry.savedAt === "number" &&
        typeof entry.query === "object" &&
        entry.query !== null &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        Array.isArray(entry.result.items)
    );
}

export function createSearchCache(cacheDir: string): SearchCache {
    const file = join(cacheDir, TEMP_SUBDIR, CACHE_FILENAME);
    let current: GallerySearchCache | null = null;
    /** 在途的落盘，按顺序串起来，避免两次写入互相覆盖 */
    let writing: Promise<void> = Promise.resolve();

    async function readFromDisk(): Promise<GallerySearchCache | null> {
        const text = await readTextIfExists(file);
        if (text === null) {
            return null;
        }
        try {
            const parsed = JSON.parse(text) as unknown;
            return isCache(parsed) ? parsed : null;
        } catch {
            // 坏文件按没有缓存处理，下一次检索会覆盖它
            return null;
        }
    }

    return {
        file,

        async read() {
            if (current !== null) {
                return current;
            }
            // 内存中没有就读盘。文件是这份缓存的本体，进程外写入的内容也一并接受
            current = await readFromDisk();
            return current;
        },

        save(entry) {
            current = entry;
            writing = writing
                .then(async () => {
                    await ensureDir(join(cacheDir, TEMP_SUBDIR));
                    await writeFileAtomic(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
                })
                .catch(() => {
                    // 缓存写入失败不影响检索本身，只是下次需要重新获取
                });
        },

        async discard() {
            // 先等在途的落盘结束，避免删掉刚写入的文件
            await writing;
            current = null;
            await rm(file, { force: true }).catch((error: unknown) => {
                if (!isNotFound(error)) {
                    throw error;
                }
            });
        },

        async flush() {
            await writing;
        },
    };
}
