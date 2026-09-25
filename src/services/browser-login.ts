import type { BrowserContext, BrowserType } from "playwright-core";

import { pickLoginCookies, type CookieMap, type LoginCookies } from "../eh/index.ts";
import { describeError } from "../platform/errors.ts";

// 浏览器代理
export interface BrowserProxy {
    readonly server: string;
    readonly username?: string;
    readonly password?: string;
}

// 登录会话
export interface BrowserLoginSession {
    // 登入凭据
    readonly credentials: Promise<LoginCookies>;
    // 关闭窗口
    close(): Promise<void>;
}

export interface BrowserLoginRunner {
    // 环境自检
    availability(): { readonly ok: true } | { readonly ok: false; readonly reason: string };
    // 打开窗口并等待登录
    open(options: {
        readonly timeoutMs: number;
        readonly signal: AbortSignal;
    }): Promise<BrowserLoginSession>;
    // 关闭所有窗口
    shutdown(): Promise<void>;
}

export class BrowserLoginTimeoutError extends Error {
    constructor(message = "等你登录超时了。换一个出口节点，或改用「导入 Cookie」") {
        super(message);
        this.name = "BrowserLoginTimeoutError";
    }
}

export class BrowserLoginCancelledError extends Error {
    constructor(message = "浏览器登录已取消") {
        super(message);
        this.name = "BrowserLoginCancelledError";
    }
}

export interface BrowserLoginRunnerOptions {
    // 浏览器配置目录
    readonly profileDir: string;
    // 读取当前代理
    readonly proxy: () => BrowserProxy | null;
    readonly loginUrl?: string;
    readonly logger?: (level: "info" | "warn", message: string) => void;
    // 轮询间隔
    readonly pollMs?: number;
    // 打开登录页超时
    readonly openTimeoutMs?: number;
    // 候选浏览器
    readonly channels?: readonly (string | undefined)[];
}

const DEFAULT_LOGIN_URL = "https://forums.e-hentai.org/index.php?act=Login&CODE=00";

// 候选浏览器顺序
const CHANNELS: readonly (string | undefined)[] = ["msedge", "chrome", undefined];

// 提取凭据 cookie
function credentialsOf(cookies: readonly { name: string; value: string }[]): LoginCookies | null {
    const map: CookieMap = {};
    for (const cookie of cookies) {
        map[cookie.name] ??= cookie.value;
    }
    const picked = pickLoginCookies(map);
    const memberId = picked.ipbMemberId ?? "";
    const passHash = picked.ipbPassHash ?? "";
    if (memberId === "" || passHash === "") {
        return null;
    }
    const sessionId = picked.ipbSessionId ?? "";
    return sessionId === ""
        ? { ipbMemberId: memberId, ipbPassHash: passHash }
        : { ipbMemberId: memberId, ipbPassHash: passHash, ipbSessionId: sessionId };
}

// 轮询 cookie
function watchCredentials(
    context: BrowserContext,
    options: { readonly timeoutMs: number; readonly pollMs: number; readonly signal: AbortSignal },
): { credentials: Promise<LoginCookies>; stop: () => void } {
    let stop: () => void = () => undefined;

    const credentials = new Promise<LoginCookies>((resolve, reject) => {
        let settled = false;

        // 统一收尾
        function settle(action: () => void): void {
            if (settled) {
                return;
            }
            settled = true;
            clearInterval(timer);
            clearTimeout(deadline);
            options.signal.removeEventListener("abort", onAbort);
            context.off("close", onClose);
            action();
        }

        const timer = setInterval(() => {
            void context
                .cookies()
                .then((cookies) => {
                    const found = credentialsOf(cookies);
                    if (found !== null) {
                        settle(() => resolve(found));
                    }
                })
                .catch(() => {
                    // 忽略读取失败
                });
        }, options.pollMs);

        const deadline = setTimeout(
            () => settle(() => reject(new BrowserLoginTimeoutError())),
            options.timeoutMs,
        );
        deadline.unref();

        function onAbort(): void {
            settle(() => reject(new BrowserLoginCancelledError()));
        }
        function onClose(): void {
            settle(() => reject(new BrowserLoginCancelledError("浏览器窗口被关掉了")));
        }

        options.signal.addEventListener("abort", onAbort, { once: true });
        context.on("close", onClose);
        stop = () => settle(() => reject(new BrowserLoginCancelledError("浏览器窗口已关闭")));
        if (options.signal.aborted) {
            onAbort();
        }
    });

    return { credentials, stop };
}

export function createBrowserLoginRunner(options: BrowserLoginRunnerOptions): BrowserLoginRunner {
    const log = options.logger ?? (() => undefined);
    const pollMs = options.pollMs ?? 1000;
    const openTimeoutMs = options.openTimeoutMs ?? 90_000;
    const loginUrl = options.loginUrl ?? DEFAULT_LOGIN_URL;
    let live: BrowserContext | null = null;

    // 是否拥有桌面环境
    function availability(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
        if (
            process.platform === "linux" &&
            !process.env["DISPLAY"] &&
            !process.env["WAYLAND_DISPLAY"]
        ) {
            return {
                ok: false,
                reason: "当前没有图形界面（DISPLAY / WAYLAND_DISPLAY 都不在），浏览器登录需要桌面会话",
            };
        }
        return { ok: true };
    }

    // 动态导入 playwright-core
    async function loadChromium(): Promise<BrowserType> {
        try {
            const module = await import("playwright-core");
            return module.chromium;
        } catch (error) {
            throw new Error(
                `浏览器登录不可用：没能加载 playwright-core（${describeError(error)}）。` +
                    "它应当在依赖里，重新 npm install 一次",
            );
        }
    }

    async function launch(chromium: BrowserType): Promise<BrowserContext> {
        const proxy = options.proxy();
        const attempts: string[] = [];
        for (const channel of options.channels ?? CHANNELS) {
            const label = channel ?? "playwright-chromium";
            try {
                const context = await chromium.launchPersistentContext(options.profileDir, {
                    headless: false,
                    viewport: null,
                    // 禁用自动化标识
                    args: ["--disable-blink-features=AutomationControlled"],
                    ...(channel === undefined ? {} : { channel }),
                    ...(proxy === null ? {} : { proxy }),
                });
                log(
                    "info",
                    `浏览器已启动：${label}${proxy === null ? "" : `（代理 ${proxy.server}）`}`,
                );
                return context;
            } catch (error) {
                const first = describeError(error).split("\n")[0] ?? "";
                attempts.push(`${label}: ${first}`);
                // 候选不可用时尝试下一个
                if (
                    !/Executable doesn't exist|is not found|Cannot find|Unsupported (chromium )?channel/i.test(
                        first,
                    )
                ) {
                    throw new Error(`打不开浏览器（${label}）：${first}`);
                }
            }
        }
        throw new Error(
            "未找到可用的浏览器。请先安装浏览器或者 " +
                "使用 `npx playwright install chromium` 来安装一个浏览器内核" +
                `已尝试的浏览器：${attempts.join("；")}`,
        );
    }

    return {
        availability,

        async open({ timeoutMs, signal }) {
            const available = availability();
            if (!available.ok) {
                throw new Error(available.reason);
            }
            const chromium = await loadChromium();
            const context = await launch(chromium);
            live = context;

            let page;
            try {
                page = context.pages()[0] ?? (await context.newPage());
                await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: openTimeoutMs });
            } catch (error) {
                // 启动失败时关闭浏览器
                live = null;
                await context.close().catch(() => undefined);
                const first = describeError(error).split("\n")[0] ?? "";
                throw new Error(`打开登录页失败：${first}`);
            }

            const { credentials, stop } = watchCredentials(context, { timeoutMs, pollMs, signal });

            return {
                credentials,
                async close() {
                    stop();
                    if (live === context) {
                        live = null;
                    }
                    await context.close().catch(() => undefined);
                },
            };
        },

        async shutdown() {
            const context = live;
            live = null;
            if (context !== null) {
                await context.close().catch(() => undefined);
            }
        },
    };
}
