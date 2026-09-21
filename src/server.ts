/*
 * 本地 HTTP 服务。监听回环地址，按 api/routes.ts 的路由表分发。
 * 安全上有三道：仅绑 127.0.0.1、校验 Origin 与 Host、校验本地访问令牌。
 * 令牌每次启动重新生成并注入界面；SSE 因 EventSource 无法设置请求头，令牌走查询参数。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
    API_EVENT_HEARTBEAT_MS,
    API_TOKEN_HEADER,
    API_TOKEN_QUERY_PARAM,
    ROUTES,
    fail,
    ok,
    statusForError,
    type ApiErrorCode,
    type ApiEventName,
    type ApiEventPayloads,
    type ApiRouteName,
    type FieldIssue,
    type GalleryCategory,
    type GalleryLanguage,
    type GallerySearchQuery,
    type HttpMethod,
    type SystemHealth,
    type TranslateStatus,
    type UpdateCheckTarget,
} from "./api/index.ts";
import { ConfigInvalidError } from "./config/index.ts";
import { LoginRequiredError } from "./eh/index.ts";
import { describeError, describeTransportError, errorCode } from "./platform/errors.ts";
import type { AuthService } from "./services/auth-service.ts";
import type { ConfigService } from "./services/config-service.ts";
import type { DownloadService } from "./services/download-service.ts";
import type { GalleryService } from "./services/gallery-service.ts";
import type { LocalLibrary } from "./services/local-library.ts";
import type { StorageService } from "./services/storage-service.ts";
import type { PlaylistService } from "./services/playlist-service.ts";
import type { FavoriteService } from "./services/favorite-service.ts";
import type { LogService } from "./services/log-service.ts";
import type { TranslateService } from "./services/translate-service.ts";
import type { UpdateService } from "./services/update-service.ts";

const HOST = "127.0.0.1";
/** 默认端口。取一个不常用的四位数：8787 常被其他调试服务占用，冲突时需要改配置或传 --port */
const DEFAULT_PORT = 7727;
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
    readonly service: ConfigService;
    /** 缺省时画廊路由返回 501 */
    readonly gallery?: GalleryService;
    /** 缺省时账号路由返回 501 */
    readonly auth?: AuthService;
    /** 缺省时下载路由返回 501 */
    readonly downloads?: DownloadService;
    /** 缺省时本地库路由返回 501 */
    readonly library?: LocalLibrary;
    /** 缺省时储存空间路由返回 501 */
    readonly storage?: StorageService;
    /** 缺省时播放列表路由返回 501 */
    readonly playlist?: PlaylistService;
    /** 缺省时更新检查路由返回空状态 */
    readonly updates?: UpdateService;
    /** 缺省时收藏路由返回 501 */
    readonly favorites?: FavoriteService;
    /** 缺省时标签翻译词库路由返回空状态 */
    readonly translate?: TranslateService;
    /** 缺省时日志路由返回空状态 */
    readonly logs?: LogService;
    readonly token: string;
    readonly version: string;
    readonly host?: string;
    readonly port?: number;
    /** 静态资源目录；缺省按 dist/web、web 顺序探测 */
    readonly staticDir?: string;
    /**
     * 界面请求关闭服务时调用。先写回响应，再进入这里，
     * 具体如何关闭（关服务、刷配置、退出进程）由入口决定
     */
    readonly onShutdown?: () => void;
}

export interface RunningServer {
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly token: string;
    /** 向所有 SSE 连接推送事件 */
    broadcast<K extends ApiEventName>(event: K, data: ApiEventPayloads[K]): void;
    close(): Promise<void>;
}

interface MatchedRoute {
    readonly name: ApiRouteName;
    readonly method: HttpMethod;
    readonly params: Record<string, string>;
}

const MATCHERS = buildMatchers();

export async function startServer(options: ServerOptions): Promise<RunningServer> {
    const host = options.host ?? HOST;
    const requestedPort = options.port ?? DEFAULT_PORT;
    const staticDir = options.staticDir ?? (await resolveStaticDir());
    const clients = new Set<ServerResponse>();
    let startedAt = Math.floor(Date.now() / 1000);

    const server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
            if (!response.headersSent) {
                sendError(response, "internal", describeError(error));
                return;
            }
            response.end();
        });
    });

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", `http://${host}:${requestedPort}`);
        const method = (request.method ?? "GET").toUpperCase() as HttpMethod;

        if (!isHostAllowed(request.headers.host, host, requestedPort)) {
            sendError(response, "forbidden", "Host 不在允许范围");
            return;
        }
        if (!isOriginAllowed(request.headers.origin, host, requestedPort)) {
            sendError(response, "forbidden", "Origin 不在允许范围");
            return;
        }

        const matched = matchRoute(method, url.pathname);
        if (matched !== null && ROUTES[matched.name].requiresToken) {
            if (!tokenMatches(readToken(request, url), options.token)) {
                sendError(response, "unauthorized", "本地令牌缺失或错误");
                return;
            }
        }

        if (url.pathname.startsWith("/api/")) {
            await handleApi(request, response, url, matched);
            return;
        }

        await serveStatic(response, url.pathname, staticDir, options.token, currentPort(), {
            method,
            accept: request.headers.accept ?? "",
        });
    }

    function currentPort(): number {
        const address = server.address();
        return typeof address === "object" && address !== null ? address.port : requestedPort;
    }

    async function handleApi(
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        matched: MatchedRoute | null,
    ): Promise<void> {
        if (matched === null) {
            sendError(response, "not_found", `无此路由：${request.method} ${url.pathname}`);
            return;
        }

        if (matched.name.startsWith("galleries.")) {
            await handleGallery(response, url, matched);
            return;
        }

        if (matched.name.startsWith("auth.")) {
            await handleAuth(request, response, matched);
            return;
        }

        if (matched.name.startsWith("favorites.")) {
            await handleFavorites(request, response, url, matched, options.favorites);
            return;
        }

        if (matched.name.startsWith("playlist.")) {
            await handlePlaylist(request, response, matched, options.playlist);
            return;
        }

        if (matched.name.startsWith("translate.")) {
            await handleTranslate(response, matched, options.translate);
            return;
        }

        if (matched.name === "log.state") {
            const limit = Number(url.searchParams.get("limit") ?? 100);
            sendJson(
                response,
                200,
                ok(
                    options.logs?.state(limit) ?? {
                        enabled: false,
                        directory: "",
                        file: "",
                        defaultDirectory: "",
                        entries: [],
                    },
                ),
            );
            return;
        }

        if (matched.name.startsWith("storage.")) {
            await handleStorage(request, response, matched, options.storage);
            return;
        }

        if (matched.name.startsWith("library.")) {
            await handleLibrary(request, response, matched, options.library, options.updates);
            return;
        }

        if (matched.name.startsWith("downloads.")) {
            await handleDownloads(request, response, matched);
            return;
        }

        switch (matched.name) {
            case "system.health": {
                sendJson(response, 200, ok(health()));
                return;
            }
            case "config.get": {
                sendJson(response, 200, ok(options.service.snapshot()));
                return;
            }
            case "config.paths": {
                sendJson(response, 200, ok(options.service.pathsInfo()));
                return;
            }
            case "config.patch": {
                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch (error) {
                    sendError(response, "bad_request", describeError(error));
                    return;
                }
                try {
                    const snapshot = await options.service.patchUserSetting(
                        body as Parameters<ConfigService["patchUserSetting"]>[0],
                    );
                    sendJson(response, 200, ok(snapshot));
                } catch (error) {
                    if (error instanceof ConfigInvalidError) {
                        sendError(response, "config_invalid", "配置校验失败", error.issues);
                        return;
                    }
                    sendError(response, "internal", describeError(error));
                }
                return;
            }
            case "system.shutdown": {
                // 先写完响应再执行关闭流程：否则连接会随服务一起断开，界面只看到网络错误
                sendJson(response, 200, ok({ closing: true }));
                setImmediate(() => {
                    options.onShutdown?.();
                });
                return;
            }
            case "system.events": {
                openEventStream(request, response);
                return;
            }
            default: {
                sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
            }
        }
    }

    async function handleAuth(
        request: IncomingMessage,
        response: ServerResponse,
        matched: MatchedRoute,
    ): Promise<void> {
        const auth = options.auth;
        if (auth === undefined) {
            sendError(response, "not_implemented", "账号服务未接入");
            return;
        }

        const accountId = matched.params["accountId"] ?? "";

        try {
            switch (matched.name) {
                case "auth.status": {
                    sendJson(response, 200, ok(auth.status()));
                    return;
                }
                case "auth.login": {
                    const body = (await readJsonBody(request)) as Parameters<
                        AuthService["login"]
                    >[0];
                    sendJson(response, 200, ok(await auth.login(body)));
                    return;
                }
                case "auth.logout": {
                    sendJson(response, 200, ok(await auth.logout()));
                    return;
                }
                case "auth.accounts.list": {
                    sendJson(response, 200, ok(auth.listAccounts()));
                    return;
                }
                case "auth.accounts.create": {
                    const body = (await readJsonBody(request)) as Parameters<
                        AuthService["createAccount"]
                    >[0];
                    sendJson(response, 200, ok(await auth.createAccount(body)));
                    return;
                }
                case "auth.accounts.update": {
                    const body = (await readJsonBody(request)) as Parameters<
                        AuthService["updateAccount"]
                    >[1];
                    sendJson(response, 200, ok(await auth.updateAccount(accountId, body)));
                    return;
                }
                case "auth.accounts.remove": {
                    sendJson(response, 200, ok({ removed: await auth.removeAccount(accountId) }));
                    return;
                }
                case "auth.accounts.activate": {
                    sendJson(response, 200, ok(await auth.activateAccount(accountId)));
                    return;
                }
                default: {
                    sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
                }
            }
        } catch (error) {
            sendError(response, classifyError(error), describeError(error));
        }
    }

    async function handleDownloads(
        request: IncomingMessage,
        response: ServerResponse,
        matched: MatchedRoute,
    ): Promise<void> {
        const downloads = options.downloads;
        if (downloads === undefined) {
            sendError(response, "not_implemented", "下载服务未接入");
            return;
        }

        const taskId = matched.params["taskId"] ?? "";

        try {
            switch (matched.name) {
                case "downloads.retry": {
                    const id = matched.params["taskId"] ?? "";
                    sendJson(response, 200, ok(await downloads.retry(id)));
                    return;
                }
                case "downloads.list": {
                    sendJson(response, 200, ok(downloads.list()));
                    return;
                }
                case "downloads.create": {
                    const body = (await readJsonBody(request)) as Parameters<
                        DownloadService["create"]
                    >[0];
                    sendJson(response, 200, ok(await downloads.create(body)));
                    return;
                }
                case "downloads.cancel": {
                    sendJson(response, 200, ok(await downloads.cancel(taskId)));
                    return;
                }
                default: {
                    sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
                }
            }
        } catch (error) {
            sendError(response, classifyError(error), describeError(error));
        }
    }

    async function handleGallery(
        response: ServerResponse,
        url: URL,
        matched: MatchedRoute,
    ): Promise<void> {
        const gallery = options.gallery;
        if (gallery === undefined) {
            sendError(response, "not_implemented", "画廊服务未接入");
            return;
        }
        // 本地库可能未接入（少见，但确实存在这种组合）：未接入时只是用不上详情快照
        const library = options.library;

        const gid = Number(matched.params["gid"]);
        const token = matched.params["token"] ?? "";

        try {
            switch (matched.name) {
                case "galleries.search": {
                    sendJson(response, 200, ok(await gallery.search(readSearchQuery(url))));
                    return;
                }
                case "galleries.searchCache": {
                    // 没有缓存时 data 为 null，界面据此决定是否自行发一次检索
                    sendJson(response, 200, ok(await gallery.cachedSearch()));
                    return;
                }
                case "galleries.newer": {
                    sendJson(response, 200, ok(await gallery.newer(gid, token)));
                    return;
                }
                case "galleries.detail": {
                    const fresh = isFresh(url);
                    /*
                     * 本地已有副本且下载时存了详情快照：直接用落盘那一份，不发送任何上游请求。
                     * 这是「下载过的画廊本地浏览不再拉详情」的落点：播放器与详情页都走这个接口。
                     * fresh 表示要的一定是新数据（更新检查这类），此时不使用快照，仍向上游请求
                     */
                    if (!fresh && library !== undefined) {
                        const stored = await library.storedDetail(gid, token);
                        if (stored !== null) {
                            sendJson(response, 200, ok(stored));
                            return;
                        }
                    }
                    const info = await gallery.detail(gid, token, { fresh });
                    // 有本地副本却没有快照（老版本下载的数据）：此时补存一份，下次打开就不必再请求上游
                    if (library !== undefined) {
                        try {
                            await library.saveDetail(gid, info);
                        } catch {
                            // 快照只是省一次上游请求，写入失败不影响本次返回
                        }
                    }
                    sendJson(response, 200, ok(info));
                    return;
                }
                case "galleries.page": {
                    const page = Number(matched.params["page"]);
                    const pageToken = url.searchParams.get("pageToken") ?? undefined;
                    sendJson(
                        response,
                        200,
                        ok(
                            await gallery.imagePage(gid, token, page, pageToken, {
                                fresh: isFresh(url),
                            }),
                        ),
                    );
                    return;
                }
                case "galleries.previews": {
                    const index = Number(url.searchParams.get("index") ?? 0);
                    sendJson(
                        response,
                        200,
                        ok(
                            await gallery.previews(gid, token, index, undefined, {
                                fresh: isFresh(url),
                            }),
                        ),
                    );
                    return;
                }
                case "galleries.detailCache": {
                    sendJson(response, 200, ok(gallery.detailCacheStats()));
                    return;
                }
                case "galleries.detailCache.clear": {
                    sendJson(response, 200, ok(gallery.clearDetailCache()));
                    return;
                }
                case "galleries.torrents": {
                    sendJson(response, 200, ok(await gallery.torrents(gid, token)));
                    return;
                }
                case "galleries.archives": {
                    sendJson(response, 200, ok(await gallery.archives(gid, token)));
                    return;
                }
                default: {
                    sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
                }
            }
        } catch (error) {
            if (error instanceof LoginRequiredError) {
                sendError(response, "not_logged_in", error.message);
                return;
            }
            // 上游不可达、页面结构变更、解析失败都归到这里
            sendError(response, "upstream_unavailable", describeTransportError(error));
        }
    }

    function health(): SystemHealth {
        const now = Math.floor(Date.now() / 1000);
        return {
            status: "ok",
            version: options.version,
            nodeVersion: process.version,
            platform:
                process.platform === "win32"
                    ? "windows"
                    : process.platform === "darwin"
                      ? "macos"
                      : "linux",
            startedAt,
            uptimeSeconds: now - startedAt,
        };
    }

    function openEventStream(request: IncomingMessage, response: ServerResponse): void {
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });
        response.write("retry: 3000\n\n");
        clients.add(response);

        const heartbeat = setInterval(() => {
            response.write(": ping\n\n");
        }, API_EVENT_HEARTBEAT_MS);

        request.on("close", () => {
            clearInterval(heartbeat);
            clients.delete(response);
        });

        writeEvent(response, "server.ready", { version: options.version, startedAt });
    }

    options.service.onChange((snapshot) => {
        broadcast("config.changed", { snapshot });
    });

    options.auth?.onChange((status) => {
        broadcast("auth.changed", { status });
    });

    options.downloads?.onChange((task) => {
        broadcast("download.changed", { task });
    });

    options.updates?.onChange((entry) => {
        broadcast("library.update", entry);
    });

    // 进度单独推送：查完最后一条时队列已经为空，但那一轮尚未结束，界面要等这条事件才知道处理完毕
    options.updates?.onState(({ checking, pending }) => {
        broadcast("library.progress", { checking, pending });
    });

    options.logs?.onChange(({ level, message, at, tag }) => {
        broadcast("log.appended", { level, tag, message, at });
    });

    function broadcast<K extends ApiEventName>(event: K, data: ApiEventPayloads[K]): void {
        for (const client of clients) {
            writeEvent(client, event, data);
        }
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(requestedPort, host, () => {
            startedAt = Math.floor(Date.now() / 1000);
            resolvePromise();
        });
    });

    const boundPort = currentPort();

    return {
        url: `http://localhost:${boundPort}/`,
        host,
        port: boundPort,
        token: options.token,
        broadcast,
        async close() {
            for (const client of clients) {
                client.end();
            }
            clients.clear();
            await new Promise<void>((resolvePromise, rejectPromise) => {
                server.close((error) => {
                    if (error) {
                        rejectPromise(error);
                        return;
                    }
                    resolvePromise();
                });
            });
        },
    };
}

/** 启动时生成一次性令牌 */
export function generateToken(): string {
    return randomBytes(16).toString("hex");
}

function buildMatchers(): Array<{
    name: ApiRouteName;
    method: HttpMethod;
    regex: RegExp;
    keys: string[];
}> {
    return (Object.keys(ROUTES) as ApiRouteName[]).map((name) => {
        const route = ROUTES[name];
        const keys: string[] = [];
        const pattern = route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
            keys.push(key);
            return "([^/]+)";
        });
        return { name, method: route.method, regex: new RegExp(`^${pattern}$`), keys };
    });
}

function matchRoute(method: HttpMethod, pathname: string): MatchedRoute | null {
    for (const matcher of MATCHERS) {
        if (matcher.method !== method) {
            continue;
        }
        const found = matcher.regex.exec(pathname);
        if (found === null) {
            continue;
        }
        const params: Record<string, string> = {};
        matcher.keys.forEach((key, index) => {
            params[key] = decodeURIComponent(found[index + 1] ?? "");
        });
        return { name: matcher.name, method, params };
    }
    return null;
}

function isHostAllowed(hostHeader: string | undefined, host: string, port: number): boolean {
    if (hostHeader === undefined) {
        return true;
    }
    const allowed = [`localhost:${port}`, `${host}:${port}`, `[::1]:${port}`];
    return allowed.includes(hostHeader.toLowerCase());
}

function isOriginAllowed(origin: string | undefined, host: string, port: number): boolean {
    if (origin === undefined) {
        return true;
    }
    const allowed = [`http://localhost:${port}`, `http://${host}:${port}`, `http://[::1]:${port}`];
    return allowed.includes(origin.toLowerCase());
}

function readToken(request: IncomingMessage, url: URL): string | null {
    const header = request.headers[API_TOKEN_HEADER];
    if (typeof header === "string" && header !== "") {
        return header;
    }
    return url.searchParams.get(API_TOKEN_QUERY_PARAM);
}

/** 定长比较，避免按字符提前返回 */
function tokenMatches(provided: string | null, expected: string): boolean {
    if (provided === null) {
        return false;
    }
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
        }
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") {
        throw new Error("请求体为空");
    }
    return JSON.parse(text) as unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = `${JSON.stringify(payload)}\n`;
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}

function sendError(
    response: ServerResponse,
    code: ApiErrorCode,
    message: string,
    issues?: readonly FieldIssue[],
): void {
    sendJson(response, statusForError(code), fail(code, message, { issues }));
}

function writeEvent<K extends ApiEventName>(
    response: ServerResponse,
    event: K,
    data: ApiEventPayloads[K],
): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function resolveStaticDir(): Promise<string | null> {
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const candidate of [join(root, "dist", "web"), join(root, "web")]) {
        try {
            const info = await stat(candidate);
            if (info.isDirectory()) {
                return candidate;
            }
        } catch {
            // 继续尝试下一个候选目录
        }
    }
    return null;
}

/** 收藏路由。本地部分是同步的，云端部分失败时只影响那一条 */
async function handleFavorites(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    matched: MatchedRoute,
    favorites: FavoriteService | undefined,
): Promise<void> {
    if (favorites === undefined) {
        sendError(response, "not_implemented", "收藏服务未接入");
        return;
    }
    const folderId = matched.params["folderId"] ?? "";
    const gid = Number(matched.params["gid"]);

    async function body(): Promise<unknown> {
        try {
            return await readJsonBody(request);
        } catch (error) {
            sendError(response, "bad_request", describeError(error));
            return undefined;
        }
    }

    try {
        switch (matched.name) {
            case "favorites.state": {
                sendJson(response, 200, ok(await favorites.state()));
                return;
            }
            case "favorites.folder.create": {
                const payload = (await body()) as { name?: string } | undefined;
                if (payload === undefined) {
                    return;
                }
                sendJson(response, 200, ok(favorites.createFolder(payload.name ?? "")));
                return;
            }
            case "favorites.folder.remove": {
                sendJson(response, 200, ok(favorites.removeFolder(folderId)));
                return;
            }
            case "favorites.items": {
                sendJson(response, 200, ok(favorites.items(folderId)));
                return;
            }
            case "favorites.items.add": {
                const payload = await body();
                if (payload === undefined) {
                    return;
                }
                sendJson(
                    response,
                    200,
                    ok(await favorites.add(payload as Parameters<FavoriteService["add"]>[0])),
                );
                return;
            }
            case "favorites.items.remove": {
                sendJson(response, 200, ok(favorites.removeItem(folderId, gid)));
                return;
            }
            case "favorites.items.slot": {
                const payload = (await body()) as { slot?: unknown } | undefined;
                if (payload === undefined) {
                    return;
                }
                const slot = Number(payload.slot);
                if (!Number.isFinite(slot)) {
                    sendError(response, "bad_request", "slot 必须是数字");
                    return;
                }
                sendJson(response, 200, ok(await favorites.setSlot(folderId, gid, slot)));
                return;
            }
            case "favorites.cloud": {
                const slot = Number(url.searchParams.get("slot") ?? 0);
                sendJson(response, 200, ok(await favorites.cloudItems(slot)));
                return;
            }
            case "favorites.items.refresh": {
                const payload = (await body()) as { gids?: unknown } | undefined;
                if (payload === undefined) {
                    return;
                }
                const gids = (Array.isArray(payload.gids) ? payload.gids : [])
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value));
                sendJson(response, 200, ok(await favorites.refresh(folderId, gids)));
                return;
            }
            default: {
                sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
            }
        }
    } catch (error) {
        if (error instanceof LoginRequiredError) {
            sendError(response, "not_logged_in", error.message);
            return;
        }
        sendError(response, "upstream_unavailable", describeTransportError(error));
    }
}

/** 播放列表路由。每条都返回整份快照，界面收到后可直接替换本地状态 */
async function handlePlaylist(
    request: IncomingMessage,
    response: ServerResponse,
    matched: MatchedRoute,
    playlist: PlaylistService | undefined,
): Promise<void> {
    if (playlist === undefined) {
        sendError(response, "not_implemented", "播放列表未接入");
        return;
    }

    const key = decodeURIComponent(matched.params["key"] ?? "");
    try {
        switch (matched.name) {
            case "playlist.list": {
                sendJson(response, 200, ok(playlist.snapshot()));
                return;
            }
            case "playlist.add": {
                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch (error) {
                    sendError(response, "bad_request", describeError(error));
                    return;
                }
                sendJson(
                    response,
                    200,
                    ok(playlist.add(body as Parameters<PlaylistService["add"]>[0])),
                );
                return;
            }
            case "playlist.play": {
                sendJson(response, 200, ok(playlist.play(key)));
                return;
            }
            case "playlist.progress": {
                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch (error) {
                    sendError(response, "bad_request", describeError(error));
                    return;
                }
                const page = Number((body as { page?: unknown }).page);
                if (!Number.isFinite(page)) {
                    sendError(response, "bad_request", "page 必须是数字");
                    return;
                }
                sendJson(response, 200, ok(playlist.progress(key, page)));
                return;
            }
            case "playlist.remove": {
                sendJson(response, 200, ok(playlist.remove(key)));
                return;
            }
            case "playlist.clear": {
                sendJson(response, 200, ok(playlist.clear()));
                return;
            }
            default: {
                sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
            }
        }
    } catch (error) {
        sendError(response, "internal", describeError(error));
    }
}

/**
 * 标签翻译词库路由
 * 词库不随程序分发，未接入或未安装时回一份空状态，界面照常使用内置的那份
 */
async function handleTranslate(
    response: ServerResponse,
    matched: MatchedRoute,
    translate: TranslateService | undefined,
): Promise<void> {
    const empty: TranslateStatus = {
        installed: false,
        version: null,
        updatedAt: null,
        source: "",
        tagCount: 0,
        namespaceCount: 0,
        updating: false,
        error: null,
    };
    if (translate === undefined) {
        sendJson(response, 200, ok(matched.name === "translate.tags" ? null : empty));
        return;
    }
    try {
        switch (matched.name) {
            case "translate.tags": {
                sendJson(response, 200, ok(await translate.database()));
                return;
            }
            case "translate.update": {
                sendJson(response, 200, ok(await translate.update()));
                return;
            }
            case "translate.remove": {
                sendJson(response, 200, ok(await translate.remove()));
                return;
            }
            default: {
                sendJson(response, 200, ok(await translate.status()));
            }
        }
    } catch (error) {
        sendError(response, "internal", describeError(error));
    }
}

/*
 * 储存空间路由。storage 在 ServerOptions 中声明为可选参数，未接入时统一返回 not_implemented。
 */
async function handleStorage(
    request: IncomingMessage,
    response: ServerResponse,
    matched: MatchedRoute,
    storage: StorageService | undefined,
): Promise<void> {
    if (storage === undefined) {
        sendError(response, "not_implemented", "储存空间未接入");
        return;
    }
    try {
        switch (matched.name) {
            case "storage.stats": {
                sendJson(response, 200, ok(await storage.stats()));
                return;
            }
            case "storage.cleanup": {
                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch (error) {
                    sendError(response, "bad_request", describeError(error));
                    return;
                }
                const days = Number((body as { days?: unknown }).days);
                if (!Number.isFinite(days) || days < 0) {
                    sendError(response, "bad_request", "days 必须是不小于 0 的数字");
                    return;
                }
                sendJson(response, 200, ok(await storage.cleanup(days)));
                return;
            }
            default: {
                sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
            }
        }
    } catch (error) {
        sendError(response, "internal", describeError(error));
    }
}

/**
 * 本地库路由
 * 图片接口直接返回图片本身，因为它要能放进 <img src>，令牌经 query 传递，与 SSE 的处理方式相同
 */
async function handleLibrary(
    request: IncomingMessage,
    response: ServerResponse,
    matched: MatchedRoute,
    library: LocalLibrary | undefined,
    updates: UpdateService | undefined,
): Promise<void> {
    // 更新检查只读内存缓存，不依赖本地库是否接入
    if (matched.name === "library.updates") {
        sendJson(
            response,
            200,
            ok(updates?.state() ?? { checking: false, entries: [], pending: 0 }),
        );
        return;
    }
    if (matched.name === "library.updates.forget") {
        if (updates === undefined) {
            sendJson(response, 200, ok({ checking: false, entries: [], pending: 0 }));
            return;
        }
        let payload: unknown;
        try {
            payload = await readJsonBody(request);
        } catch (error) {
            sendError(response, "bad_request", describeError(error));
            return;
        }
        const keys = (payload as { keys?: unknown }).keys;
        sendJson(
            response,
            200,
            ok(updates.forget(Array.isArray(keys) ? keys.map((key) => String(key)) : [])),
        );
        return;
    }
    if (matched.name === "library.check") {
        if (updates === undefined) {
            sendJson(response, 200, ok({ checking: false, entries: [], pending: 0 }));
            return;
        }
        let body: unknown;
        try {
            body = await readJsonBody(request);
        } catch (error) {
            sendError(response, "bad_request", describeError(error));
            return;
        }
        const input = body as {
            targets?: readonly UpdateCheckTarget[];
            keys?: readonly string[];
            reset?: boolean;
        };
        sendJson(response, 200, ok(await updates.check(input)));
        return;
    }

    if (library === undefined) {
        sendError(response, "not_implemented", "本地库未接入");
        return;
    }

    const gid = Number(matched.params["gid"]);
    const resolution = matched.params["resolution"] ?? "";

    try {
        switch (matched.name) {
            case "library.list": {
                sendJson(response, 200, ok(await library.list()));
                return;
            }
            case "library.progress": {
                let body: unknown;
                try {
                    body = await readJsonBody(request);
                } catch (error) {
                    sendError(response, "bad_request", describeError(error));
                    return;
                }
                const page = Number((body as { page?: unknown }).page);
                if (!Number.isFinite(page)) {
                    sendError(response, "bad_request", "page 必须是数字");
                    return;
                }
                const saved = await library.saveProgress(gid, resolution, page);
                if (saved === null) {
                    sendError(response, "not_found", `本地没有这个画廊：${gid} ${resolution}`);
                    return;
                }
                sendJson(response, 200, ok(saved));
                return;
            }
            case "library.image": {
                const page = Number(matched.params["page"]);
                const file = await library.imagePath(gid, resolution, page);
                if (file === null) {
                    sendError(
                        response,
                        "not_found",
                        `本地没有这一页：${gid} ${resolution} 第 ${page} 页`,
                    );
                    return;
                }
                const content = await readFile(file);
                response.writeHead(200, {
                    "content-type": contentTypeOf(file),
                    "content-length": String(content.byteLength),
                    // 本地文件不常变，给一小段缓存：播放器来回翻页不必反复读盘
                    "cache-control": "private, max-age=300",
                });
                response.end(content);
                return;
            }
            case "library.remove": {
                const removed = await library.remove(gid, resolution);
                sendJson(response, 200, ok({ removed }));
                return;
            }
            default: {
                sendError(response, "not_implemented", `路由尚未实现：${matched.name}`);
            }
        }
    } catch (error) {
        sendError(response, "internal", describeError(error));
    }
}

async function serveStatic(
    response: ServerResponse,
    pathname: string,
    staticDir: string | null,
    token: string,
    port: number,
    client: ServedTo,
): Promise<void> {
    if (staticDir === null) {
        sendHtml(response, 200, fallbackPage(token, port));
        return;
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = resolve(staticDir, normalize(relative));
    if (!target.startsWith(staticDir + sep) && target !== staticDir) {
        sendError(response, "forbidden", "路径越界");
        return;
    }

    try {
        const content = await readFile(target);
        if (target.endsWith(".html")) {
            sendHtml(response, 200, injectToken(content.toString("utf8"), token, port));
            return;
        }
        response.writeHead(200, { "content-type": contentTypeOf(target) });
        response.end(content);
    } catch {
        const index = await readIndexForRoute(staticDir, pathname, client);
        if (index !== null) {
            sendHtml(response, 200, injectToken(index, token, port));
            return;
        }
        sendError(response, "not_found", `资源不存在：${pathname}`);
    }
}

/**
 * 前端用 HTML5 路径，深链与刷新会请求不存在的无扩展名路径，此时回退到界面入口
 * 带扩展名的请求仍按资源处理，否则构建产物过期时会拿到一段 HTML 当脚本执行
 */
async function readIndexForRoute(
    staticDir: string,
    pathname: string,
    client: ServedTo,
): Promise<string | null> {
    if (client.method !== "GET" && client.method !== "HEAD") {
        return null;
    }
    if (!client.accept.includes("text/html")) {
        return null;
    }
    if (pathname === "/" || pathname.startsWith("/api/") || extname(pathname) !== "") {
        return null;
    }
    try {
        return (await readFile(resolve(staticDir, "index.html"))).toString("utf8");
    } catch {
        return null;
    }
}

/** 回退判断需要的信息，避免把整个请求对象带进静态服务 */
interface ServedTo {
    readonly method: string;
    readonly accept: string;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
    });
    response.end(html);
}

/** 把令牌与端口注入页面，供界面脚本读取 */
function injectToken(html: string, token: string, port: number): string {
    const boot = `<script>window.__EHBROWSER__=${JSON.stringify({ token, port })}</script>`;
    const head = html.indexOf("</head>");
    return head === -1 ? boot + html : `${html.slice(0, head)}${boot}${html.slice(head)}`;
}

function contentTypeOf(file: string): string {
    switch (extname(file).toLowerCase()) {
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        case ".bmp":
            return "image/bmp";
        case ".avif":
            return "image/avif";
        case ".ico":
            return "image/x-icon";
        // 图标字体（web/src/assets/iconfont.ttf）
        case ".ttf":
            return "font/ttf";
        case ".woff":
            return "font/woff";
        case ".woff2":
            return "font/woff2";
        default:
            return "application/octet-stream";
    }
}

/** 未找到静态目录时的兜底页面 */
function fallbackPage(token: string, port: number): string {
    return injectToken(
        `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>EhBrowser</title></head>
<body>
<h1>EhBrowser</h1>
<p>未找到静态资源目录（dist/web 或 web），当前为兜底页面。</p>
<p>服务端口：${port}</p>
</body>
</html>
`,
        token,
        port,
    );
}

/** 凭据不足、输入不合法归 400；上游不可达归 502 */
function classifyError(error: unknown): ApiErrorCode {
    if (error instanceof LoginRequiredError) {
        return "not_logged_in";
    }
    if (error instanceof ConfigInvalidError) {
        return "config_invalid";
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || errorCode(error).startsWith("UND_ERR") || name === "TypeError") {
        return "upstream_unavailable";
    }
    return "bad_request";
}

/** fresh 参数：buildQueryString 把布尔值写成 1/0 */
function isFresh(url: URL): boolean {
    const raw = url.searchParams.get("fresh");
    return raw === "1" || raw === "true";
}

/** 查询串 -> 搜索条件。逗号分隔的多值参数 */
function readSearchQuery(url: URL): GallerySearchQuery {
    const query: {
        page?: number;
        limit?: number;
        query?: string;
        categories?: readonly GalleryCategory[];
        excludedCategories?: readonly GalleryCategory[];
        language?: GalleryLanguage;
        minRating?: number;
    } = {};

    const page = readInt(url, "page");
    query.page = page === null ? 1 : page;
    const limit = readInt(url, "limit");
    if (limit !== null) {
        query.limit = limit;
    }
    const text = url.searchParams.get("query");
    if (text !== null && text !== "") {
        query.query = text;
    }
    const categories = readList(url, "categories");
    if (categories !== undefined) {
        query.categories = categories as readonly GalleryCategory[];
    }
    const excluded = readList(url, "excludedCategories");
    if (excluded !== undefined) {
        query.excludedCategories = excluded as readonly GalleryCategory[];
    }
    const language = url.searchParams.get("language");
    if (language !== null && language !== "") {
        query.language = language as GalleryLanguage;
    }
    const minRating = readInt(url, "minRating");
    if (minRating !== null) {
        query.minRating = minRating;
    }
    return query;
}

function readInt(url: URL, key: string): number | null {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === "") {
        return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? Math.trunc(value) : null;
}

function readList(url: URL, key: string): string[] | undefined {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === "") {
        return undefined;
    }
    return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
}
