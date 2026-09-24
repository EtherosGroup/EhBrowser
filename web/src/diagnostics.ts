/*
 * 客户端状态提示的界面侧。
 *
 * 数据有两个来源，在这里合并后交给右上角那组图标渲染：
 *   服务端：SSE 推来的 system.status（内存、磁盘、并发连接、上游耗时、文件系统与内部错误）
 *   浏览器：自己测的「与 EhBrowser 的往返耗时」——服务端不知道浏览器等了多久，这一项只能本地测
 *
 * 图标是状态：异常期间一直显示，好转后自己消失。出错那刻的一次性提醒仍由 messenger 负责。
 */

import { computed, ref } from "vue";

import {
    routePath,
    STATUS_FLAGS,
    type SystemStatusFlag,
    type SystemStatusState,
} from "../../src/api/index.ts";
import congestionIcon from "./assets/status/congestion.svg?url";
import diskBusyIcon from "./assets/status/disk-busy.svg?url";
import fsAnomalyIcon from "./assets/status/fs-anomaly.svg?url";
import internalErrorIcon from "./assets/status/internal-error.svg?url";
import latencyIcon from "./assets/status/latency.svg?url";
import lowMemoryIcon from "./assets/status/low-memory.svg?url";
import upstreamSlowIcon from "./assets/status/upstream-slow.svg?url";

/** 本地往返的采样间隔。够密能跟上变化，又不至于为了状态提示一直在打请求 */
const PROBE_INTERVAL_MS = 5_000;
/** 判定用的最近几次采样 */
const PROBE_SAMPLES = 4;
/** 中位数超过这个值算慢；回落到下面那个值以下才算恢复（迟滞，避免图标闪） */
const LATENCY_ENTER_MS = 800;
const LATENCY_EXIT_MS = 300;

export interface StatusIconSpec {
    readonly icon: string;
    /** 悬浮说明的标题 */
    readonly label: string;
    /** 悬浮说明的补充：为什么会这样 */
    readonly hint: string;
}

/** 每个状态项的图标与说明。顺序由服务端按严重程度排好（见 dto/status.ts 的 STATUS_FLAGS） */
export const STATUS_ICONS: Readonly<Record<SystemStatusFlag, StatusIconSpec>> = {
    "internal-error": {
        icon: internalErrorIcon,
        label: "EhBrowser 客户端内部错误",
        hint: "出现未捕获的异常或 500 响应，堆栈写在终端与日志里；本次运行内会一直显示",
    },
    "fs-anomaly": {
        icon: fsAnomalyIcon,
        label: "文件系统异常",
        hint: "读写报错（权限、只读挂载、介质或空间问题）。具体错误另有提示，详见提示与终端",
    },
    "low-memory": {
        icon: lowMemoryIcon,
        label: "可用运行内存不足",
        hint: "系统可用内存或进程堆接近上限，接下来可能变慢甚至失败",
    },
    "disk-busy": {
        icon: diskBusyIcon,
        label: "磁盘繁忙",
        hint: "读写响应明显变慢：本地库与缓存的加载会跟着慢",
    },
    "upstream-slow": {
        icon: upstreamSlowIcon,
        label: "与上游站点的通信变慢",
        hint: "请求长时间没有返回，常见原因是代理/节点慢，或上游在限流",
    },
    latency: {
        icon: latencyIcon,
        label: "与 EhBrowser 的连接变慢",
        hint: "浏览器与本机服务之间的往返变慢，界面上的操作会显得迟滞",
    },
    congestion: {
        icon: congestionIcon,
        label: "EhBrowser 客户端繁忙",
        hint: "同时连上来的页面过多，或同时在处理的请求过多",
    },
};

/** 服务端推来的当前状态。还没收到过时为 null */
export const serverStatus = ref<SystemStatusState | null>(null);

/** 浏览器自己测的往返耗时（毫秒），最近几次 */
const probes: number[] = [];
const localLatencyMs = ref<number | null>(null);
const localSlow = ref(false);

/** 一条要显示的图标 */
export interface StatusIconItem extends StatusIconSpec {
    readonly flag: SystemStatusFlag;
    /** 采样值拼出的一行补充，没有可说的就是空串 */
    readonly detail: string;
}

export function applyStatusState(state: SystemStatusState): void {
    serverStatus.value = state;
}

/** 浏览器侧测到的一次往返耗时。由 probeLocalLatency 每几秒喂一次 */
export function noteLocalLatency(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return;
    }
    probes.push(durationMs);
    while (probes.length > PROBE_SAMPLES) {
        probes.shift();
    }
    const sorted = [...probes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    localLatencyMs.value = Math.round(median);
    // 迟滞：达到上限算慢，回落到下限以下才算恢复
    if (median >= LATENCY_ENTER_MS) {
        localSlow.value = true;
    } else if (median <= LATENCY_EXIT_MS) {
        localSlow.value = false;
    }
}

/**
 * 定期量一次与本地服务的往返：请求 system.health（不需要令牌、服务端几乎不做事）。
 * 刻意不走 api.ts 的 request：那条路会牵动顶部进度条，后台心跳不该让它闪。
 */
export function startLocalLatencyProbe(): () => void {
    let stopped = false;
    const once = async (): Promise<void> => {
        if (stopped || document.visibilityState === "hidden") {
            return;
        }
        const started = performance.now();
        try {
            await fetch(routePath("system.health"), { cache: "no-store" });
        } catch {
            // 服务端不可达时这里测不出什么，交给别的错误路径提示
            return;
        }
        noteLocalLatency(performance.now() - started);
    };
    const timer = setInterval(() => void once(), PROBE_INTERVAL_MS);
    void once();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

/** 采样值拼成的一行补充说明 */
function detailOf(flag: SystemStatusFlag): string {
    const metrics = serverStatus.value?.metrics;
    if (metrics === undefined) {
        return "";
    }
    switch (flag) {
        case "congestion":
            return `连接 ${metrics.connections} 个页面，在处理 ${metrics.inflight} 个请求`;
        case "low-memory":
            return `可用 ${metrics.freeMemoryMb} MB / 共 ${metrics.totalMemoryMb} MB，堆 ${metrics.heapUsedMb} / ${metrics.heapLimitMb} MB`;
        case "disk-busy":
            return metrics.diskMs === null ? "" : `磁盘探测 ${metrics.diskMs} ms`;
        case "upstream-slow":
            return metrics.upstreamMs === null
                ? ""
                : `上游平均 ${(metrics.upstreamMs / 1000).toFixed(1)} 秒`;
        case "fs-anomaly":
            return `本次运行遇到 ${metrics.fsErrors} 次`;
        case "internal-error":
            return `本次运行遇到 ${metrics.internalErrors} 次`;
        case "latency":
            return localLatencyMs.value === null ? "" : `往返 ${localLatencyMs.value} ms`;
        default:
            return "";
    }
}

/** 当前要显示的图标，顺序跟服务端的严重程度一致 */
export const statusIcons = computed<readonly StatusIconItem[]>(() => {
    const active = new Set<SystemStatusFlag>(serverStatus.value?.active ?? []);
    // 本地的往返耗时只有浏览器知道，服务端不会点亮这一项
    if (localSlow.value) {
        active.add("latency");
    }
    // 统一按 STATUS_FLAGS 的顺序摆，图标位置不随状态变化跳动
    return STATUS_FLAGS.filter((flag) => active.has(flag)).map((flag) => ({
        flag,
        ...STATUS_ICONS[flag],
        detail: detailOf(flag),
    }));
});
