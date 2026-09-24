/*
 * 直连解析（对应 EhViewer 的「内置 host」）。目标只有一个：**绕开本地 DNS 污染**。
 *
 * 它与代理是两条互不相干的路，注意别混：
 *   - 这里只改「域名解析成哪个 IP」，TLS 的 SNI 与 Host 仍是原域名（证书照常校验）。
 *     因此它能解决「DNS 被污染」，但**解决不了 SNI 阻断**（那种网络下 TCP 通、握手一露 SNI 就被 RST，
 *     唯一的出路仍然是代理）。诊断接口会把这两种情况分开报告，别让用户以为是程序坏了。
 *   - 配置了代理时不用它：DNS 由代理那头解析，套上反而多一层。
 *
 * 解析顺序照抄 EhViewer 的 `EhHosts.lookup`，四级：
 *   1. 用户自己填的 hosts（配置里那一段文本）
 *   2. 内置种子表（hosts.ts）
 *   3. DoH（doh.ts，端点写死 IP，因此这一步本身不需要 DNS）
 *   4. 系统解析（`node:dns`）
 * 结果带 TTL 缓存；失败时可以把某条记录作废，让下一次重来。
 */

import { lookup as systemLookup } from "node:dns/promises";
import { interceptors, type Dispatcher } from "undici";

import { resolveViaDoh, type DohEndpoint, type DohOptions } from "./doh.ts";
import { BUILT_IN_HOSTS } from "./hosts.ts";

/** 命中静态表时给的 TTL：静态表不会自己变，但也不想永远信它 */
const STATIC_TTL_MS = 10 * 60 * 1000;
/** DoH 结果的下限 TTL，避免上游给 0 之后每次都去问 */
const MIN_DOH_TTL_MS = 60 * 1000;
const MAX_DOH_TTL_MS = 60 * 60 * 1000;

/** 解析结果的来源，诊断时要能说清「这个 IP 是哪来的」 */
export type DnsSource = "user-hosts" | "built-in" | "doh" | "system";

export interface ResolvedHost {
    readonly source: DnsSource;
    readonly addresses: readonly string[];
}

export interface DirectResolverOptions {
    /** 用户自定义 hosts：域名 -> IP 列表 */
    readonly userHosts?: Readonly<Record<string, readonly string[]>>;
    /** 是否启用内置种子表 */
    readonly builtIn?: boolean;
    /** 是否允许用 DoH 解析并刷新 */
    readonly doh?: boolean;
    /** DoH 请求要走的 dispatcher（配置了代理时传进来） */
    readonly dispatcher?: Dispatcher;
    readonly logger?: (level: "info" | "warn", message: string) => void;
    /** 注入用：便于验证时替换掉真实 DoH */
    readonly dohResolve?: typeof resolveViaDoh;
}

export interface DirectResolver {
    /** 给 undici 用的 DNS interceptor */
    interceptor(): Dispatcher.DispatcherComposeInterceptor;
    /** 解析一个域名，并说明来源（诊断用；会真的走 DoH 与系统解析） */
    resolve(hostname: string): Promise<ResolvedHost>;
    /** 作废某个域名的缓存，下一次重新走一遍 */
    invalidate(hostname: string): void;
    /** 已缓存的条目（诊断用） */
    cached(): readonly { hostname: string; source: DnsSource; addresses: readonly string[]; expiresInMs: number }[];
}

interface CacheEntry {
    readonly source: DnsSource;
    readonly addresses: readonly string[];
    /** 到点就重新走一遍流程 */
    readonly expiresAt: number;
}

/** 把一段文本解析成 hosts：每行 `域名 = ip1, ip2`，`#` 开头忽略 */
export function parseHostsText(text: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const at = line.indexOf("=");
        if (at === -1) {
            continue;
        }
        const host = line.slice(0, at).trim().toLowerCase();
        const addresses = line
            .slice(at + 1)
            .split(/[,\s]+/)
            .map((item) => item.trim())
            .filter((item) => item !== "");
        if (host !== "" && addresses.length > 0) {
            out[host] = addresses;
        }
    }
    return out;
}

function familyOf(address: string): 4 | 6 {
    return address.includes(":") ? 6 : 4;
}

export function createDirectResolver(options: DirectResolverOptions = {}): DirectResolver {
    const log = options.logger ?? ((): void => undefined);
    const dohResolve = options.dohResolve ?? resolveViaDoh;
    const userHosts = options.userHosts ?? {};
    const builtIn = options.builtIn ?? true;
    const doh = options.doh ?? true;
    const cache = new Map<string, CacheEntry>();
    /** 上一次 DoH 用通的端点，下次先试它 */
    let preferredEndpoint: DohEndpoint | undefined;

    function remember(hostname: string, entry: CacheEntry): void {
        cache.set(hostname, entry);
    }

    /** 四级级联。前三级都是「能立刻答就立刻答」，只有 DoH 与系统解析要等 */
    async function lookupCascade(hostname: string): Promise<ResolvedHost> {
        const host = hostname.toLowerCase();

        const fromUser = userHosts[host];
        if (fromUser !== undefined && fromUser.length > 0) {
            return { source: "user-hosts", addresses: fromUser };
        }

        if (builtIn) {
            const fromBuiltIn = BUILT_IN_HOSTS[host];
            if (fromBuiltIn !== undefined && fromBuiltIn.length > 0) {
                return { source: "built-in", addresses: fromBuiltIn };
            }
        }

        if (doh) {
            const dohOptions: DohOptions = {
                ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
            };
            const result = await dohResolve(host, dohOptions, preferredEndpoint);
            if (result !== null && result.answers.length > 0) {
                preferredEndpoint = result.endpoint;
                return { source: "doh", addresses: result.answers.map((answer) => answer.address) };
            }
        }

        const system = await systemLookup(host, { all: true, order: "ipv4first" });
        return { source: "system", addresses: system.map((item) => item.address) };
    }

    /** 带缓存的一层，interceptor 与诊断都走它 */
    async function resolve(hostname: string): Promise<ResolvedHost> {
        const host = hostname.toLowerCase();
        const cached = cache.get(host);
        if (cached !== undefined && cached.expiresAt > Date.now()) {
            return { source: cached.source, addresses: cached.addresses };
        }
        const resolved = await lookupCascade(host);
        const ttl =
            resolved.source === "doh"
                ? MIN_DOH_TTL_MS
                : resolved.source === "system"
                  ? MIN_DOH_TTL_MS
                  : STATIC_TTL_MS;
        remember(host, {
            source: resolved.source,
            addresses: resolved.addresses,
            expiresAt: Date.now() + ttl,
        });
        return resolved;
    }

    return {
        resolve,

        invalidate(hostname) {
            cache.delete(hostname.toLowerCase());
        },

        cached() {
            const now = Date.now();
            return [...cache.entries()].map(([hostname, entry]) => ({
                hostname,
                source: entry.source,
                addresses: entry.addresses,
                expiresInMs: Math.max(0, entry.expiresAt - now),
            }));
        },

        interceptor() {
            return interceptors.dns({
                /*
                 * undici 的 DNS interceptor 有一个坑：lookup 返回空数组**不会**回退到系统解析，
                 * 而是直接判成 No DNS entries found。所以「系统解析兜底」这一级必须自己写在里面
                 * （上面的 lookupCascade 已经这么做了，这里返回的永远非空或抛错）。
                 */
                lookup(origin, _lookupOptions, callback) {
                    void resolve(origin.hostname)
                        .then((resolved) => {
                            const records = resolved.addresses.map((address) => ({
                                address,
                                ttl: Math.max(30, Math.round(
                                    ((cache.get(origin.hostname.toLowerCase())?.expiresAt ?? 0) - Date.now()) / 1000,
                                )),
                                family: familyOf(address),
                            }));
                            if (records.length === 0) {
                                callback(new Error(`没有可用的解析结果：${origin.hostname}`), []);
                                return;
                            }
                            callback(null, records);
                        })
                        .catch((error: unknown) => {
                            log(
                                "warn",
                                `解析失败：${origin.hostname}（${error instanceof Error ? error.message : String(error)}）`,
                            );
                            callback(error instanceof Error ? error : new Error(String(error)), []);
                        });
                },
                // 命中失败时由上层 invalidate 后重试，这里不做长时间缓存
                maxTTL: MAX_DOH_TTL_MS / 1000,
                maxItems: 512,
            });
        },
    };
}
