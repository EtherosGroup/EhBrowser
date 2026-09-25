/*
 * 账号服务：登录、igneous 维护、账号增删改与状态摘要。
 * 凭据只写入 auth_setting，对外一律脱敏；变更后经 SSE 通知界面。
 */

import {
    activeAccount,
    igneousAgeDays,
    isIgneousStale,
    newAccountId,
    removeAccount as removeFromList,
    upsertAccount,
    type Account,
    type AuthSetting,
    type ConfigContext,
} from "../config/index.ts";
import {
    fetchIgneous,
    forumLogin,
    hasLoginCookies,
    isIgneousValue,
    probeExAccess,
} from "../eh/index.ts";
import type {
    AccountCredentialsInput,
    AccountSummary,
    AccountUpdateInput,
    AuthStatus,
    BrowserLoginInput,
    BrowserLoginPhase,
    BrowserLoginState,
    LoginInput,
} from "../api/index.ts";
import { describeError, describeTransportError } from "../platform/errors.ts";
import {
    BrowserLoginTimeoutError,
    type BrowserLoginRunner,
    type BrowserLoginSession,
} from "./browser-login.ts";

export interface AuthService {
    status(): AuthStatus;
    /** 用账号密码登录并获取 igneous */
    login(input: LoginInput): Promise<AuthStatus>;
    logout(): Promise<AuthStatus>;
    /** 重新获取当前账号的 igneous */
    refreshIgneous(): Promise<AuthStatus>;
    /** 探测里站可达性，结果缓存在 meta 表 */
    probeExAccess(): Promise<boolean>;
    listAccounts(): readonly AccountSummary[];
    createAccount(input: AccountCredentialsInput): Promise<AccountSummary>;
    updateAccount(id: string, patch: AccountUpdateInput): Promise<AccountSummary>;
    removeAccount(id: string): Promise<boolean>;
    activateAccount(id: string): Promise<AuthStatus>;
    /**
     * 开一个真实浏览器窗口让用户登录。
     * 窗口开在用户自己的桌面上，服务端只能等，所以立刻返回，进度看 status().browserLogin
     */
    startBrowserLogin(input: BrowserLoginInput): AuthStatus;
    /** 取消正在进行的浏览器登录；没有会话时是空操作 */
    cancelBrowserLogin(): AuthStatus;
    onChange(listener: (status: AuthStatus) => void): () => void;
}

export interface AuthServiceOptions {
    readonly logger?: (level: "info" | "warn", message: string) => void;
    /** 浏览器登录的执行者；不传则这条功能在界面上会说明不可用 */
    readonly browserLogin?: BrowserLoginRunner;
    /** 等用户在浏览器窗口里登录的时长 */
    readonly browserLoginTimeoutMs?: number;
}

const EX_ACCESS_META_KEY = "ex_accessible";

/** 等用户登录的默认时长。够慢吞吞地输密码、过挑战；也够早一点把窗口收掉 */
const DEFAULT_BROWSER_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function createAuthService(
    ctx: ConfigContext,
    options: AuthServiceOptions = {},
): AuthService {
    const log = options.logger ?? (() => undefined);
    const listeners = new Set<(status: AuthStatus) => void>();

    /** 浏览器登录的会话状态。只有一个会话，与「同一时刻只开一个窗口」对应 */
    let browserState: BrowserLoginState = { phase: "idle", message: "", startedAt: null };
    let browserAbort: AbortController | null = null;

    function setBrowserState(phase: BrowserLoginPhase, message: string): void {
        browserState = {
            phase,
            message,
            startedAt: phase === "launching" ? Math.floor(Date.now() / 1000) : browserState.startedAt,
        };
        broadcast();
    }

    function status(): AuthStatus {
        const auth = ctx.auth.get();
        const account = activeAccount(auth);
        const cached = ctx.db.getMeta(EX_ACCESS_META_KEY);
        // 账号条目可能仍在但凭据已被清除，故以凭据是否可用判定登录态
        const usable = account !== null && hasLoginCookies(account.cookies);
        return {
            loggedIn: usable,
            activeAccount: account === null ? null : summarize(auth, account),
            accountCount: auth.accounts.length,
            igneousAgeDays: usable ? igneousAgeDays(account) : null,
            igneousStale: usable ? isIgneousStale(account) : false,
            exAccessible: cached === null ? null : cached === "1",
            browserLogin: browserState,
        };
    }

    function broadcast(): void {
        const next = status();
        for (const listener of listeners) {
            try {
                listener(next);
            } catch {
                // 单个订阅者异常不影响其余订阅者
            }
        }
    }

    ctx.auth.onChange(() => {
        broadcast();
    });

    /** 写入账号并设为当前账号 */
    async function persistAccount(account: Account, makeActive: boolean): Promise<void> {
        const auth = ctx.auth.get();
        await ctx.auth.patch({
            accounts: upsertAccount(auth.accounts, account),
            activeAccountId: makeActive ? account.id : auth.activeAccountId,
        });
    }

    /**
     * 里站可达性探测
     * 探测失败（连接失败、握手被重置、连接被拒）按「不可达」处理，只记日志：
     * 该结果为可选信息，不应影响登录之类的主流程
     */
    async function probe(): Promise<boolean> {
        const account = activeAccount(ctx.auth.get());
        let accessible = false;
        try {
            accessible = await probeExAccess(
                account === null
                    ? {}
                    : {
                          ipbMemberId: account.cookies.ipbMemberId,
                          ipbPassHash: account.cookies.ipbPassHash,
                          igneous: account.cookies.igneous,
                      },
            );
        } catch (error) {
            log("warn", `里站探测失败，按不可达处理：${describeTransportError(error)}`);
        }
        ctx.db.setMeta(EX_ACCESS_META_KEY, accessible ? "1" : "0");
        log("info", `里站探测：${accessible ? "可达" : "不可达"}`);
        broadcast();
        return accessible;
    }

    /** 补齐 igneous；取不到时只记日志，登录本身仍算成功 */
    async function withIgneous(account: Account): Promise<Account> {
        if (isIgneousValue(account.cookies.igneous)) {
            return account;
        }
        let igneous: string | null = null;
        try {
            igneous = await fetchIgneous(
                {
                    ipbMemberId: account.cookies.ipbMemberId,
                    ipbPassHash: account.cookies.ipbPassHash,
                    ...(account.cookies.ipbSessionId === undefined
                        ? {}
                        : { ipbSessionId: account.cookies.ipbSessionId }),
                },
                {
                    onFailure: (site, error) => {
                        log(
                            "warn",
                            `取 igneous 时 ${site} 请求失败（继续试下一个）：${describeTransportError(error)}`,
                        );
                    },
                },
            );
        } catch (error) {
            // 兜底：取 igneous 失败只影响 igneous，登录本身照常算成功
            log("warn", `未取到 igneous：${describeTransportError(error)}`);
            return account;
        }
        if (igneous === null) {
            log("warn", "未取到 igneous：当前出口节点可能被上游拒绝，里站需换节点后重新登录");
            return account;
        }
        log("info", `已取得 igneous（${igneous.length} 位）`);
        return {
            ...account,
            cookies: { ...account.cookies, igneous },
            igneousUpdatedAt: Math.floor(Date.now() / 1000),
        };
    }

    /**
     * 落一个账号：只要求两份凭据 cookie，igneous 由服务端自己补。
     * 导入 Cookie 与 浏览器登录 都走这里
     */
    async function importAccount(input: AccountCredentialsInput): Promise<AccountSummary> {
        if (!hasLoginCookies(input.cookies)) {
            throw new Error("Cookie 不完整：ipb_member_id 与 ipb_pass_hash 必填");
        }
        const now = Math.floor(Date.now() / 1000);
        const account: Account = {
            id: newAccountId(),
            label: input.label,
            site: input.site,
            cookies: {
                ipbMemberId: input.cookies.ipbMemberId,
                ipbPassHash: input.cookies.ipbPassHash,
                igneous: input.cookies.igneous,
                ...(input.cookies.ipbSessionId === undefined
                    ? {}
                    : { ipbSessionId: input.cookies.ipbSessionId }),
            },
            // 导入时常常只带两份凭据 cookie，此时时间戳留空：取到 igneous 才写，
            // 否则界面会把「没有 igneous」显示成「已 0 天」
            igneousUpdatedAt: isIgneousValue(input.cookies.igneous) ? now : null,
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        };

        // 当前账号不存在、或它已经没有可用凭据（清除过登录态）时，导入的这份直接顶上
        const current = activeAccount(ctx.auth.get());
        const makeActive = current === null || !hasLoginCookies(current.cookies);

        // 先落库：igneous 要回上游取，网络不通时可能一直等到超时，那两份凭据不该因此丢掉。
        // 写入经 SSE 立刻把账号推到界面，补 igneous 只是第二次写
        await persistAccount(account, makeActive);

        const completed = await withIgneous(account);
        if (completed.cookies.igneous !== account.cookies.igneous) {
            await persistAccount(completed, makeActive);
        }
        // 里站探测只是可选信息，不占这次导入的响应时间：结果到了会经 SSE 推给界面
        if (makeActive) {
            void probe();
        }
        log("info", `账号已导入：${completed.label}`);
        return summarize(ctx.auth.get(), completed);
    }

    /** 开窗 -> 等凭据 -> 导入 -> 关窗 */
    async function runBrowserLogin(
        runner: BrowserLoginRunner,
        controller: AbortController,
        input: BrowserLoginInput,
    ): Promise<void> {
        let session: BrowserLoginSession | null = null;
        try {
            session = await runner.open({
                timeoutMs: options.browserLoginTimeoutMs ?? DEFAULT_BROWSER_LOGIN_TIMEOUT_MS,
                signal: controller.signal,
            });
            setBrowserState("waiting", "等待你在浏览器窗口里完成登录…");
            const cookies = await session.credentials;
            setBrowserState("waiting", "已拿到凭据，正在保存并获取 igneous…");
            const account = await importAccount({
                label: input.label ?? "浏览器登录",
                site: input.site,
                cookies: {
                    ipbMemberId: cookies.ipbMemberId,
                    ipbPassHash: cookies.ipbPassHash,
                    igneous: "",
                    ...(cookies.ipbSessionId === undefined
                        ? {}
                        : { ipbSessionId: cookies.ipbSessionId }),
                },
            });
            setBrowserState("succeeded", `已登录并保存：${account.label}`);
            log("info", `浏览器登录完成：${account.label}`);
        } catch (error) {
            if (controller.signal.aborted) {
                setBrowserState("cancelled", "已取消浏览器登录");
            } else if (error instanceof BrowserLoginTimeoutError) {
                setBrowserState("timeout", error.message);
            } else {
                setBrowserState("failed", describeError(error));
            }
            log("warn", `浏览器登录未完成：${describeError(error)}`);
        } finally {
            browserAbort = null;
            await session?.close();
        }
    }

    return {
        status,

        async login(input) {
            log("info", `开始登录：${input.username}`);
            // 失败时log
            const cookies = await forumLogin({
                username: input.username,
                password: input.password,
            }).catch((error: unknown) => {
                log("warn", describeError(error));
                throw error;
            });

            const account: Account = {
                id: newAccountId(),
                label: input.label ?? input.username,
                site: input.site,
                cookies: {
                    ipbMemberId: cookies.ipbMemberId,
                    ipbPassHash: cookies.ipbPassHash,
                    igneous: "",
                    ...(cookies.ipbSessionId === undefined
                        ? {}
                        : { ipbSessionId: cookies.ipbSessionId }),
                },
                igneousUpdatedAt: null,
            };

            const completed = await withIgneous(account);
            await persistAccount(completed, true);
            await probe();
            log("info", `登录完成：${completed.label}`);
            return status();
        },

        async logout() {
            const auth = ctx.auth.get();
            const account = activeAccount(auth);
            if (account === null) {
                return status();
            }
            // 只清 Cookie 与当前标记，保留账号条目便于再次登录
            const cleared: Account = {
                ...account,
                cookies: { ipbMemberId: "", ipbPassHash: "", igneous: "" },
                igneousUpdatedAt: null,
            };
            await ctx.auth.patch({
                accounts: upsertAccount(auth.accounts, cleared),
                activeAccountId: account.id === auth.activeAccountId ? null : auth.activeAccountId,
            });
            log("info", "已清除当前账号的登录态");
            return status();
        },

        async refreshIgneous() {
            const auth = ctx.auth.get();
            const account = activeAccount(auth);
            if (account === null) {
                throw new Error("尚未登录");
            }
            const refreshed: Account = { ...account, cookies: { ...account.cookies, igneous: "" } };
            const completed = await withIgneous(refreshed);
            if (!isIgneousValue(completed.cookies.igneous)) {
                throw new Error("未取到 igneous：当前出口节点可能被上游拒绝");
            }
            await persistAccount(completed, true);
            return status();
        },

        probeExAccess: probe,

        listAccounts() {
            const auth = ctx.auth.get();
            return auth.accounts.map((account) => summarize(auth, account));
        },

        async createAccount(input) {
            return await importAccount(input);
        },

        async updateAccount(id, patch) {
            const auth = ctx.auth.get();
            const existing = auth.accounts.find((item) => item.id === id);
            if (existing === undefined) {
                throw new Error(`账号不存在：${id}`);
            }
            const next: Account = {
                ...existing,
                ...(patch.label === undefined ? {} : { label: patch.label }),
                ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey }),
                ...(patch.cookies === undefined
                    ? {}
                    : {
                          cookies: { ...existing.cookies, ...cleanCookies(patch.cookies) },
                          igneousUpdatedAt:
                              patch.cookies.igneous === undefined || patch.cookies.igneous === ""
                                  ? existing.igneousUpdatedAt
                                  : Math.floor(Date.now() / 1000),
                      }),
            };
            await persistAccount(next, false);
            return summarize(ctx.auth.get(), next);
        },

        async removeAccount(id) {
            const auth = ctx.auth.get();
            const remaining = removeFromList(auth.accounts, id);
            if (remaining.length === auth.accounts.length) {
                return false;
            }
            await ctx.auth.patch({
                accounts: remaining,
                activeAccountId: auth.activeAccountId === id ? null : auth.activeAccountId,
            });
            log("info", `账号已删除：${id}`);
            return true;
        },

        async activateAccount(id) {
            const auth = ctx.auth.get();
            if (!auth.accounts.some((item) => item.id === id)) {
                throw new Error(`账号不存在：${id}`);
            }
            await ctx.auth.patch({ activeAccountId: id });
            log("info", `已切换账号：${id}`);
            return status();
        },

        startBrowserLogin(input) {
            const runner = options.browserLogin;
            if (runner === undefined) {
                throw new Error("浏览器登录不可用：服务端没有装配这一功能");
            }
            if (browserState.phase === "launching" || browserState.phase === "waiting") {
                throw new Error("已经有一个浏览器登录会话在进行中，先等它结束或取消它");
            }
            const available = runner.availability();
            if (!available.ok) {
                throw new Error(available.reason);
            }

            // 立刻返回：窗口开着的时候服务端只能等，把这个等待放进 HTTP 请求里不合适
            setBrowserState("launching", "正在打开浏览器窗口…");
            const controller = new AbortController();
            browserAbort = controller;
            void runBrowserLogin(runner, controller, input).catch((error: unknown) => {
                // runBrowserLogin 自己会把结果写进状态；这里只兜住意料之外的异常
                setBrowserState("failed", describeError(error));
                log("warn", `浏览器登录异常：${describeError(error)}`);
            });
            return status();
        },

        cancelBrowserLogin() {
            if (browserAbort === null) {
                return status();
            }
            browserAbort.abort();
            setBrowserState("cancelled", "已取消浏览器登录");
            return status();
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

function summarize(auth: AuthSetting, account: Account): AccountSummary {
    return {
        id: account.id,
        label: account.label,
        site: account.site,
        active: activeAccount(auth)?.id === account.id,
        igneousUpdatedAt: account.igneousUpdatedAt,
        hasApiKey: account.apiKey !== undefined,
    };
}

/** 只接受非空字段，避免把 undefined 覆盖进已有凭据 */
function cleanCookies(cookies: Partial<Account["cookies"]>): Partial<Account["cookies"]> {
    const out: {
        ipbMemberId?: string;
        ipbPassHash?: string;
        igneous?: string;
        ipbSessionId?: string;
    } = {};
    if (cookies.ipbMemberId !== undefined) {
        out.ipbMemberId = cookies.ipbMemberId;
    }
    if (cookies.ipbPassHash !== undefined) {
        out.ipbPassHash = cookies.ipbPassHash;
    }
    if (cookies.igneous !== undefined) {
        out.igneous = cookies.igneous;
    }
    if (cookies.ipbSessionId !== undefined) {
        out.ipbSessionId = cookies.ipbSessionId;
    }
    return out;
}
