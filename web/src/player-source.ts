/*
 * 播放器的页地址来源。
 * 本地已下载：地址直接算得出来，整个画廊一次性铺好，不需要任何请求。
 * 没下载：每页地址要向上游请求一次（galleries.page），因此只按窗口异步解析，
 * 并且严格限制并发，不阻塞翻页。解析完成之前该页显示占位。
 */

import { ref, type Ref } from "vue";

import type { GalleryImagePage } from "../../src/api/index.ts";
import { describeApiError, isAbortError, libraryImageUrl, request } from "./api.ts";
import { messenger } from "./messenger.ts";
import { NETWORK_PAGE_BYTES } from "./player-cache.ts";
import type { GalleryTrack } from "./playlist.ts";

export interface TrackProviderOptions {
    readonly gid: number;
    readonly token: string;
    /** 本地已下载时的分辨率；为空表示走网络 */
    readonly resolution: string | null;
    readonly pageCount: number;
    /** 每页平均字节，用于缓存预算；本地画廊由元数据算出来 */
    readonly bytesPerPage: number;
    /** 同时最多解析几页 */
    readonly maxConcurrent: number;
    /** 看原图还是重采样图 */
    readonly quality: "org" | "res";
    readonly signal: AbortSignal;
}

export interface TrackProvider {
    /** 第 1 页在下标 0。已解析出来的位置有值，其余为 null */
    readonly tracks: Ref<readonly (GalleryTrack | null)[]>;
    /** 已经解析出来的地址 */
    url(page: number): string | undefined;
    /** 把某几页排进解析队列。已在队列或已解析的不重复排 */
    ensure(pages: readonly number[]): void;
    /** 本地画廊时整个列表一开始就是齐的 */
    readonly local: boolean;
    dispose(): void;
}

export function createTrackProvider(options: TrackProviderOptions): TrackProvider {
    const local = options.resolution !== null;
    const tracks = ref<readonly (GalleryTrack | null)[]>(
        new Array<GalleryTrack | null>(options.pageCount).fill(null),
    );
    /** 在队列里的页，避免重复排 */
    const queued = new Set<number>();
    const queue: number[] = [];
    let running = 0;
    let disposed = false;
    /** 顺序翻页时 nextPageToken 仍然有效，可用它省去一次详情解析 */
    const tokens = new Map<number, string>();

    function put(page: number, url: string, bytes: number): void {
        if (page < 1 || page > options.pageCount) {
            return;
        }
        const next = [...tracks.value];
        next[page - 1] = { page, url, bytes };
        tracks.value = next;
    }

    if (local) {
        // 本地画廊：整份列表一次铺好，对应情景 1 的「把这个画廊所有图片的地址加进列表」
        for (let page = 1; page <= options.pageCount; page += 1) {
            put(
                page,
                libraryImageUrl(options.gid, options.resolution ?? "", page),
                options.bytesPerPage,
            );
        }
    }

    function pickUrl(item: GalleryImagePage): string {
        if (options.quality === "org" && item.originalImageUrl !== null) {
            return item.originalImageUrl;
        }
        return item.imageUrl;
    }

    async function resolvePage(page: number): Promise<void> {
        if (disposed || options.signal.aborted) {
            return;
        }
        const token = tokens.get(page);
        const item = await request("galleries.page", {
            params: { gid: options.gid, token: options.token, page },
            query: token === undefined ? {} : { pageToken: token },
            signal: options.signal,
        });
        if (disposed || options.signal.aborted) {
            return;
        }
        if (item.nextPageToken !== null) {
            tokens.set(item.page + 1, item.nextPageToken);
        }
        put(page, pickUrl(item), NETWORK_PAGE_BYTES);
    }

    function pump(): void {
        while (!disposed && running < options.maxConcurrent && queue.length > 0) {
            const page = queue.shift();
            if (page === undefined) {
                return;
            }
            running += 1;
            void resolvePage(page)
                .catch((caught: unknown) => {
                    if (options.signal.aborted || isAbortError(caught)) {
                        return;
                    }
                    // 单页失败不打断播放：那一页继续显示占位，翻回来时会重排一次
                    queued.delete(page);
                    messenger.error(`第 ${page} 页地址读取失败：${describeApiError(caught)}`);
                })
                .finally(() => {
                    running -= 1;
                    pump();
                });
        }
    }

    return {
        tracks,
        local,

        url(page) {
            return tracks.value[page - 1]?.url;
        },

        ensure(pages) {
            if (local) {
                return;
            }
            for (const page of pages) {
                if (page < 1 || page > options.pageCount) {
                    continue;
                }
                if (queued.has(page) || tracks.value[page - 1] !== null) {
                    continue;
                }
                queued.add(page);
                queue.push(page);
            }
            pump();
        },

        dispose() {
            disposed = true;
            queue.length = 0;
            queued.clear();
        },
    };
}
