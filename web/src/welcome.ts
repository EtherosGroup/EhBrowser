/*
 * 首次打开的提醒。记录只存在 localStorage 里，不写入配置文件。
 * 提醒的对象是刚拿到安装包的人，因此换浏览器或清掉站点数据后会再看到一次。
 * 若把记录写进配置，重装一次反而不会提醒，与这条提醒的目的不符。
 */

import { ref } from "vue";

const STORAGE_KEY = "ehbrowser.welcome.seen";

/** 提醒是否显示。首次打开时由 openWelcomeIfFirstRun 置为 true */
export const welcomeOpen = ref(false);

/** 未看过时打开提醒。localStorage 读不到时按未看过处理，多提醒一次可以接受 */
export function openWelcomeIfFirstRun(): void {
    if (hasSeen()) {
        return;
    }
    welcomeOpen.value = true;
}

/** 关闭提醒并记下已读。写入失败（隐私模式）时仍能关闭，不弹出错误 */
export function dismissWelcome(): void {
    welcomeOpen.value = false;
    try {
        localStorage.setItem(STORAGE_KEY, "1");
    } catch {
        // 写入失败时忽略：本次关闭即可，不因存储受限而一直显示提醒
    }
}

function hasSeen(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
        return false;
    }
}
