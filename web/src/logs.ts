/*
 * 日志的界面侧状态：目录、文件名与最近若干条
 * 打开服务页时先拉一份，之后每条新日志经 SSE 的 log.appended 并进来
 */

import { ref } from "vue";

import type { LogEntry } from "../../src/api/index.ts";
import { describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";

/** 与服务端环形缓冲同样大小 */
const LIMIT = 500;

export const logEnabled = ref(true);
export const logDirectory = ref("");
export const logDefaultDirectory = ref("");
export const logFileName = ref("");
export const logEntries = ref<readonly LogEntry[]>([]);

function trim(list: readonly LogEntry[]): readonly LogEntry[] {
    return list.length > LIMIT ? list.slice(list.length - LIMIT) : list;
}

/** 读日志目录与最近若干条 */
export async function loadLogs(): Promise<void> {
    try {
        const state = await request("log.state", { query: { limit: LIMIT } });
        logEnabled.value = state.enabled;
        logDirectory.value = state.directory;
        logDefaultDirectory.value = state.defaultDirectory;
        logFileName.value = state.file;
        logEntries.value = trim(state.entries);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 一条新日志：追加到末尾 */
export function mergeLogEntry(entry: LogEntry): void {
    logEntries.value = trim([...logEntries.value, entry]);
}

/** 时间戳转成本地时间，用于界面显示 */
export function logTime(at: number): string {
    return new Date(at * 1000).toLocaleTimeString();
}
