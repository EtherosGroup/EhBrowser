/*
 * 下载服务：归档下载任务的排队、执行与取消。
 * 单并发：上游限流严格，且归档本身是服务端打包，串行更稳。
 * 任务状态落在 downloads 表，进度经 SSE 推送。进程退出后未完成任务标记为失败，不做断点续传。
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
    CancelDownloadResult,
    DownloadStatus,
    DownloadTask,
    EnqueueDownloadInput,
    GalleryDetail,
    GallerySummary,
} from "../api/index.ts";
import { activeAccount, type ConfigContext } from "../config/index.ts";
import { describeError } from "../platform/errors.ts";
import { APP_DIR_NAME } from "../platform/paths.ts";
import {
    getDispatcher,
    LoginRequiredError,
    resolveArchiveUrl,
    type ArchiveRequestOptions,
} from "../eh/index.ts";
import { downloadFile, joinIfRelative } from "./download-file.ts";
import { libraryFolderName, type LocalLibrary, type LocalGalleryMeta } from "./local-library.ts";
import type { GalleryService } from "./gallery-service.ts";
import type { UpstreamService } from "./upstream-service.ts";

export interface DownloadService {
    list(): readonly DownloadTask[];
    create(input: EnqueueDownloadInput): Promise<DownloadTask>;
    cancel(id: string): Promise<CancelDownloadResult>;
    /** 重新排队。只对失败或取消的任务有效，其他状态原样返回 */
    retry(id: string): Promise<DownloadTask>;
    onChange(listener: (task: DownloadTask) => void): () => void;
    /** 启动时调用：把上次残留的未完成任务标记为失败。 */
    recover(): number;
}

export interface DownloadServiceOptions {
    readonly logger?: (level: "info" | "warn", message: string) => void;
    /** 未配置下载目录时的落盘位置。 */
    readonly fallbackDirectory: (ctx: ConfigContext) => string;
    /** 落盘与元数据都交给本地库，下载服务只管把文件拿下来与解压。 */
    readonly library: LocalLibrary;
    /** 逐页下载要用：取每一页的图片地址，以及画廊总页数。 */
    readonly gallery: GalleryService;
    /** 画廊信息快照，写进 .ehbrowser 供离线展示。取不到就留 null */
    readonly summarise?: (
        gid: number,
        token: string,
        signal: AbortSignal,
    ) => Promise<GallerySummary | null>;
}

interface Row {
    id: string;
    gid: number;
    token: string;
    title: string;
    resolution: string;
    status: string;
    bytes_done: number;
    bytes_total: number | null;
    pages_done: number;
    page_count: number | null;
    output_path: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
}

export function createDownloadService(
    ctx: ConfigContext,
    upstream: UpstreamService,
    options: DownloadServiceOptions,
): DownloadService {
    const log = options.logger ?? (() => undefined);
    const listeners = new Set<(task: DownloadTask) => void>();
    const controllers = new Map<string, AbortController>();
    /*
     * 每个任务当前那一次执行的令牌。
     * 取消是异步生效的：任务被取消后马上又点了重试，上一次执行的收尾会晚一步跑，
     * 那时它会用 cancelled 把刚排上的队盖掉（界面上表现为「点了重试没反应」）。
     * 收尾前先比对令牌，只有还是自己那一轮才允许改状态。
     */
    const executions = new Map<string, number>();
    let executionToken = 0;
    const speeds = new Map<string, number>();
    let running = false;

    const db = ctx.db.raw;

    function rowOf(id: string): Row | null {
        const row = db.prepare("select * from downloads where id = ?").get(id) as Row | undefined;
        return row ?? null;
    }

    function toTask(row: Row): DownloadTask {
        const bytesTotal = row.bytes_total;
        return {
            id: row.id,
            gid: row.gid,
            token: row.token,
            title: row.title,
            resolution: row.resolution,
            status: row.status as DownloadStatus,
            progress:
                row.page_count !== null && row.page_count > 0
                    ? row.pages_done / row.page_count
                    : bytesTotal === null || bytesTotal <= 0
                      ? null
                      : row.bytes_done / bytesTotal,
            bytesDone: row.bytes_done,
            bytesTotal,
            speedBps: speeds.get(row.id) ?? null,
            pagesDone: row.pages_done,
            pageCount: row.page_count,
            outputPath: row.output_path,
            error: row.error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    function patchRow(id: string, patch: Partial<Row>): void {
        const current = rowOf(id);
        if (current === null) {
            return;
        }
        const next: Row = { ...current, ...patch, updated_at: Math.floor(Date.now() / 1000) };
        db.prepare(
            `update downloads set title = ?, status = ?, bytes_done = ?, bytes_total = ?,
             pages_done = ?, page_count = ?, output_path = ?, error = ?, updated_at = ? where id = ?`,
        ).run(
            next.title,
            next.status,
            next.bytes_done,
            next.bytes_total,
            next.pages_done,
            next.page_count,
            next.output_path,
            next.error,
            next.updated_at,
            next.id,
        );
        broadcast(next);
    }

    function broadcast(row: Row): void {
        const task = toTask(row);
        for (const listener of listeners) {
            try {
                listener(task);
            } catch {
                // 单个订阅者异常不影响其余订阅者。
            }
        }
    }

    function archiveOptions(signal: AbortSignal): ArchiveRequestOptions {
        const account = activeAccount(ctx.auth.get());
        const site = account?.site ?? ctx.user.get().preferredSite;
        if (account === null) {
            return { site, signal };
        }
        const cookies: Record<string, string> = {
            ipb_member_id: account.cookies.ipbMemberId,
            ipb_pass_hash: account.cookies.ipbPassHash,
        };
        if (account.cookies.igneous !== "") {
            cookies["igneous"] = account.cookies.igneous;
        }
        if (account.cookies.ipbSessionId !== undefined) {
            cookies["ipb_session_id"] = account.cookies.ipbSessionId;
        }
        return { site, cookies, signal };
    }

    /** 取回标题用于展示。失败时保留 gid，不写错误状态。 */
    async function fillTitle(
        id: string,
        gid: number,
        token: string,
        signal: AbortSignal,
    ): Promise<void> {
        let title = "";
        try {
            const info = await upstream.gdata([[gid, token]], {
                timeoutMs: TITLE_TIMEOUT_MS,
                signal,
            });
            title = info[0]?.title ?? "";
        } catch (error) {
            if (signal.aborted) {
                return;
            }
            log("warn", `标题读取失败：#${gid} ${describeError(error)}`);
        }
        if (title === "") {
            return;
        }
        const current = rowOf(id);
        if (current === null || current.title !== "") {
            return;
        }
        patchRow(id, { title });
    }

    /** 下载根目录：配置优先，未配置时用默认落点。 */
    function directoryOf(): string {
        const configured = ctx.user.get().download.directory;
        return configured === "" ? options.fallbackDirectory(ctx) : configured;
    }

    /** 取画廊信息快照写进元数据。失败不影响下载本身，只是本地卡片少了信息。 */
    async function loadSummary(row: Row, signal: AbortSignal): Promise<GallerySummary | null> {
        if (options.summarise === undefined) {
            return null;
        }
        try {
            return await options.summarise(row.gid, row.token, signal);
        } catch (error) {
            if (!signal.aborted) {
                log("warn", `画廊信息读取失败：#${row.gid} ${describeError(error)}`);
            }
            return null;
        }
    }

    /*
     * 取详情页快照一并落盘。这份快照就是本地浏览时用的详情：
     * 存下来之后，播放器与详情页不必再向上游要详情（离线也能看标签、评分、页数）。
     * 取不到不算下载失败：元数据里留 null，浏览时再按普通画廊走一次上游。
     */
    async function loadDetail(row: Row): Promise<GalleryDetail | null> {
        try {
            return await options.gallery.detail(row.gid, row.token);
        } catch (error) {
            log("warn", `画廊详情读取失败：#${row.gid} ${describeError(error)}`);
            return null;
        }
    }

    /** 这次取不到详情时沿用上一版落盘的快照，已有的详情不会被覆盖掉。 */
    async function detailFor(
        row: Row,
        fetched: GalleryDetail | null,
    ): Promise<GalleryDetail | null> {
        if (fetched !== null) {
            return fetched;
        }
        return await options.library.storedDetail(row.gid, row.token);
    }

    /*
     * 落盘位置：<下载根>/<分辨率>@<画廊名>/。
     * 归档先下到目录里的 archive.zip，解压出图片后按 keepArchive 决定是否留着。
     */
    function folderFor(row: Row): { folder: string; path: string; archive: string } {
        const title = row.title === "" ? `g${row.gid}` : row.title;
        const folder = libraryFolderName(row.resolution, title);
        const path = joinIfRelative(directoryOf(), folder);
        return { folder, path, archive: join(path, "archive.zip") };
    }

    /** 逐页下载的 resolution 形如 pages-org / pages-res。 */
    function isPageMode(resolution: string): boolean {
        return resolution === "pages-org" || resolution === "pages-res";
    }

    /** 从图片地址猜扩展名，猜不到按 jpg。 */
    function extensionOf(url: string): string {
        const matched = /\.([A-Za-z0-9]{2,5})(?:\?|#|$)/.exec(url);
        const extension = matched?.[1]?.toLowerCase();
        return extension === undefined || extension.length > 4 ? "jpg" : extension;
    }

    /*
     * 逐页下载。
     * 图片页（showpage）本身不需要登录，因此没有账号也能把整本下下来。
     * 代价是要逐页向上游要地址，而上游限流严格（默认 5 秒一次），页数多时很慢。
     * 支持续传：目录里已经下好的页一律留着不重下，只补缺的那些（见 prepareResume）。
     */
    async function runPageTask(id: string, row: Row, controller: AbortController): Promise<void> {
        const quality = row.resolution === "pages-org" ? "org" : "res";
        const info = await options.gallery.detail(row.gid, row.token);
        const total = info.pageCount;
        // 标题要先补上再算目录名：落盘目录是 <分辨率>@<画廊名>，用兜底名建出来的目录不好认。
        patchRow(id, {
            title: row.title === "" ? info.title : row.title,
            page_count: total,
            pages_done: 0,
            bytes_done: 0,
            bytes_total: null,
        });
        const current = rowOf(id) ?? row;
        const location = folderFor(current);
        await mkdir(location.path, { recursive: true });

        // 续传：同一版已经下过的那几页留着，进度从它们的数量与字节数起算。
        const kept = await prepareResume(location.folder, current, total);
        const have = new Set(kept.map((item) => item.page));
        let bytes = kept.reduce((sum, item) => sum + item.bytes, 0);
        let done = have.size;
        if (done > 0) {
            patchRow(id, { pages_done: done, bytes_done: bytes });
            log("info", `续传：#${row.gid} 已有 ${done}/${total} 页，只补缺的`);
        }

        let pageToken: string | undefined;
        // 速度：与归档下载一样按「这次的增量 / 距上次的间隔」算
        let lastBytes = bytes;
        let lastAt = Date.now();
        for (let page = 1; page <= total; page += 1) {
            if (controller.signal.aborted) {
                throw new Error("下载已取消");
            }
            if (have.has(page)) {
                // 已经下过的页不重下：图片页请求贵（上游限流），下过就保留。
                continue;
            }
            const item = await options.gallery.imagePage(row.gid, row.token, page, pageToken);
            if (item.nextPageToken !== null) {
                pageToken = item.nextPageToken;
            }
            const url =
                quality === "org" && item.originalImageUrl !== null
                    ? item.originalImageUrl
                    : item.imageUrl;
            const target = join(
                location.path,
                `${String(page).padStart(4, "0")}.${extensionOf(url)}`,
            );
            const result = await downloadFile({
                url,
                targetPath: target,
                headers: { referer: "https://e-hentai.org/" },
                dispatcher: getDispatcher() ?? undefined,
                // 图床是 H@H 节点，连不上或读到一半断掉都常见，因此重试两次
                attempts: PAGE_ATTEMPTS,
                signal: controller.signal,
                onProgress: (progress) => {
                    const total = bytes + progress.bytesDone;
                    const now = Date.now();
                    const elapsed = (now - lastAt) / 1000;
                    if (elapsed > 0) {
                        speeds.set(id, Math.round((total - lastBytes) / elapsed));
                    }
                    lastBytes = total;
                    lastAt = now;
                    patchRow(id, { bytes_done: total });
                },
            }).catch((error: unknown) => {
                if (controller.signal.aborted) {
                    throw error;
                }
                // 带上页号：整本重下时才知道卡在哪一页
                throw new Error(`第 ${page}/${total} 页下载失败`, { cause: error });
            });
            bytes += result.bytes;
            done = page;
            lastBytes = bytes;
            lastAt = Date.now();
            patchRow(id, { pages_done: done, bytes_done: bytes });
        }
        speeds.delete(id);

        const summary = await loadSummary(row, controller.signal);
        // 逐页这条路本来就要读一次详情（要页数），这一份也一并落盘，不再重复请求上游
        const detail = await detailFor(row, info);
        // 阅读进度不能被重下抹掉：这一版之前读过就照原样带过来。
        const previous = await options.library.find(row.gid, row.resolution);
        await options.library.write(
            {
                schemaVersion: 1,
                gid: row.gid,
                token: row.token,
                title: summary?.title ?? (row.title === "" ? `g${row.gid}` : row.title),
                resolution: row.resolution,
                pageCount: total,
                files: done,
                sizeBytes: bytes,
                downloadedAt: Math.floor(Date.now() / 1000),
                lastReadPage: previous?.lastReadPage ?? 0,
                lastReadAt: previous?.lastReadAt ?? null,
                archive: null,
                summary,
                detail,
            },
            location.folder,
        );
        // 收尾：清掉下载标记，页文件与元数据都留着。
        await options.library.endDownload(location.folder);
        patchRow(id, { status: "completed", output_path: location.path, error: null });
        log(
            "info",
            `逐页下载完成：${location.path}（${done} 页，${bytes} 字节${
                have.size > 0 ? `，其中续传 ${have.size} 页` : ""
            }）`,
        );
    }

    /*
     * 续传准备：判断目录里已有的页能不能接着用。
     * 认得出是同一版（同一个 gid + 分辨率）就留着，只有确认换了目标才清空：
     *   - 有下载标记且标记是同一版 -> 接着下
     *   - 有标记但不是同一版（换了版本或分辨率）-> 清空重下，否则页序会串
     *   - 没标记但目录里是另一个 gid 的成品（升级下载、标题又正好相同）-> 清空重下
     *   - 没标记、也没法确认是谁的（手放的文件、更老版本留下的）-> 留着不删，只记一条日志
     */
    async function prepareResume(
        folder: string,
        row: Row,
        total: number,
    ): Promise<readonly { page: number; bytes: number }[]> {
        const state = await options.library.downloadState(folder);
        const sameAsState =
            state !== null && state.gid === row.gid && state.resolution === row.resolution;
        // 目录里已有的成品是谁的：文件夹名相同时靠它区分「同一版重下」与「另一版的更新」。
        const owned =
            state === null
                ? ((await options.library.list()).find((item) => item.folder === folder) ?? null)
                : null;
        const otherVersion =
            state !== null ? !sameAsState : owned !== null && owned.gid !== row.gid;

        let kept: readonly { page: number; bytes: number }[] = [];
        if (otherVersion) {
            const existing = await options.library.existingPages(folder);
            if (existing.length > 0) {
                const who = state !== null ? `#${state.gid}` : `#${owned?.gid ?? 0}`;
                log("warn", `目录已有 ${existing.length} 页且属于 ${who}，不是这一版：清空后重下`);
                await options.library.clearPages(folder);
            }
        } else {
            kept = await options.library.existingPages(folder);
            if (kept.length > 0 && state === null && owned === null) {
                log(
                    "warn",
                    `目录已有 ${kept.length} 页但没有任何下载记录，无法确认属于哪一版，按续传处理`,
                );
            }
        }

        await options.library.beginDownload(folder, {
            gid: row.gid,
            token: row.token,
            resolution: row.resolution,
            pageCount: total,
            startedAt: Math.floor(Date.now() / 1000),
        });
        return kept;
    }

    async function runTask(id: string): Promise<void> {
        let row = rowOf(id);
        if (row === null || row.status !== "queued") {
            return;
        }

        const controller = new AbortController();
        const token = (executionToken += 1);
        controllers.set(id, controller);
        executions.set(id, token);
        patchRow(id, { status: "running", error: null });
        log("info", `开始下载 #${row.gid} ${row.resolution}`);

        try {
            // 逐页下载（游客也能下）：不碰归档接口，逐页取图片地址后直接落盘。
            if (isPageMode(row.resolution)) {
                await runPageTask(id, row, controller);
                return;
            }

            if (row.title === "") {
                // 落盘文件名取自标题。上游无响应时按超时放行，文件名退回 gid。
                await fillTitle(id, row.gid, row.token, controller.signal);
                row = rowOf(id) ?? row;
            }

            const url = await resolveArchiveUrl(
                row.gid,
                row.token,
                row.resolution,
                row.resolution === "hath",
                archiveOptions(controller.signal),
            );

            if (controller.signal.aborted) {
                throw new Error("下载已取消");
            }

            if (url === null) {
                // H@H 下载由客户端在后台取回，本地队列到此结束
                patchRow(id, { status: "completed", error: "H@H 下载已提交，由客户端取回" });
                return;
            }

            const location = folderFor(row);
            await mkdir(location.path, { recursive: true });
            let lastBytes = 0;
            let lastAt = Date.now();

            const result = await downloadFile({
                url,
                targetPath: location.archive,
                headers: { referer: "https://e-hentai.org/" },
                dispatcher: getDispatcher() ?? undefined,
                // 归档动辄几百 MB，重试代价高，只给一次机会。
                attempts: ARCHIVE_ATTEMPTS,
                signal: controller.signal,
                onProgress: (progress) => {
                    const now = Date.now();
                    const elapsed = (now - lastAt) / 1000;
                    if (elapsed > 0) {
                        speeds.set(id, Math.round((progress.bytesDone - lastBytes) / elapsed));
                    }
                    lastBytes = progress.bytesDone;
                    lastAt = now;
                    const current = rowOf(id);
                    if (current !== null) {
                        patchRow(id, {
                            bytes_done: progress.bytesDone,
                            bytes_total: progress.bytesTotal,
                            title: current.title,
                        });
                    }
                },
            });

            speeds.delete(id);
            patchRow(id, { bytes_done: result.bytes, bytes_total: result.bytes });

            // 下完就解压：图片按页序重命名后落在同一个目录里，播放器才能按页取本地文件。
            log("info", `归档下载完成，开始解压：${location.archive}`);
            const files = await options.library.extractArchive(location.archive, location.folder);

            const keepArchive = ctx.user.get().download.keepArchive;
            if (!keepArchive) {
                await rm(location.archive, { force: true });
            }

            const keep = keepArchive ? "archive.zip" : null;
            const summary = await loadSummary(row, controller.signal);
            // 归档这条路本来只取 gdata 快照，这里补一次详情（多半命中详情缓存），
            // 把详情页那份数据一并落盘，本地浏览才不会再次请求上游
            const detail = await detailFor(row, await loadDetail(row));
            const meta: LocalGalleryMeta = {
                schemaVersion: 1,
                gid: row.gid,
                token: row.token,
                title: summary?.title ?? (row.title === "" ? `g${row.gid}` : row.title),
                resolution: row.resolution,
                pageCount: summary?.pageCount ?? files,
                files,
                sizeBytes: result.bytes,
                downloadedAt: Math.floor(Date.now() / 1000),
                lastReadPage: 0,
                lastReadAt: null,
                archive: keep,
                summary,
                detail,
            };
            await options.library.write(meta, location.folder);

            patchRow(id, {
                status: "completed",
                output_path: location.path,
                error: null,
            });
            log(
                "info",
                `下载完成：${location.path}（${files} 页，${result.bytes} 字节${keep === null ? "，归档已删" : "，归档保留"}）`,
            );
        } catch (error) {
            speeds.delete(id);
            const aborted = controller.signal.aborted;
            // 已经被重新排队（新一轮执行接了手）时，这次收尾不写任何状态
            if (executions.get(id) === token) {
                patchRow(id, {
                    status: aborted ? "cancelled" : "failed",
                    error: aborted ? "已取消" : describeError(error),
                });
            }
            log(
                aborted ? "info" : "warn",
                `下载${aborted ? "已取消" : "失败"}：#${row.gid} ${describeError(error)}`,
            );
        } finally {
            if (executions.get(id) === token) {
                executions.delete(id);
                controllers.delete(id);
            }
        }
    }

    /** 单并发循环：每次取一条排队任务执行。 */
    async function pump(): Promise<void> {
        if (running) {
            return;
        }
        running = true;
        try {
            for (;;) {
                const next = db
                    .prepare(
                        "select id from downloads where status = 'queued' order by created_at limit 1",
                    )
                    .get() as { id: string } | undefined;
                if (next === undefined) {
                    break;
                }
                await runTask(next.id);
            }
        } finally {
            running = false;
        }
    }

    return {
        list() {
            const rows = db
                .prepare("select * from downloads order by created_at desc")
                .all() as unknown as Row[];
            return rows.map(toTask);
        },

        async create(input) {
            const id = randomUUID();
            const now = Math.floor(Date.now() / 1000);
            const resolution = input.viaHath === true ? "hath" : input.resolution;

            /*
             * 归档只有登录后才拿得到，还要消耗 GP。未登录时不进入队列：
             * 排进去只会等到执行时才失败，界面上凭空多出一条失败任务，此处直接报错更清楚，
             * 由界面改用逐页下载（pages-org / pages-res，showpage 不需要登录）。
             */
            if (!isPageMode(resolution) && activeAccount(ctx.auth.get()) === null) {
                throw new LoginRequiredError("归档下载需要登录并消耗 GP；未登录时请改用逐页下载");
            }

            db.prepare(
                `insert into downloads (id, gid, token, title, resolution, status, bytes_done, bytes_total,
                 pages_done, page_count, output_path, error, created_at, updated_at)
                 values (?, ?, ?, '', ?, 'queued', 0, null, 0, null, null, null, ?, ?)`,
            ).run(id, input.gid, input.token, resolution, now, now);

            const row = rowOf(id);
            if (row === null) {
                throw new Error("任务写入失败");
            }
            log("info", `已加入队列：#${input.gid}`);
            broadcast(row);

            const task = toTask(row);
            void pump();
            return task;
        },

        async retry(id) {
            const row = rowOf(id);
            if (row === null) {
                throw new Error(`任务不存在：${id}`);
            }
            // 只在终态上重排：排队中或进行中的任务不该被重置。
            if (row.status === "failed" || row.status === "cancelled") {
                // 上一轮可能还在收尾（取消是异步的）：作废它的令牌，避免它把这次排队盖掉。
                executions.delete(id);
                controllers.get(id)?.abort();
                // 进度一起清掉：留着上一轮的页数会让排队中的进度条先显示旧分数。
                patchRow(id, {
                    status: "queued",
                    bytes_done: 0,
                    bytes_total: null,
                    pages_done: 0,
                    error: null,
                });
                log("info", `重新排队：#${row.gid} ${row.resolution}`);
                const next = rowOf(id);
                if (next !== null) {
                    broadcast(next);
                    const task = toTask(next);
                    void pump();
                    return task;
                }
            }
            return toTask(row);
        },

        async cancel(id) {
            const row = rowOf(id);
            if (row === null) {
                throw new Error(`任务不存在：${id}`);
            }

            if (row.status === "running") {
                controllers.get(id)?.abort();
                patchRow(id, { status: "cancelled", error: "已取消" });
                return { id, cancelled: true, removedFromList: false };
            }
            if (row.status === "queued") {
                patchRow(id, { status: "cancelled", error: "已取消" });
                return { id, cancelled: true, removedFromList: false };
            }

            // 已结束的任务只从列表移除，落盘文件保留。
            db.prepare("delete from downloads where id = ?").run(id);
            speeds.delete(id);
            return { id, cancelled: false, removedFromList: true };
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        recover() {
            const result = db
                .prepare(
                    "update downloads set status = 'failed', error = '进程退出，任务中断', updated_at = ? where status in ('queued', 'running')",
                )
                .run(Math.floor(Date.now() / 1000));
            const count = Number(result.changes ?? 0);
            if (count > 0) {
                log("warn", `${count} 条未完成任务已标记为失败（不支持断点续传）`);
            }
            return count;
        },
    };
}

/** 标题只用于文件名，读不到就按 gid 命名，不因此中断任务 */
const TITLE_TIMEOUT_MS = 4000;

/** 单张图片的重试次数。图床节点不稳定，重试比整本重下便宜。 */
const PAGE_ATTEMPTS = 3;
/** 归档的重试次数。体积大，只给一次机会。 */
const ARCHIVE_ATTEMPTS = 2;

/*
 * 未配置下载目录时的落点：~/ehbrowser/download。
 * 便携模式下收进 <HOME>/download，整个目录可以一起搬走。
 */
export function defaultDownloadDirectory(ctx: ConfigContext): string {
    if (ctx.paths.sources.dataDir === "portable-home") {
        return join(ctx.paths.dataDir, "download");
    }
    return join(homedir(), APP_DIR_NAME, "download");
}
