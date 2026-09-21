/*
 * 运行状态与事件流。模块级单例，界面各处直接引用，不再层层传 props
 * 版本与代理摘要来自自检请求，事件列表来自 SSE
 */

import { ref } from "vue";

import type { LogEntry } from "../../src/api/index.ts";

import { describeApiError, request, subscribeEvents } from "./api.ts";
import { refreshDownloads } from "./downloads.ts";
import { mergeLogEntry } from "./logs.ts";
import { messenger } from "./messenger.ts";
import { escapeHintEnabled, escapeUrl } from "./safety.ts";
import { loadTagDatabase, tagTranslation } from "./translation.ts";
import { applyUpdateProgress, mergeUpdateEntry } from "./updater.ts";

/** 服务端版本，取自 system.health */
export const version = ref("");

/**
 * 服务端这一次运行的标识（system.health 的 startedAt）
 * 播放器预热记录按它分区：刷新页面时保留，服务端重启后该值变化，旧记录随之作废
 */
export const serverSession = ref(0);

/** 当前代理摘要，取自 config.get */
export const proxyLabel = ref("未知");

/** SSE 事件流水，最新在前 */
export const events = ref<string[]>([]);

export function pushEvent(text: string): void {
    events.value = [`${new Date().toLocaleTimeString()}  ${text}`, ...events.value].slice(0, 50);
}

/** 重新读取版本与代理摘要。配置保存、服务面板刷新均调用它 */
export async function refreshStatus(): Promise<void> {
    try {
        const health = await request("system.health");
        version.value = health.version;
        serverSession.value = health.startedAt;
        const snapshot = await request("config.get");
        const proxy = snapshot.setting.network.proxy;
        proxyLabel.value = proxy.enabled
            ? `${proxy.protocol}://${proxy.host}:${proxy.port}`
            : "未启用";
        // 标签翻译开关与避险设置取自配置，保存配置后各处立即生效
        const translateChanged = tagTranslation.value !== snapshot.setting.translate.tags;
        tagTranslation.value = snapshot.setting.translate.tags;
        // 开关刚打开（或刚保存配置）时将词库载入内存；关闭后释放，不占用内存
        if (tagTranslation.value && translateChanged) {
            void loadTagDatabase();
        }
        escapeUrl.value = snapshot.setting.safety.url;
        escapeHintEnabled.value = snapshot.setting.safety.hintEnabled;
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 订阅 SSE，返回取消函数 */
export function startEventStream(): () => void {
    return subscribeEvents({
        "server.ready": (data) => {
            pushEvent(`server.ready ${String((data as { version: string }).version)}`);
        },
        "config.changed": () => {
            pushEvent("config.changed");
            void refreshStatus();
        },
        "auth.changed": () => {
            pushEvent("auth.changed");
        },
        "download.changed": () => {
            pushEvent("download.changed");
            // 导航栏徽标与下载页共用该列表，事件到达时重新获取一次
            void refreshDownloads();
        },
        "library.update": (data) => {
            // 更新检查每查完一条推送一次，界面随查随显示
            pushEvent(`library.update ${String((data as { key: string }).key)}`);
            mergeUpdateEntry(data as never);
        },
        "library.progress": (data) => {
            // 仅有排队进度变化时不推送条目，该事件用于同步剩余条数与检查结束状态
            const progress = data as { checking: boolean; pending: number };
            applyUpdateProgress(progress);
        },
        "log.appended": (data) => {
            // 服务端日志流水，服务页直接显示；事件流中只保留一行摘要
            const entry = data as LogEntry;
            pushEvent(entry.tag === "" ? entry.message : `[${entry.tag}] ${entry.message}`);
            mergeLogEntry(entry);
        },
    });
}
