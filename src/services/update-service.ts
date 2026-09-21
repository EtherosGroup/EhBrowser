/*
 * 本地画廊的更新检查。
 *
 * 逐个向上游查询该画廊是否存在更新版本：取详情中的 current 关系，再取新版本的发布时间。
 * 上游限流较严，默认 5 秒一次请求，因此按队列串行查询，查到一条推送一条，
 * 界面边查边显示，不需要等整批查完。
 *
 * 结果只留在内存中，全局共享一份，应用重启即清空。
 */

import type { UpdateCheckTarget, UpdateEntry, UpdateState } from "../api/index.ts";
import type { GalleryService } from "./gallery-service.ts";
import type { LocalLibrary } from "./local-library.ts";

export interface UpdateService {
    state(): UpdateState;
    /**
     * 发起检查。
     *
     * 不传 targets 时检查全部本地画廊（本地画廊页的用法）。
     * 传入 targets 时只检查这些条目（收藏页传入收藏条目，用于判断标记是否应移到新版本）。
     * reset 为真时先清空已有结果。排队后立刻返回状态，实际检查在后台逐条执行。
     */
    check(input: {
        targets?: readonly UpdateCheckTarget[];
        keys?: readonly string[];
        reset?: boolean;
    }): Promise<UpdateState>;
    /** 每查完一条调用一次，由入口接入 SSE 广播 */
    onChange(listener: (entry: UpdateEntry) => void): () => void;
    /**
     * 进度变化时调用一次（排队、查完一条、整轮结束）。
     * 界面据此同步「还剩几条」与「是否仍在检查」。缺少整轮结束时的这次通知，
     * 按钮会一直停留在「正在检查…」。
     */
    onState(listener: (state: UpdateState) => void): () => void;
    /**
     * 从结果中删除这些 key（对应「删除更新任务」）。
     * 只修改更新列表，不影响本地文件；正在排队的条目也一并撤除。
     */
    forget(keys: readonly string[]): UpdateState;
}

export interface UpdateServiceOptions {
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

/** 本地画廊的身份：与本地库、播放列表保持一致 */
function keyOf(target: UpdateCheckTarget): string {
    return target.key;
}

/** 本地画廊 -> 检查目标 */
function targetOf(gallery: {
    gid: number;
    token: string;
    resolution: string;
    title: string;
    pageCount: number;
    summary: { title: string; thumbUrl: string; postedAt: number } | null;
    downloadedAt: number;
}): UpdateCheckTarget {
    return {
        key: `${gallery.gid}-${gallery.resolution}`,
        gid: gallery.gid,
        token: gallery.token,
        title: gallery.summary?.title ?? gallery.title,
        thumbUrl: gallery.summary?.thumbUrl ?? "",
        postedAt: gallery.summary?.postedAt ?? gallery.downloadedAt,
        pageCount: gallery.pageCount,
    };
}

export function createUpdateService(
    library: LocalLibrary,
    gallery: GalleryService,
    options: UpdateServiceOptions = {},
): UpdateService {
    const log = options.logger ?? (() => undefined);
    /** key -> 结果。Map 的插入顺序就是检查顺序 */
    const entries = new Map<string, UpdateEntry>();
    const listeners = new Set<(entry: UpdateEntry) => void>();
    const stateListeners = new Set<(state: UpdateState) => void>();
    /** 排队未查的 key。值中记录检查目标与来源，收藏与本地画廊共用一条队列 */
    let queue: string[] = [];
    /**
     * 尚未查完的条数，含正在查的那一条。
     * 该值不能直接用 queue.length：正在查的那条已从队列中取出，
     * 界面上的「还剩 N」会从 N-1 起算，看起来少一条。
     */
    let remaining = 0;
    /**
     * 被「删除更新任务」移除的 key。
     * 正在查的那条同样会被移除：其查完的结果需要丢弃，否则数秒后又会重新出现在列表中。
     */
    const forgotten = new Set<string>();
    const pending = new Map<
        string,
        { target: UpdateCheckTarget; source: "library" | "favorites" }
    >();
    /**
     * 轮次号。reset 时加一：上一轮在途的请求作废，查完也不再写入结果，
     * 否则「清空后只查选中项」会被上一轮迟到的结果污染。
     */
    let generation = 0;
    /** 当前运行中的轮次，null 表示没有活动循环 */
    let activeRun: number | null = null;
    /** 每轮一个取消信号：reset 时中断在途的上游请求 */
    let controller = new AbortController();

    function state(): UpdateState {
        return {
            // 有排队或正在请求的条目都算「检查中」，界面上的进度才不会频繁闪烁
            checking: activeRun !== null || queue.length > 0,
            entries: [...entries.values()],
            pending: remaining,
        };
    }

    function publishState(): void {
        const next = state();
        for (const listener of stateListeners) {
            try {
                listener(next);
            } catch {
                // 单个订阅者异常不影响其余订阅者
            }
        }
    }

    function publish(entry: UpdateEntry): void {
        remaining = Math.max(0, remaining - 1);
        // 已被移除的条目：结果丢弃，进度仍然推进
        if (!forgotten.has(entry.key)) {
            entries.set(entry.key, entry);
            for (const listener of listeners) {
                listener(entry);
            }
        }
        // 这一条查完后剩余条数减少，进度随之更新一次
        publishState();
    }

    async function checkOne(
        target: UpdateCheckTarget,
        source: "library" | "favorites",
        signal: AbortSignal,
    ): Promise<UpdateEntry> {
        const base = {
            key: target.key,
            gid: target.gid,
            source,
            resolution: target.resolution ?? "",
            title: target.title,
            thumbUrl: target.thumbUrl,
            localPostedAt: target.postedAt,
            localPageCount: target.pageCount,
            checkedAt: Math.floor(Date.now() / 1000),
        };
        try {
            // 更新检查必须请求上游接口，不能使用详情缓存，否则刚发布的新版本会被判为「已是最新」
            const detail = await gallery.detail(target.gid, target.token, { fresh: true });
            if (signal.aborted) {
                throw new Error("已取消");
            }
            /*
             * 上游刚取回的详情比本地快照准确，本地这一版的日期与封面以它为准。
             * 收藏条目本地只记录加入收藏的时间，不作修正时「当前」一栏会显示成加入时间。
             * 页数仍用本地记录值：本地下载可能比上游少几页，该差值需要展示给用户。
             */
            const held = {
                ...base,
                title: detail.title === "" ? base.title : detail.title,
                thumbUrl: detail.thumbUrl === "" ? base.thumbUrl : detail.thumbUrl,
                localPostedAt: detail.postedAt > 0 ? detail.postedAt : base.localPostedAt,
            };
            // current 指向自身时同样算「已是最新」
            if (detail.current === null || detail.current.gid === target.gid) {
                return { ...held, latest: null, error: null };
            }
            // 存在更新版本：一并取回其发布时间与页数，界面上需要显示「当前 -> 更新至」
            const newest = await gallery.summaryOf(
                detail.current.gid,
                detail.current.token,
                signal,
            );
            return {
                ...held,
                latest: {
                    gid: detail.current.gid,
                    token: detail.current.token,
                    postedAt: newest.postedAt,
                    pageCount: newest.pageCount,
                },
                error: null,
            };
        } catch (error) {
            return {
                ...base,
                latest: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * 逐条检查。同一时刻只运行一个循环，每一轮都会检查轮次号：
     * 被 reset 顶替后立即退出，已取回的结果也一并丢弃。
     */
    async function run(gen: number): Promise<void> {
        if (activeRun !== null) {
            // 已有循环在运行：它会自行发现轮次变化，此处不再新建
            return;
        }
        activeRun = gen;
        const signal = controller.signal;
        try {
            for (;;) {
                if (gen !== generation) {
                    return;
                }
                const key = queue.shift();
                if (key === undefined) {
                    break;
                }
                const target = pending.get(key);
                if (target === undefined) {
                    // 该条目在排队期间被删除，不再保留在待查队列中
                    continue;
                }
                const entry = await checkOne(target.target, target.source, signal);
                if (gen !== generation) {
                    // 查完时已换代：该条属于上一轮，不写入结果
                    return;
                }
                publish(entry);
                log(
                    "info",
                    entry.error === null
                        ? `更新检查：#${target.target.gid} ${entry.latest === null ? "已是最新" : "有更新"}`
                        : `更新检查失败：#${target.target.gid} ${entry.error}`,
                );
            }
        } finally {
            if (activeRun === gen) {
                activeRun = null;
            }
            // 换代期间排入的新队列需要继续执行
            if (generation !== gen) {
                void run(generation);
            } else {
                // 整轮结束：checked 归零，界面据此把按钮恢复成「检查更新*」
                publishState();
            }
        }
    }

    return {
        state,

        async check(input) {
            const reset = input.reset === true;
            if (reset) {
                // 作废上一轮：清空结果与队列，并中断在途请求
                generation += 1;
                queue = [];
                remaining = 0;
                forgotten.clear();
                entries.clear();
                controller.abort();
                controller = new AbortController();
            }
            const gen = generation;
            // 检查目标：显式传入时使用传入的条目（收藏页传收藏条目），否则检查全部本地画廊
            const targets: { target: UpdateCheckTarget; source: "library" | "favorites" }[] =
                input.targets === undefined || input.targets.length === 0
                    ? (await library.list()).map((item) => ({
                          target: targetOf(item),
                          source: "library" as const,
                      }))
                    : input.targets.map((target) => ({
                          target,
                          source: "favorites" as const,
                      }));
            const wanted =
                input.keys === undefined || input.keys.length === 0
                    ? targets
                    : targets.filter((item) => input.keys?.includes(item.target.key) === true);
            const queued = new Set(queue);
            for (const item of wanted) {
                const key = item.target.key;
                // 已在队列中的不重复排队；已查过的仅在本次要求重置时重新排队
                if (queued.has(key) || (entries.has(key) && !reset)) {
                    continue;
                }
                queued.add(key);
                pending.set(key, item);
                queue.push(key);
                // 显式重查时将其从已删除集合中移除，否则结果会一直被丢弃
                forgotten.delete(key);
                remaining += 1;
            }
            void run(gen);
            const next = state();
            // 排完队先发布一次状态，界面立刻显示「还剩 N」
            publishState();
            return next;
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        onState(listener) {
            stateListeners.add(listener);
            return () => {
                stateListeners.delete(listener);
            };
        },

        forget(keys) {
            const wanted = new Set(keys);
            for (const key of wanted) {
                entries.delete(key);
                pending.delete(key);
                forgotten.add(key);
            }
            // 撤除仍在排队的条目时，计数同步减少，否则「还剩 N」会停在该值上
            const queuedRemoved = queue.filter((key) => wanted.has(key)).length;
            if (queuedRemoved > 0) {
                queue = queue.filter((key) => !wanted.has(key));
                remaining = Math.max(0, remaining - queuedRemoved);
            }
            log("info", `已从更新列表移除 ${wanted.size} 条`);
            publishState();
            return state();
        },
    };
}
