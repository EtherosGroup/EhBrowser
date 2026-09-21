/*
 * 顶部加载条。对 nprogress 的薄封装
 * 同一时刻可能有多个请求进行中，直接调用 done() 会被先结束的那个提前收起，因此按计数归零收尾
 * 参数与 skilfully-web 一致；不使用 spinner，加载状态由顶部细条表达
 */

import NProgress from "nprogress";
import "nprogress/nprogress.css";

NProgress.configure({
    showSpinner: false,
    minimum: 0.1,
    easing: "ease",
    speed: 200,
    trickle: true,
});

let pending = 0;

/** 开始一项加载 */
export function startProgress(): void {
    pending += 1;
    if (pending === 1) {
        NProgress.start();
    }
}

/** 结束一项加载，全部结束才收尾 */
export function doneProgress(): void {
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
        NProgress.done();
    }
}

/** 强制收尾并清空计数。导航这类无法保证计数配对的场景使用 */
export function finishProgress(): void {
    pending = 0;
    NProgress.done();
}

/** 包住一个 Promise，成功失败都会收尾 */
export async function withProgress<T>(task: Promise<T>): Promise<T> {
    startProgress();
    try {
        return await task;
    } finally {
        doneProgress();
    }
}
