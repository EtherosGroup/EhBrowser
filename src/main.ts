#!/usr/bin/env node
/**
 * 入口。解析参数 -> 初始化配置 -> 启动本地服务 -> 打开界面
 * 收到 SIGINT / SIGTERM 时先关服务、再刷写配置并关库
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { initConfig } from "./config/index.ts";
import { hasProxyAgent, observeRequestDuration } from "./eh/index.ts";
import { openExternal } from "./platform/open-external.ts";
import { generateToken, startServer, type RunningServer } from "./server.ts";
import { createAuthService } from "./services/auth-service.ts";
import { createBrowserLoginRunner } from "./services/browser-login.ts";
import { createConfigService } from "./services/config-service.ts";
import { createDiagnosticsService } from "./services/diagnostics-service.ts";
import { createDownloadService, defaultDownloadDirectory } from "./services/download-service.ts";
import { createDetailStore } from "./services/detail-store.ts";
import { createGalleryService } from "./services/gallery-service.ts";
import { createLocalLibrary } from "./services/local-library.ts";
import { createPlaylistService } from "./services/playlist-service.ts";
import { createLogService, defaultLogDirectory } from "./services/log-service.ts";
import { createTranslateService } from "./services/translate-service.ts";
import { createStorageService } from "./services/storage-service.ts";
import { createUpdateService } from "./services/update-service.ts";
import { createFavoriteService } from "./services/favorite-service.ts";
import { createUpstreamService } from "./services/upstream-service.ts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

interface CliOptions {
    readonly port?: number;
    readonly open: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
    let port: number | undefined;
    let open = true;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--no-open") {
            open = false;
            continue;
        }
        if (arg === "--port") {
            const raw = argv[index + 1];
            const value = Number(raw);
            if (raw === undefined || !Number.isInteger(value) || value < 0 || value > 65535) {
                throw new Error(`端口不合法：${raw ?? "(缺失)"}`);
            }
            port = value;
            index += 1;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            console.log("用法：ehbrowser [--port <0-65535>] [--no-open]");
            process.exit(0);
        }
        throw new Error(`未知参数：${arg}`);
    }

    return port === undefined ? { open } : { port, open };
}

async function main(): Promise<void> {
    console.clear();
    const options = parseArgs(process.argv.slice(2));

    const ctx = await initConfig();
    // 日志：最先创建，后续各服务的 logger 均由它提供，输出同时进入控制台与日志文件
    const logs = createLogService(ctx, { fallbackDirectory: defaultLogDirectory });
    const service = createConfigService(ctx);
    // 构造即按配置应用代理与请求间隔，配置变更时自动跟随
    const upstream = createUpstreamService(ctx, service, {
        logger: logs.logger("upstream"),
    });
    /*
     * 诊断：右上角那组状态图标。采样内存、磁盘探测、并发连接与各类错误，
     * 活动的那几项经 SSE 推给界面。采样本身很轻：计数每 2 秒看一次，磁盘探测每 10 秒一次。
     */
    const diagnostics = createDiagnosticsService({
        probeDirectory: ctx.paths.cacheDir,
        logger: logs.logger("status"),
    });
    // 上游请求真实耗时 -> 诊断：判断「与上游站点的通信变慢」
    observeRequestDuration((durationMs) => diagnostics.noteUpstream(durationMs));

    /*
     * 文件系统错误与内部错误也计进状态提示。图标是状态，错误本身仍按原来的路径提示，
     * 这里只做归类：认得出 errno 的算文件系统异常。诊断自己写的那几行日志要排除，否则会自己触发自己。
     */
    const FS_ERRNO =
        /\b(EACCES|EPERM|EROFS|EIO|ENOSPC|ENOTDIR|EISDIR|EBUSY|EMFILE|ENFILE|ENXIO|ESTALE|EDQUOT)\b/;
    const classify = (text: string): void => {
        if (FS_ERRNO.test(text)) {
            diagnostics.noteFsError(text);
        }
    };
    logs.onChange(({ level, message, tag }) => {
        if (tag !== "status" && (level === "warn" || level === "error")) {
            classify(message);
        }
    });

    // 详情缓存落盘，位于缓存目录的 gallery/ 下，重启不丢失
    const detailStore = createDetailStore({
        cacheDir: ctx.paths.cacheDir,
        logger: logs.logger("cache"),
    });
    const gallery = createGalleryService(ctx, upstream, {
        store: detailStore,
        logger: logs.logger("gallery"),
    });
    /*
     * 启动时按默认条件拉取一次并写入缓存，界面第一次打开即可直接渲染。
     * 关掉「自动搜索」就不预热：这类工具不该不打招呼就去上游拉内容（设置 > 搜索，默认关闭）。
     * 不阻塞启动，失败只记日志，界面自己会再发一次检索。
     */
    if (ctx.user.get().search.auto) {
        void gallery.warmSearch();
    } else {
        logs.append("info", "自动搜索已关闭：启动不预热，界面也不会自动铺默认结果");
    }
    // 本地库：下载落盘目录、.ehbrowser 元数据与按页取图均由它负责
    const library = createLocalLibrary(ctx, { fallbackDirectory: defaultDownloadDirectory });
    // 储存空间：占用统计与缓存清理
    const storage = createStorageService({ library, store: detailStore });
    const downloads = createDownloadService(ctx, upstream, {
        fallbackDirectory: defaultDownloadDirectory,
        library,
        gallery,
        // 快照用于本地库卡片离线展示，取不到不影响下载
        summarise: (gid, token, signal) => gallery.summaryOf(gid, token, signal),
        logger: logs.logger("download"),
    });
    // 后台下载的失败也归类一次：任务错误不在 HTTP 响应里，只能从这里拿
    downloads.onChange((task) => {
        if (task.error !== null && task.error !== "") {
            classify(task.error);
        }
    });
    downloads.recover();

    // 使用浏览器登入
    const browserLogin = createBrowserLoginRunner({
        profileDir: join(ctx.paths.cacheDir, "login-browser"),
        proxy: () => {
            const { proxy } = service.snapshot().setting.network;
            if (!proxy.enabled || proxy.host === "") {
                return null;
            }
            const credentials = ctx.auth.get().proxyAuth;
            return {
                // 原样交给 Chromium
                server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
                ...(credentials.username === "" ? {} : { username: credentials.username }),
                ...(credentials.password === "" ? {} : { password: credentials.password }),
            };
        },
        logger: logs.logger("browser-login"),
    });
    const auth = createAuthService(ctx, {
        logger: logs.logger("auth"),
        browserLogin,
    });

    // 用户播放列表：持久化在 SQLite，重启不丢
    const playlist = createPlaylistService(ctx);
    // 收藏：本地收藏夹落库，云端槽位同步到上游
    const favorites = createFavoriteService(ctx, gallery, {
        logger: logs.logger("favorite"),
    });
    // 标签翻译词库：按需下载到缓存目录，不随程序分发
    const translate = createTranslateService({
        cacheDir: ctx.paths.cacheDir,
        logger: logs.logger("translate"),
    });
    // 更新检查：结果只在内存中，重启即清空
    const updates = createUpdateService(library, gallery, {
        logger: logs.logger("update"),
    });

    let server: RunningServer;
    /** 实际的关闭流程在服务启动后赋值。此处先占位，界面发起请求时不会遇到未初始化的绑定 */
    let shutdown: (signal: string) => Promise<void> = async () => undefined;

    server = await startServer({
        service,
        gallery,
        auth,
        downloads,
        library,
        storage,
        playlist,
        updates,
        favorites,
        translate,
        logs,
        diagnostics,
        token: generateToken(),
        version,
        port: options.port,
        // 界面上的「关闭服务器」走同一条优雅关闭路径
        onShutdown: () => void shutdown("界面请求"),
    });

    // 启动横幅同样写入日志文件，出现问题时先查看这几行
    logs.append("info", `EhBrowser ${version}`);
    logs.append("info", `地址：${server.url}`);
    logs.append("info", `配置：${ctx.paths.configDir}`);
    logs.append("info", `代理：${hasProxyAgent() ? "已启用" : "未启用"}`);
    logs.append("info", `日志：${logs.state().directory}`);
    logs.append("info", "按 Ctrl+C 退出");

    if (options.open) {
        try {
            await openExternal(server.url);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logs.append("warn", `未能自动打开浏览器（${reason}），请手动访问 ${server.url}`);
        }
    }

    let closing = false;
    shutdown = async (signal: string): Promise<void> => {
        if (closing) {
            return;
        }
        closing = true;
        logs.append("info", `正在关闭服务端，终止信号为 ${signal}`);
        try {
            diagnostics.stop();
            // 先收掉可能开着的登录窗口，防止出现孤浏览器
            await browserLogin.shutdown();
            await server.close();
            await ctx.close();
            // 最后等待日志落盘，否则进程退出快于写文件，日志尾部会丢失
            await logs.flush();
        } catch (error) {
            console.error(`退出时出错：${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    /*
     * 内部错误：记一笔栈并让界面亮起「客户端内部错误」那个图标（本次运行内一直亮着）。
     * 不在这里退出进程：这是个本地工具，正在下载/阅读时直接崩掉更糟；堆栈写进日志与终端，
     * 图标上写的就是「请前往终端查看」。
     */
    process.on("uncaughtException", (error) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        logs.append("error", `未捕获的异常：${detail}`);
        diagnostics.noteInternalError(detail, true);
    });
    process.on("unhandledRejection", (reason) => {
        const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        logs.append("error", `未处理的 Promise 拒绝：${detail}`);
        diagnostics.noteInternalError(detail, true);
    });
}

main().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`启动失败：${reason}`);
    process.exit(1);
});
