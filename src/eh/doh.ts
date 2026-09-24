/*
 * DNS over HTTPS。用于绕开本地 DNS 污染：把解析问给一个**写死 IP** 的公共解析器，
 * 因此这一步本身不需要 DNS 能解析（否则会自己卡自己）。
 *
 * 两种协议都要支持，因为不同网络能连通的端点不一样（实测：国内直连时 Cloudflare/Google/Quad9
 * 全部不通，只有 Yandex 的 77.88.8.1 通，而它只吃 RFC 8484 的二进制报文，不吃 JSON 接口）：
 *   - wire：按 RFC 8484 组查询报文，POST application/dns-message
 *   - json：Cloudflare/Google/Quad9 那种 ?name=&type=A 的 JSON 接口
 *
 * 端点会按顺序试，谁先通就记住谁；都不通就返回 null，由上层落到系统解析。
 */

import { fetch as undiciFetch, type Dispatcher } from "undici";

/** 一条 A/AAAA 记录 */
export interface DohAnswer {
    readonly address: string;
    /** 响应里的 TTL（秒），拿不到时给一个保守值 */
    readonly ttl: number;
}

export interface DohEndpoint {
    readonly name: string;
    readonly url: string;
    readonly kind: "wire" | "json";
}

/**
 * 候选端点。顺序有讲究：把实测在国内直连可用的排前面，
 * 有代理时前面这些不通也没关系，后面的会兜住。
 */
export const DOH_ENDPOINTS: readonly DohEndpoint[] = [
    { name: "Yandex", url: "https://77.88.8.1/dns-query", kind: "wire" },
    { name: "Cloudflare", url: "https://1.1.1.1/dns-query", kind: "json" },
    { name: "Google", url: "https://8.8.8.8/resolve", kind: "json" },
    { name: "Quad9", url: "https://9.9.9.9:5053/dns-query", kind: "json" },
    { name: "AdGuard", url: "https://94.140.14.14/resolve", kind: "json" },
];

/*
 * 端点健康状态。实测：被连续探测时会重置连接（ECONNRESET / other side closed），
 * 所以失败要**退避**，不能每个域名都去撞一次不通的端点；成功则清空计数。
 * 这是模块级的，进程内共享。
 */
const FAILURES_BEFORE_COOLDOWN = 2;
const COOLDOWN_MS = 60_000;
const endpointFailures = new Map<string, number>();
const endpointCooldownUntil = new Map<string, number>();

function cooling(endpoint: DohEndpoint, now: number): boolean {
    return (endpointCooldownUntil.get(endpoint.url) ?? 0) > now;
}

function noteFailure(endpoint: DohEndpoint, now: number): void {
    const failures = (endpointFailures.get(endpoint.url) ?? 0) + 1;
    endpointFailures.set(endpoint.url, failures);
    if (failures >= FAILURES_BEFORE_COOLDOWN) {
        endpointCooldownUntil.set(endpoint.url, now + COOLDOWN_MS);
    }
}

function noteSuccess(endpoint: DohEndpoint): void {
    endpointFailures.delete(endpoint.url);
    endpointCooldownUntil.delete(endpoint.url);
}

/** 端点的健康快照，诊断页用 */
export function endpointHealth(): readonly {
    endpoint: DohEndpoint;
    failures: number;
    coolingForMs: number;
}[] {
    const now = Date.now();
    return DOH_ENDPOINTS.map((endpoint) => ({
        endpoint,
        failures: endpointFailures.get(endpoint.url) ?? 0,
        coolingForMs: Math.max(0, (endpointCooldownUntil.get(endpoint.url) ?? 0) - now),
    }));
}

export interface DohOptions {
    /** 配置了代理时传进来：DoH 也走代理（直连不通的网络里这是唯一能刷新解析的路子） */
    readonly dispatcher?: Dispatcher;
    readonly timeoutMs?: number;
    /** 允许的端点；默认全部。可用于只试某一个 */
    readonly endpoints?: readonly DohEndpoint[];
    /** 忽略冷却，逐个真打一遍（诊断「测连通」用） */
    readonly ignoreCooldown?: boolean;
}

export interface DohResult {
    readonly endpoint: DohEndpoint;
    readonly answers: readonly DohAnswer[];
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** 组装一个最小 DNS 查询报文（RFC 1035 §4） */
function buildQuery(hostname: string, type: 1 | 28): Uint8Array {
    const parts = hostname.split(".").filter((part) => part !== "");
    // 12 头 + 各段 `长度+内容` + 结尾的根标签 0 字节 + qtype/qclass 4 字节
    const size = 12 + parts.reduce((sum, part) => sum + part.length + 1, 0) + 1 + 4;
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);
    view.setUint16(0, Math.floor(Math.random() * 0xffff)); // id
    view.setUint16(2, 0x0100); // RD（希望递归解析）
    view.setUint16(4, 1); // qdcount
    let at = 12;
    for (const part of parts) {
        buffer[at] = part.length;
        at += 1;
        for (let i = 0; i < part.length; i += 1) {
            buffer[at + i] = part.charCodeAt(i);
        }
        at += part.length;
    }
    buffer[at] = 0;
    view.setUint16(at + 1, type);
    view.setUint16(at + 3, 1); // IN
    return buffer;
}

/** 解析响应报文里的 A/AAAA 记录。只处理指针压缩与常见记录类型，够用即可 */
function parseAnswers(buffer: Uint8Array): DohAnswer[] {
    if (buffer.length < 12) {
        return [];
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const questions = view.getUint16(4);
    const answers = view.getUint16(6);
    let at = 12;

    const skipName = (): void => {
        while (at < buffer.length) {
            const length = buffer[at] ?? 0;
            if (length === 0) {
                at += 1;
                return;
            }
            if ((length & 0xc0) === 0xc0) {
                at += 2; // 压缩指针
                return;
            }
            at += length + 1;
        }
    };

    for (let i = 0; i < questions; i += 1) {
        skipName();
        at += 4;
    }

    const out: DohAnswer[] = [];
    for (let i = 0; i < answers; i += 1) {
        skipName();
        if (at + 10 > buffer.length) {
            break;
        }
        const type = view.getUint16(at);
        const ttl = view.getUint32(at + 4);
        const length = view.getUint16(at + 8);
        at += 10;
        if (type === 1 && length === 4) {
            out.push({
                address: `${buffer[at]}.${buffer[at + 1]}.${buffer[at + 2]}.${buffer[at + 3]}`,
                ttl,
            });
        } else if (type === 28 && length === 16) {
            const groups: string[] = [];
            for (let g = 0; g < 16; g += 2) {
                groups.push(((buffer[at + g]! << 8) | buffer[at + g + 1]!).toString(16));
            }
            out.push({ address: groups.join(":"), ttl });
        }
        at += length;
    }
    return out;
}

/** 单个端点问一次。失败（连不上、超时、状态码不对）返回 null */
async function askEndpoint(
    endpoint: DohEndpoint,
    hostname: string,
    options: DohOptions,
    type: 1 | 28,
): Promise<DohAnswer[] | null> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        if (endpoint.kind === "wire") {
            const query = buildQuery(hostname, type);
            const response = await undiciFetch(endpoint.url, {
                method: "POST",
                headers: {
                    "content-type": "application/dns-message",
                    accept: "application/dns-message",
                },
                body: query,
                signal: timeout,
                ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
            });
            if (!response.ok) {
                return null;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            return parseAnswers(bytes);
        }

        const url = `${endpoint.url}?${new URLSearchParams({ name: hostname, type: type === 1 ? "A" : "AAAA" }).toString()}`;
        const response = await undiciFetch(url, {
            headers: { accept: "application/dns-json" },
            signal: timeout,
            ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as {
            Answer?: readonly { type?: number; data?: string; TTL?: number }[];
        };
        const wanted = type === 1 ? 1 : 28;
        const answers = (body.Answer ?? [])
            .filter((item) => item.type === wanted && typeof item.data === "string")
            .map((item) => ({ address: item.data!, ttl: item.TTL ?? 300 }));
        return answers.length === 0 ? null : answers;
    } catch {
        // 连不上、被墙、超时都走这里，交给下一个端点
        return null;
    }
}

/**
 * 用 DoH 解析一个域名。端点按顺序试，第一个给结果的胜出并由调用方记住。
 * 全部失败返回 null（上层落到系统解析）。
 */
export async function resolveViaDoh(
    hostname: string,
    options: DohOptions = {},
    prefer?: DohEndpoint,
): Promise<DohResult | null> {
    const endpoints = options.endpoints ?? DOH_ENDPOINTS;
    const ordered =
        prefer === undefined
            ? endpoints
            : [prefer, ...endpoints.filter((item) => item.url !== prefer.url)];

    const now = Date.now();
    let candidates =
        options.ignoreCooldown === true ? ordered : ordered.filter((item) => !cooling(item, now));
    // 全都在冷却里：说明整条路暂时都不通，那就照打一遍，别把自己饿死
    if (candidates.length === 0) {
        candidates = ordered;
    }

    for (const endpoint of candidates) {
        const answers = await askEndpoint(endpoint, hostname, options, 1);
        if (answers !== null && answers.length > 0) {
            noteSuccess(endpoint);
            return { endpoint, answers };
        }
        noteFailure(endpoint, Date.now());
    }
    return null;
}

/** 探测哪几个端点可用。诊断页与「测连通」用得上 */
export async function probeEndpoints(
    hostname: string,
    options: DohOptions = {},
): Promise<readonly { endpoint: DohEndpoint; ok: boolean; answers: readonly DohAnswer[] }[]> {
    const endpoints = options.endpoints ?? DOH_ENDPOINTS;
    const out: { endpoint: DohEndpoint; ok: boolean; answers: readonly DohAnswer[] }[] = [];
    for (const endpoint of endpoints) {
        // 探测就是要看真实情况，因此不受冷却影响
        const answers = await askEndpoint(
            endpoint,
            hostname,
            { ...options, ignoreCooldown: true },
            1,
        );
        if (answers !== null && answers.length > 0) {
            noteSuccess(endpoint);
        } else {
            noteFailure(endpoint, Date.now());
        }
        out.push({ endpoint, ok: answers !== null && answers.length > 0, answers: answers ?? [] });
    }
    return out;
}
