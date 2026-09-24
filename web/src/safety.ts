/*
 * 紧急避险。按 Ctrl + 空格 把当前页面整个换成配置里的避险地点。
 * 地点可以是网页地址，也可以是本地 file:// 地址；没设置就落到空白页。
 * 入口与提示分开：快捷键全局生效，提示只在进入 EhBrowser 页面时出现，且可在设置里关掉。
 */

import { ref } from "vue";

import { messenger } from "./messenger.ts";

/** 避险地点。由 status 读配置后写入 */
export const escapeUrl = ref("about:blank");
/** 是否在进入页面时提示。 */
export const escapeHintEnabled = ref(true);

/** 按规格的提示文案，地点取当前配置值 */
export function escapeHintText(): string {
    return (
        `Tips：使用 Ctrl + 空格 来紧急避险，当前设置的避险地点为 ${escapeUrl.value}，` +
        "EhBrowser 会在你按下快捷键后将当前页面替换为避险地点"
    );
}

/** 进入 EhBrowser 页面时提示一次。关闭提示或已经提示过就不再出现。 */
let hinted = false;

export function hintEscape(): void {
    if (!escapeHintEnabled.value || hinted) {
        return;
    }
    hinted = true;
    messenger.info(escapeHintText(), {
        position: messenger.POSITION.BOTTOM_RIGHT,
        // 不自动关闭：点一下才收起，与自动搜索的提示一致
        autoClose: false,
    });
}

/*
 * 执行避险：整页替换，而不是打开新页。
 * 用 replace 是为了让后退键回不到原页面，避险之后不留痕迹才有意义。
 */
export function triggerEscape(): void {
    const target = escapeUrl.value.trim() === "" ? "about:blank" : escapeUrl.value.trim();
    window.location.replace(target);
}

/*
 * Ctrl + 空格。命中时阻止默认行为。
 * 注意：部分平台会把 Ctrl + 空格 接过去（Windows 的输入法切换、macOS 的输入源切换），
 * 那种情况下浏览器收不到这次按键，只能改配置里的地点，而不能改快捷键。
 */
export function isEscapeShortcut(event: KeyboardEvent): boolean {
    return (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === " " || event.code === "Space")
    );
}
