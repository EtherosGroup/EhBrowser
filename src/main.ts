#!/usr/bin/env node
/**
 * 入口。解析参数 -> 初始化配置 -> 启动本地服务 -> 打开界面
 * 收到 SIGINT / SIGTERM 时先关服务、再刷写配置并关库
 */

import { createRequire } from "node:module";

import { initConfig } from "./config/index.ts";
import { hasProxyAgent } from "./eh/index.ts";
import { openExternal } from "./platform/open-external.ts";
import { generateToken, startServer, type RunningServer } from "./server.ts";
import { createAuthService } from "./services/auth-service.ts";
import { createConfigService } from "./services/config-service.ts";
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
    // 详情缓存落盘，位于缓存目录的 gallery/ 下，重启不丢失
    const detailStore = createDetailStore({
        cacheDir: ctx.paths.cacheDir,
        logger: logs.logger("cache"),
    });
    const gallery = createGalleryService(ctx, upstream, {
        store: detailStore,
        logger: logs.logger("gallery"),
    });
    // 启动时按默认条件拉取一次并写入缓存，界面第一次打开即可直接渲染；
    // 不阻塞启动，失败只记日志，界面自己会再发一次检索
    void gallery.warmSearch();
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
    downloads.recover();
    const auth = createAuthService(ctx, {
        logger: logs.logger("auth"),
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
}

main().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`启动失败：${reason}`);
    process.exit(1);
});
