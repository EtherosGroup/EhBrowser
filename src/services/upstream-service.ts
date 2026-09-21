/*
 * 上游服务：把配置里的网络设置接到传输层，并用当前账号的 Cookie 组装调用参数
 * 代理（含认证）与请求间隔在配置变更时即时生效
 * SOCKS5 不受支持，配置为该协议时按直连处理并记录警告
 */

import { activeAccount, type ConfigContext } from "../config/index.ts";
import {
    clearProxyAgent,
    gdata,
    gtoken,
    setProxyAgent,
    setRequestInterval,
    showpage,
    type EhCallOptions,
    type GalleryApiInfo,
    type GalleryTokenPair,
    type GtokenEntry,
    type PageTokenQuery,
    type ShowpageInput,
    type ShowpageResult,
} from "../eh/index.ts";
import { describeError } from "../platform/errors.ts";
import type { ConfigService } from "./config-service.ts";

export interface UpstreamService {
    /** 按当前配置应用代理与请求间隔 */
    applyNetwork(): void;
    /** 当前账号的调用参数；未登录为 null */
    callOptions(): EhCallOptions | null;
    hasAccount(): boolean;
    /** 元数据查询。extra 用于附加超时或取消信号，站点与 Cookie 取自当前账号 */
    gdata(pairs: readonly GalleryTokenPair[], extra?: EhCallOptions): Promise<GalleryApiInfo[]>;
    gtoken(pages: readonly PageTokenQuery[]): Promise<GtokenEntry[]>;
    showpage(input: ShowpageInput): Promise<ShowpageResult>;
}

export interface UpstreamServiceOptions {
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

export function createUpstreamService(
    ctx: ConfigContext,
    service: ConfigService,
    options: UpstreamServiceOptions = {},
): UpstreamService {
    const log = options.logger ?? (() => undefined);

    function applyNetwork(): void {
        const { proxy, requestIntervalMs, maxSequentialRequests } =
            service.snapshot().setting.network;

        if (!proxy.enabled) {
            clearProxyAgent();
            log("info", "代理未启用，按直连处理");
        } else {
            const credentials = ctx.auth.get().proxyAuth;
            try {
                setProxyAgent(
                    `${proxy.protocol}://${proxy.host}:${proxy.port}`,
                    credentials.username === "" ? undefined : credentials.username,
                    credentials.password,
                );
                log("info", `代理已启用：${proxy.protocol}://${proxy.host}:${proxy.port}`);
            } catch (error) {
                clearProxyAgent();
                log("warn", `代理设置失败，按直连处理：${describeError(error)}`);
            }
        }

        setRequestInterval(requestIntervalMs, maxSequentialRequests);
    }

    function callOptions(): EhCallOptions | null {
        const account = activeAccount(ctx.auth.get());
        if (account === null) {
            return null;
        }
        const cookies: Record<string, string> = {
            ipb_member_id: account.cookies.ipbMemberId,
            ipb_pass_hash: account.cookies.ipbPassHash,
            igneous: account.cookies.igneous,
        };
        if (account.cookies.ipbSessionId !== undefined) {
            cookies["ipb_session_id"] = account.cookies.ipbSessionId;
        }
        return { site: account.site, cookies };
    }

    /** 未登录时不追加 Cookie，公开接口仍可用 */
    function withAuth(extra: EhCallOptions = {}): EhCallOptions {
        return { ...(callOptions() ?? {}), ...extra };
    }

    applyNetwork();
    service.onChange(() => {
        applyNetwork();
    });
    ctx.auth.onChange(() => {
        log("info", "账号变更，后续请求使用新凭据");
    });

    return {
        applyNetwork,
        callOptions,
        hasAccount: () => activeAccount(ctx.auth.get()) !== null,
        gdata: (pairs, extra) => gdata(pairs, withAuth(extra)),
        gtoken: (pages) => gtoken(pages, withAuth()),
        showpage: (input) => showpage(input, withAuth()),
    };
}
