/*
 * 精灵图预载。同一页的缩略图共用一个地址，只探测一次后广播结果。
 * 背景图没有 load 事件，用一张一次性图片探测结果；结果里带上原图尺寸，
 * 缩略图要按「原图尺寸 ÷ 上游声明的格子尺寸」换算缩放，否则整张长图会按 1:1 画进几十像素的格子，
 * 每格只剩原图一角。
 * 结果长期缓存，重复进入不再探测；失败时换一个带参数的地址再试一次，
 * 避免一次网络抖动让整页缩略图都停在失败状态。
 */

export type SpriteStatus = "loading" | "loaded" | "error";

/** 探测结果。取到图后 url 是真正可用的地址（重试过时与传入的不同），尺寸为原图像素 */
export interface SpriteResult {
    readonly status: SpriteStatus;
    readonly url: string;
    readonly width: number;
    readonly height: number;
}

interface Entry {
    result: SpriteResult;
    readonly listeners: Set<(result: SpriteResult) => void>;
}

const LOADING: SpriteResult = { status: "loading", url: "", width: 0, height: 0 };
const FAILED: SpriteResult = { status: "error", url: "", width: 0, height: 0 };

const entries = new Map<string, Entry>();

/** 订阅某个地址的载入结果，返回取消订阅的函数 */
export function watchSprite(src: string, notify: (result: SpriteResult) => void): () => void {
    if (src === "") {
        notify(FAILED);
        return () => undefined;
    }

    let entry = entries.get(src);
    if (entry === undefined) {
        entry = { result: LOADING, listeners: new Set() };
        entries.set(src, entry);
        probe(src, entry, false);
    }

    if (entry.result.status !== "loading") {
        notify(entry.result);
        return () => undefined;
    }

    const current = entry;
    const listener = (result: SpriteResult): void => notify(result);
    current.listeners.add(listener);
    return () => {
        current.listeners.delete(listener);
    };
}

/** 换地址重试用。地址带递增参数，避免浏览器把上一次的失败记在同一个地址上 */
function withRetryParam(src: string): string {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}ehb-retry=1`;
}

function probe(src: string, entry: Entry, retried: boolean): void {
    const attemptUrl = retried ? withRetryParam(src) : src;

    const settle = (result: SpriteResult): void => {
        if (entry.result.status !== "loading") {
            return;
        }
        entry.result = result;
        for (const listener of entry.listeners) {
            listener(result);
        }
        entry.listeners.clear();
    };

    /** 本次探测失败：未重试过时换地址再试一次，重试后仍失败才判定为失败 */
    const failed = (): void => {
        if (retried) {
            settle(FAILED);
            return;
        }
        probe(src, entry, true);
    };

    const image = new Image();
    image.onload = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            settle({
                status: "loaded",
                url: attemptUrl,
                width: image.naturalWidth,
                height: image.naturalHeight,
            });
            return;
        }
        // 解不出尺寸的图按未取到处理：没有尺寸就算不出缩放比例
        failed();
    };
    image.onerror = failed;
    image.src = attemptUrl;
    // 命中缓存时 onload 可能不再补发，这里补一次判定
    if (image.complete && image.naturalWidth > 0) {
        settle({
            status: "loaded",
            url: attemptUrl,
            width: image.naturalWidth,
            height: image.naturalHeight,
        });
    }
}
