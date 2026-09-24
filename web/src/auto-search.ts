/*
 * 自动搜索的界面侧状态与提示。
 *
 * 「自动搜索」指打开界面时自己去上游拉一份内容（启动预热 + 打开搜索页铺默认结果）。
 * 默认关闭，开关在设置 > 搜索；关掉后所有检索都由用户发起（点搜索、回车、从详情页带条件进来）。
 * 进入页面时提示一次这个开关的存在，提示本身也可以在同一个分组里关掉。
 */

import { ref } from "vue";

import { messenger } from "./messenger.ts";

/** 是否自动检索。由 status 读配置后写入 */
export const autoSearch = ref(false);
/** 是否在进入页面时提示自动搜索这件事 */
export const autoSearchHintEnabled = ref(false);

/** 按规格的提示文案，把当前状态与开关位置都写清楚 */
export function autoSearchHintText(): string {
    return autoSearch.value
        ? "Tips：自动搜索已开启，EhBrowser 打开时会自己拉一份内容；可在 设置 > 搜索 里关掉"
        : "Tips：自动搜索已关闭，打开界面时不会自己去上游拉内容；可在 设置 > 搜索 里打开";
}

/**
 * 设置读过一次就 resolve。搜索页在决定「要不要自动检索」之前等它：
 * 直接读 autoSearch 的默认值会把「开着」误判成「关着」，那一次进页面就不检索了。
 */
let resolveReady: (() => void) | null = null;
export const searchSettingsReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
});

export function markSearchSettingsReady(): void {
    resolveReady?.();
    resolveReady = null;
}

/** 进入页面时提示一次。关闭提示或已经提示过就不再出现。 */
let hinted = false;

export function hintAutoSearch(): void {
    if (!autoSearchHintEnabled.value || hinted) {
        return;
    }
    hinted = true;
    messenger.info(autoSearchHintText(), {
        position: messenger.POSITION.BOTTOM_RIGHT,
        // 不自动关闭：点一下才收起，与紧急避险的提示一致
        autoClose: false,
    });
}
