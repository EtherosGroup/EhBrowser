/*
 * 客户端状态提示：在本地采样，判断「现在是不是处于某种异常状态」，把活动的那几项推给界面，
 * 界面在右上角用小图标覆盖展示。图标是状态（异常期间一直在），messenger 的提示是提醒（出错那刻弹一次），
 * 两者不互相替代：文件系统出错时既记账点亮图标，错误本身仍由原来的路径照常提示。
 *
 * 采样分两档，都是为了便宜：
 *   每 TICK_MS 一次：内存、并发连接、在途请求、上游耗时、各类错误的最近发生时间（纯读内存里的计数）
 *   每 PROBE_EVERY_TICKS 次一档：文件系统探测（写 4KB 落盘 + 读回 + 删），测磁盘响应快不快
 *
 * 每一项都带迟滞：进入与退出用不同阈值，避免在阈值上下抖动时图标反复闪。
 * 数值都是经验值，觉得太灵敏或太迟钝就改下面那组常量。
 *
 * 「与 EhBrowser 的连接速度慢」（latency）由浏览器侧自己测（它才知道自己等了多少），
 * 因此服务端不会点亮这一项，界面把本地测到的结果与服务端推来的状态合并展示。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";

import type { SystemStatusFlag, SystemStatusMetrics, SystemStatusState } from "../api/index.ts";

/** 采样间隔 */
const TICK_MS = 2_000;
/** 每多少次采样做一次磁盘探测（写文件比读计数贵，没必要每次都做） */
const PROBE_EVERY_TICKS = 5;
/** 探测文件大小：够触发一次真实写入与落盘，又不值得心疼 */
const PROBE_BYTES = 4 * 1024;

/** 客户端繁忙：挂着的连接数（约等于打开的页面数）与在途请求数 */
const CONGESTION_CONNECTIONS = 6;
const CONGESTION_INFLIGHT = 24;
/** 上游变慢：最近几次上游请求的平均耗时（毫秒） */
const UPSTREAM_ENTER_MS = 8_000;
const UPSTREAM_EXIT_MS = 4_000;
/** 磁盘繁忙：探测耗时（毫秒） */
const DISK_ENTER_MS = 400;
const DISK_EXIT_MS = 150;
/** 内存紧张：系统可用内存低于总内存的这个比例，或堆已用超过堆上限的这个比例 */
const MEMORY_FREE_ENTER_RATIO = 0.06;
const MEMORY_FREE_EXIT_RATIO = 0.12;
const HEAP_ENTER_RATIO = 0.9;
const HEAP_EXIT_RATIO = 0.8;
/** 文件系统错误：最近这么长时间内出现过就保持提示 */
const FS_ERROR_WINDOW_MS = 60_000;
/** 内部错误：这个窗口内出现这么多次算异常；未捕获异常本身直接黏住 */
const INTERNAL_ERROR_WINDOW_MS = 60_000;
const INTERNAL_ERROR_BURST = 3;
/** 同一类错误写日志的最小间隔，避免探测持续失败时刷屏 */
const LOG_INTERVAL_MS = 60_000;
/** 慢判定需要连续几次采样都成立，避免一次抖动就报 */
const SLOW_STREAK = 2;
/** 上游耗时的滑动窗口 */
const UPSTREAM_SAMPLES = 5;

/** 图标的先后顺序：越靠前越严重。界面按这个顺序摆，不随状态变化跳动 */
const SEVERITY: readonly SystemStatusFlag[] = [
    "internal-error",
    "fs-anomaly",
    "low-memory",
    "disk-busy",
    "upstream-slow",
    "latency",
    "congestion",
];

export interface DiagnosticsService {
    /** 当前状态。SSE 刚接上时界面靠它补一次 */
    state(): SystemStatusState;
    /** 状态项集合或采样值变化时回调。返回取消函数 */
    onChange(listener: (state: SystemStatusState) => void): () => void;
    /** 服务端上报：当前挂着的 SSE 连接数 */
    noteConnections(count: number): void;
    /** 服务端上报：一个请求开始处理 / 处理结束 */
    noteRequestStart(): void;
    noteRequestEnd(): void;
    /** 服务端上报：一次上游请求的耗时 */
    noteUpstream(durationMs: number): void;
    /** 上报一次文件系统错误。图标立刻亮起，错误本身仍按原样返回或提示 */
    noteFsError(reason: string): void;
    /** 上报一次内部错误。fatal 为真时（未捕获异常）在本次运行内一直保持提示 */
    noteInternalError(reason: string, fatal?: boolean): void;
    /**
     * 强制点亮或熄灭某一项，绕过阈值判定。只给 /debug 页面用：
     * 磁盘、内存这些状态不好在真机上复现，需要能按按钮把它们摆出来看图标。
     */
    forceFlag(flag: SystemStatusFlag, forced: boolean): void;
    /** 当前被强制的那几项 */
    forcedFlags(): readonly SystemStatusFlag[];
    /** 清掉全部强制项 */
    clearForced(): void;
    stop(): void;
}

/** 判定阈值。默认值见文件头那组常量，传进来只为覆盖其中几项（调参或验证用） */
export interface DiagnosticsThresholds {
    readonly congestionConnections: number;
    readonly congestionInflight: number;
    readonly upstreamEnterMs: number;
    readonly upstreamExitMs: number;
    readonly diskEnterMs: number;
    readonly diskExitMs: number;
    readonly memoryFreeEnterRatio: number;
    readonly memoryFreeExitRatio: number;
    readonly heapEnterRatio: number;
    readonly heapExitRatio: number;
    readonly fsErrorWindowMs: number;
    readonly internalErrorWindowMs: number;
    readonly internalErrorBurst: number;
    readonly slowStreak: number;
}

export interface DiagnosticsOptions {
    /** 磁盘探测的落点（会在其下用 temp/ 子目录）。传空串则跳过磁盘探测 */
    readonly probeDirectory?: string;
    readonly logger?: (level: "info" | "warn", message: string) => void;
    /** 覆盖部分判定阈值 */
    readonly thresholds?: Partial<DiagnosticsThresholds>;
}

export function createDiagnosticsService(options: DiagnosticsOptions = {}): DiagnosticsService {
    const log = options.logger ?? ((): void => undefined);
    const listeners = new Set<(state: SystemStatusState) => void>();

    /** 当前亮着的状态项 */
    const active = new Set<SystemStatusFlag>();
    /** 被 /debug 强制的那几项。与判定结果分开存，清掉强制项后立刻回到真实判定 */
    const forced = new Set<SystemStatusFlag>();
    const upstreamSamples: number[] = [];
    let connections = 0;
    let inflight = 0;
    let diskMs: number | null = null;
    let fsErrorAt = 0;
    let fsErrorCount = 0;
    let internalErrorAt = 0;
    let internalErrorCount = 0;
    let internalSticky = false;
    let upstreamSlowStreak = 0;
    let diskSlowStreak = 0;
    let ticks = 0;
    let last: SystemStatusState | null = null;
    let fsLoggedAt = 0;
    let internalLoggedAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const limits: DiagnosticsThresholds = {
        congestionConnections: CONGESTION_CONNECTIONS,
        congestionInflight: CONGESTION_INFLIGHT,
        upstreamEnterMs: UPSTREAM_ENTER_MS,
        upstreamExitMs: UPSTREAM_EXIT_MS,
        diskEnterMs: DISK_ENTER_MS,
        diskExitMs: DISK_EXIT_MS,
        memoryFreeEnterRatio: MEMORY_FREE_ENTER_RATIO,
        memoryFreeExitRatio: MEMORY_FREE_EXIT_RATIO,
        heapEnterRatio: HEAP_ENTER_RATIO,
        heapExitRatio: HEAP_EXIT_RATIO,
        fsErrorWindowMs: FS_ERROR_WINDOW_MS,
        internalErrorWindowMs: INTERNAL_ERROR_WINDOW_MS,
        internalErrorBurst: INTERNAL_ERROR_BURST,
        slowStreak: SLOW_STREAK,
        ...options.thresholds,
    };

    const probeDirectory = options.probeDirectory ?? "";
    const probeFile = probeDirectory === "" ? "" : join(probeDirectory, "temp", "disk-probe.bin");

    /**
     * 按迟滞更新一项：已经亮着的看 exit，还没亮的看 enter。
     * 同一个 flag 的两次判定都由调用方给出，这里只负责状态迁移。
     */
    function setFlag(flag: SystemStatusFlag, enter: boolean, exit: boolean): void {
        if (active.has(flag)) {
            if (exit) {
                active.delete(flag);
            }
            return;
        }
        if (enter) {
            active.add(flag);
        }
    }

    /** V8 的堆上限（--max-old-space-size 定下来的那个）。取不到时返回 null，调用方退回 heapTotal */
    function heapLimitMb(): number | null {
        try {
            const stats = getHeapStatistics();
            if (stats.heap_size_limit === 0) {
                return null;
            }
            return Math.round(stats.heap_size_limit / 1024 / 1024);
        } catch {
            return null;
        }
    }

    function memory(): {
        freeMb: number;
        totalMb: number;
        heapUsedMb: number;
        heapLimitMb: number;
    } {
        const heap = process.memoryUsage();
        return {
            freeMb: Math.round(freemem() / 1024 / 1024),
            totalMb: Math.round(totalmem() / 1024 / 1024),
            heapUsedMb: Math.round(heap.heapUsed / 1024 / 1024),
            heapLimitMb: heapLimitMb() ?? Math.round(heap.heapTotal / 1024 / 1024),
        };
    }

    function evaluateMemory(): void {
        const now = memory();
        const freeRatio = now.totalMb === 0 ? 1 : now.freeMb / now.totalMb;
        const heapRatio = now.heapLimitMb === 0 ? 0 : now.heapUsedMb / now.heapLimitMb;
        setFlag(
            "low-memory",
            freeRatio < limits.memoryFreeEnterRatio || heapRatio > limits.heapEnterRatio,
            freeRatio > limits.memoryFreeExitRatio && heapRatio < limits.heapExitRatio,
        );
    }

    function evaluateConnections(): void {
        setFlag(
            "congestion",
            connections >= limits.congestionConnections || inflight >= limits.congestionInflight,
            connections < Math.ceil(limits.congestionConnections * 0.6) &&
                inflight < Math.ceil(limits.congestionInflight * 0.6),
        );
    }

    function evaluateUpstream(): void {
        if (upstreamSamples.length === 0) {
            upstreamSlowStreak = 0;
            setFlag("upstream-slow", false, true);
            return;
        }
        const average = upstreamAverage();
        if (average >= limits.upstreamEnterMs) {
            upstreamSlowStreak += 1;
        } else if (average <= limits.upstreamExitMs) {
            upstreamSlowStreak = 0;
        }
        setFlag("upstream-slow", upstreamSlowStreak >= limits.slowStreak, upstreamSlowStreak === 0);
    }

    function upstreamAverage(): number {
        return upstreamSamples.reduce((sum, value) => sum + value, 0) / upstreamSamples.length;
    }

    function evaluateDisk(): void {
        if (diskMs === null) {
            diskSlowStreak = 0;
            setFlag("disk-busy", false, true);
            return;
        }
        if (diskMs >= limits.diskEnterMs) {
            diskSlowStreak += 1;
        } else if (diskMs <= limits.diskExitMs) {
            diskSlowStreak = 0;
        }
        setFlag("disk-busy", diskSlowStreak >= limits.slowStreak, diskSlowStreak === 0);
    }

    function evaluateErrors(now: number): void {
        const recentFs = fsErrorAt !== 0 && now - fsErrorAt <= limits.fsErrorWindowMs;
        setFlag("fs-anomaly", recentFs, !recentFs);
        const burst =
            internalErrorAt !== 0 &&
            now - internalErrorAt <= limits.internalErrorWindowMs &&
            internalErrorCount >= limits.internalErrorBurst;
        setFlag("internal-error", internalSticky || burst, !internalSticky && !burst);
    }

    function snapshot(now: number): SystemStatusState {
        const now2 = memory();
        const metrics: SystemStatusMetrics = {
            connections,
            inflight,
            upstreamMs: upstreamSamples.length === 0 ? null : Math.round(upstreamAverage()),
            diskMs: diskMs === null ? null : Math.round(diskMs),
            freeMemoryMb: now2.freeMb,
            totalMemoryMb: now2.totalMb,
            heapUsedMb: now2.heapUsedMb,
            heapLimitMb: now2.heapLimitMb,
            fsErrors: fsErrorCount,
            internalErrors: internalErrorCount,
        };
        return {
            active: SEVERITY.filter((flag) => active.has(flag) || forced.has(flag)),
            metrics,
            sampledAt: Math.floor(now / 1000),
        };
    }

    /** 状态项集合或采样值变了才推给界面 */
    function publish(now: number): void {
        const next = snapshot(now);
        const previous = last;
        last = next;
        const sameFlags =
            previous !== null &&
            previous.active.length === next.active.length &&
            previous.active.every((flag, index) => next.active[index] === flag);
        const sameMetrics =
            previous !== null && JSON.stringify(previous.metrics) === JSON.stringify(next.metrics);
        if (sameFlags && sameMetrics) {
            return;
        }
        if (!sameFlags) {
            const added = next.active.filter(
                (flag) => previous === null || !previous.active.includes(flag),
            );
            const gone = (previous?.active ?? []).filter((flag) => !next.active.includes(flag));
            const parts = [
                added.length > 0 ? `亮起 ${added.join("、")}` : "",
                gone.length > 0 ? `熄灭 ${gone.join("、")}` : "",
            ].filter((part) => part !== "");
            if (parts.length > 0) {
                log("warn", `状态提示：${parts.join("，")}`);
            }
        }
        for (const listener of listeners) {
            listener(next);
        }
    }

    /** 记一次文件系统错误：立刻点亮图标（不等下一次采样）并限频写日志 */
    function recordFsError(reason: string): void {
        fsErrorCount += 1;
        fsErrorAt = Date.now();
        if (fsErrorAt - fsLoggedAt >= LOG_INTERVAL_MS) {
            fsLoggedAt = fsErrorAt;
            log("warn", `文件系统异常：${reason}`);
        }
        evaluateErrors(fsErrorAt);
        publish(fsErrorAt);
    }

    /** 记一次内部错误。fatal 为真（未捕获异常）时本次运行内一直保持提示 */
    function recordInternalError(reason: string, fatal: boolean): void {
        internalErrorCount += 1;
        internalErrorAt = Date.now();
        if (fatal) {
            internalSticky = true;
        }
        if (internalErrorAt - internalLoggedAt >= LOG_INTERVAL_MS) {
            internalLoggedAt = internalErrorAt;
            log(fatal ? "warn" : "info", `客户端内部错误：${reason}`);
        }
        evaluateErrors(internalErrorAt);
        publish(internalErrorAt);
    }

    /** 探测一次文件系统：写、落盘、读回、删掉，全程计时 */
    async function probeDisk(): Promise<void> {
        if (probeFile === "") {
            return;
        }
        const started = performance.now();
        try {
            await mkdir(join(probeDirectory, "temp"), { recursive: true });
            await writeFile(probeFile, Buffer.alloc(PROBE_BYTES, 0x5a));
            const back = await readFile(probeFile);
            if (back.length !== PROBE_BYTES) {
                throw new Error(`回读长度不符（${back.length}）`);
            }
        } catch (error) {
            diskMs = null;
            // 探测失败本身就是文件系统异常，统一由 recordFsError 记账与点亮图标
            recordFsError(
                `磁盘探测失败：${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        } finally {
            await rm(probeFile, { force: true }).catch(() => undefined);
        }
        diskMs = performance.now() - started;
    }

    function tick(): void {
        ticks += 1;
        const now = Date.now();
        evaluateMemory();
        evaluateConnections();
        evaluateUpstream();
        evaluateDisk();
        evaluateErrors(now);
        publish(now);

        if (probeFile !== "" && ticks % PROBE_EVERY_TICKS === 0) {
            void probeDisk();
        }
    }

    timer = setInterval(tick, TICK_MS);
    timer.unref?.();

    return {
        state(): SystemStatusState {
            const now = Date.now();
            const current = snapshot(now);
            last = current;
            return current;
        },

        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        noteConnections(count) {
            connections = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : connections;
        },

        noteRequestStart() {
            inflight += 1;
        },

        noteRequestEnd() {
            inflight = Math.max(0, inflight - 1);
        },

        noteUpstream(durationMs) {
            if (!Number.isFinite(durationMs) || durationMs < 0) {
                return;
            }
            upstreamSamples.push(durationMs);
            while (upstreamSamples.length > UPSTREAM_SAMPLES) {
                upstreamSamples.shift();
            }
        },

        noteFsError(reason) {
            recordFsError(reason);
        },

        noteInternalError(reason, fatal = false) {
            recordInternalError(reason, fatal);
        },

        forceFlag(flag, isForced) {
            if (isForced) {
                forced.add(flag);
            } else {
                forced.delete(flag);
            }
            publish(Date.now());
        },

        forcedFlags() {
            return [...forced];
        },

        clearForced() {
            forced.clear();
            publish(Date.now());
        },

        stop() {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
            listeners.clear();
        },
    };
}
