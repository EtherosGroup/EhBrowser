/*
 * 标签翻译词库。
 * 数据来自上游项目 EhTagTranslation/Database：该项目每周把整份标签翻译（含简介）打成发布包，
 * 这里按需下载其中最小的一份 db.text.json.gz，剥掉简介只留「原文 -> 中文名」，再存到缓存目录。
 * 数据本体是 CC BY-NC-SA 3.0，不随程序分发，装不装、什么时候删都由用户决定。
 * 没装词库时界面回落到内置的常用翻译表，功能不受影响。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { fetch as undiciFetch } from "undici";

import type { TranslateDatabase, TranslateStatus } from "../api/index.ts";
import { getDispatcher } from "../eh/index.ts";
import { describeError } from "../platform/errors.ts";

/** 发布包的固定地址。GitHub 的 latest 会 302 到当前版本的具体资源。 */
const SOURCE_URL =
    "https://github.com/EhTagTranslation/Database/releases/latest/download/db.text.json.gz";
/** 界面上标注的出处 */
const SOURCE_LABEL = "EhTagTranslation/Database";
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 上游发布包的结构，只取用得到的部分。 */
interface UpstreamNamespace {
    readonly namespace?: unknown;
    readonly frontMatters?: { readonly name?: unknown };
    readonly data?: Readonly<Record<string, { readonly name?: unknown }>>;
}

interface UpstreamDocument {
    readonly version?: unknown;
    readonly data?: readonly UpstreamNamespace[];
}

interface StoredDatabase {
    readonly version: string;
    readonly updatedAt: number;
    readonly source: string;
    readonly namespaces: Record<string, { label: string; tags: Record<string, string> }>;
}

export interface TranslateService {
    status(): Promise<TranslateStatus>;
    /** 整份词库。没装时为 null */
    database(): Promise<TranslateDatabase | null>;
    update(): Promise<TranslateStatus>;
    remove(): Promise<TranslateStatus>;
}

export interface TranslateServiceOptions {
    readonly cacheDir: string;
    readonly logger?: (level: "info" | "warn", message: string) => void;
}

function tagsFile(cacheDir: string): string {
    return join(cacheDir, "translate", "tags.json");
}

/** 剥掉简介，只留命名空间名与标签名。 */
function parseDatabase(text: string): {
    version: string;
    namespaces: StoredDatabase["namespaces"];
} {
    const document = JSON.parse(text) as UpstreamDocument;
    const namespaces: StoredDatabase["namespaces"] = {};
    for (const item of document.data ?? []) {
        const name = typeof item.namespace === "string" ? item.namespace : "";
        if (name === "") {
            continue;
        }
        const label = typeof item.frontMatters?.name === "string" ? item.frontMatters.name : name;
        const tags: Record<string, string> = {};
        for (const [raw, entry] of Object.entries(item.data ?? {})) {
            if (typeof entry.name === "string" && entry.name !== "") {
                tags[raw.toLowerCase()] = entry.name;
            }
        }
        namespaces[name] = { label, tags };
    }
    return {
        version: versionOf(document.version),
        namespaces,
    };
}

/** 发布包自报的版本号，未必是字符串（可能是数字）。认不出来就给「未知」。 */
function versionOf(raw: unknown): string {
    if (typeof raw === "string" && raw !== "") {
        return raw;
    }
    return typeof raw === "number" ? String(raw) : "未知";
}

/** 发布包的版本号：跟随重定向后的地址里带着 tag，如 .../download/v7.28221.1/db.text.json.gz */
function versionFromUrl(url: string): string | null {
    const matched = /\/download\/v?([^/]+)\//.exec(url);
    return matched?.[1] ?? null;
}

function countTags(namespaces: StoredDatabase["namespaces"]): number {
    let total = 0;
    for (const item of Object.values(namespaces)) {
        total += Object.keys(item.tags).length;
    }
    return total;
}

/** 下载发布包：整份文件与跳转后的地址（地址里带发布号）。 */
async function downloadPackage(): Promise<{ location: string | null; packed: Buffer }> {
    // 走用户配置的代理。GitHub 在国内大多要代理才连得上。
    const dispatcher = getDispatcher() ?? undefined;
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    // 先只看一跳：latest 会 302 到带版本号的地址，版本号就从那里取。
    const head = await undiciFetch(SOURCE_URL, { redirect: "manual", signal, dispatcher });
    const location = head.headers.get("location");
    await head.body?.cancel();
    if (head.status >= 400) {
        throw new Error(`下载失败：HTTP ${head.status}`);
    }
    const response = await undiciFetch(location ?? SOURCE_URL, {
        redirect: "follow",
        signal,
        dispatcher,
    });
    if (!response.ok) {
        throw new Error(`下载失败：HTTP ${response.status}`);
    }
    return { location, packed: Buffer.from(await response.arrayBuffer()) };
}

export function createTranslateService(options: TranslateServiceOptions): TranslateService {
    const log = options.logger ?? (() => undefined);
    const file = tagsFile(options.cacheDir);
    /** 落盘的那一份。首次读取后常驻内存，更新与删除时替换。 */
    let stored: StoredDatabase | null = null;
    let loaded = false;
    let updating = false;
    let error: string | null = null;

    /** 首次访问时从磁盘读一次。文件损坏按没装处理，不影响启动。 */
    async function ensureLoaded(): Promise<void> {
        if (loaded) {
            return;
        }
        loaded = true;
        try {
            const text = await readFile(file, "utf8");
            const parsed = JSON.parse(text) as StoredDatabase;
            if (typeof parsed.version === "string" && parsed.namespaces !== undefined) {
                stored = parsed;
            }
        } catch (caught) {
            const code = (caught as { code?: string }).code;
            if (code !== "ENOENT") {
                error = `词库读取失败：${describeError(caught)}`;
                log("warn", error);
            }
        }
    }

    /** 代理偶尔会在 TLS 握手阶段断开，重试一次。两次都失败才算失败。 */
    async function download(): Promise<{ location: string | null; packed: Buffer }> {
        let last: unknown = new Error("下载失败");
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                return await downloadPackage();
            } catch (caught) {
                last = caught;
                log("warn", `词库下载失败（第 ${attempt} 次）：${describeError(caught)}`);
            }
        }
        throw last instanceof Error ? last : new Error(String(last));
    }

    function status(): TranslateStatus {
        const namespaces = stored?.namespaces ?? {};
        return {
            installed: stored !== null,
            version: stored?.version ?? null,
            updatedAt: stored?.updatedAt ?? null,
            source: SOURCE_URL,
            tagCount: stored === null ? 0 : countTags(namespaces),
            namespaceCount: Object.keys(namespaces).length,
            updating,
            error,
        };
    }

    return {
        async status() {
            await ensureLoaded();
            return status();
        },

        async database() {
            await ensureLoaded();
            if (stored === null) {
                return null;
            }
            return {
                version: stored.version,
                updatedAt: stored.updatedAt,
                source: SOURCE_LABEL,
                namespaces: stored.namespaces,
            };
        },

        async update() {
            await ensureLoaded();
            if (updating) {
                return status();
            }
            updating = true;
            error = null;
            try {
                const { location, packed } = await download();
                const parsed = parseDatabase(gunzipSync(packed).toString("utf8"));
                const next: StoredDatabase = {
                    // 发布包里的 version 只是数据格式版本（数字），发布号在地址里。
                    version:
                        (location === null ? null : versionFromUrl(location)) ?? parsed.version,
                    updatedAt: Math.floor(Date.now() / 1000),
                    source: SOURCE_LABEL,
                    namespaces: parsed.namespaces,
                };
                await mkdir(join(options.cacheDir, "translate"), { recursive: true });
                // 先写临时文件再改名：中途失败不会留下半份词库。
                const temporary = `${file}.tmp`;
                await writeFile(temporary, JSON.stringify(next), "utf8");
                await rename(temporary, file);
                stored = next;
                loaded = true;
                log(
                    "info",
                    `词库已更新：${next.version}，${Object.keys(next.namespaces).length} 个命名空间、${countTags(next.namespaces)} 条标签`,
                );
            } catch (caught) {
                error = describeError(caught);
                log("warn", `词库更新失败：${error}`);
            } finally {
                updating = false;
            }
            return status();
        },

        async remove() {
            await ensureLoaded();
            try {
                await rm(file, { force: true });
            } catch (caught) {
                error = describeError(caught);
            }
            stored = null;
            loaded = true;
            error = null;
            return status();
        },
    };
}
