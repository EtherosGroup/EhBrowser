/*
 * 配置服务：配置层之上的语义与装配。
 * 负责内部配置与线上 DTO 的映射、跨字段校验、脱敏与变更广播，不处理 HTTP 细节。
 * 结构校验（类型、范围）由 config/validate.ts 负责，此层只管跨字段规则。
 */

import {
    ConfigInvalidError,
    activeAccount,
    igneousAgeDays,
    isIgneousStale,
    type AuthSetting,
    type ConfigContext,
    type JsonStore,
    type UserSetting as InternalUserSetting,
} from "../config/index.ts";
import type {
    AccountSummary,
    AuthStatus,
    ConfigSnapshot,
    FieldIssue,
    PathsInfo,
    SettingOrigin,
    UserSetting as WireUserSetting,
    UserSettingPatch,
} from "../api/index.ts";

export interface ConfigService {
    /** 生效配置与各字段来源 */
    snapshot(): ConfigSnapshot;
    /** 局部更新。校验失败时抛出 ConfigInvalidError。 */
    patchUserSetting(patch: UserSettingPatch): Promise<ConfigSnapshot>;
    /** 数据目录与来源，用于诊断。 */
    pathsInfo(): PathsInfo;
    /** 登录状态摘要，不含凭据。 */
    authStatus(): AuthStatus;
    /** 订阅配置变更，返回退订函数。 */
    onChange(listener: (snapshot: ConfigSnapshot) => void): () => void;
}

/** 线上 DTO 中不落到配置文件里的字段：由服务层计算，patch 时忽略。 */
const WIRE_ONLY_PATHS: readonly string[] = ["schemaVersion", "network.proxy.hasCredentials"];

export function createConfigService(ctx: ConfigContext): ConfigService {
    const listeners = new Set<(snapshot: ConfigSnapshot) => void>();

    function snapshot(): ConfigSnapshot {
        return {
            setting: toWireSetting(ctx.user.get(), ctx.auth.get()),
            origins: collectOrigins(ctx.user),
        };
    }

    ctx.user.onChange(() => {
        const next = snapshot();
        for (const listener of listeners) {
            try {
                listener(next);
            } catch {
                // 单个订阅者异常不影响其余订阅者。
            }
        }
    });

    return {
        snapshot,

        async patchUserSetting(patch) {
            const internal = toInternalPatch(patch);
            if (Object.keys(internal).length > 0) {
                const issues = validateSemantics(mergeSettings(ctx.user.get(), internal));
                if (issues.length > 0) {
                    throw new ConfigInvalidError(issues);
                }
                await ctx.user.patch(
                    internal as Parameters<JsonStore<InternalUserSetting>["patch"]>[0],
                );
            }
            return snapshot();
        },

        pathsInfo() {
            return {
                configDir: ctx.paths.configDir,
                dataDir: ctx.paths.dataDir,
                cacheDir: ctx.paths.cacheDir,
                sources: {
                    configDir: ctx.paths.sources.configDir,
                    dataDir: ctx.paths.sources.dataDir,
                    cacheDir: ctx.paths.sources.cacheDir,
                },
            };
        },

        authStatus() {
            const auth = ctx.auth.get();
            const account = activeAccount(auth);
            const activeAccountSummary: AccountSummary | null =
                account === null
                    ? null
                    : {
                          id: account.id,
                          label: account.label,
                          site: account.site,
                          active: true,
                          igneousUpdatedAt: account.igneousUpdatedAt,
                          hasApiKey: account.apiKey !== undefined,
                      };
            return {
                loggedIn: account !== null,
                activeAccount: activeAccountSummary,
                accountCount: auth.accounts.length,
                igneousAgeDays: igneousAgeDays(account),
                igneousStale: isIgneousStale(account),
                // 里站可达性尚未探测，接入上游请求后填充。
                exAccessible: null,
            };
        },

        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** 内部配置 -> 线上 DTO。hasCredentials 由 auth 层提供，代理凭据本身不回传。 */
function toWireSetting(setting: InternalUserSetting, auth: AuthSetting): WireUserSetting {
    return {
        schemaVersion: setting.schemaVersion,
        locale: setting.locale,
        preferredSite: setting.preferredSite,
        network: {
            requestIntervalMs: setting.network.requestIntervalMs,
            maxSequentialRequests: setting.network.maxSequentialRequests,
            requestTimeoutMs: setting.network.requestTimeoutMs,
            proxy: {
                enabled: setting.network.proxy.enabled,
                protocol: setting.network.proxy.protocol,
                host: setting.network.proxy.host,
                port: setting.network.proxy.port,
                hasCredentials: auth.proxyAuth.username !== "",
            },
            direct: {
                enabled: setting.network.direct.enabled,
                builtIn: setting.network.direct.builtIn,
                doh: setting.network.direct.doh,
                hosts: setting.network.direct.hosts,
            },
        },
        viewer: {
            mode: setting.viewer.mode,
            imageQuality: setting.viewer.imageQuality,
            preloadCount: setting.viewer.preloadCount,
            maxCacheMb: setting.viewer.maxCacheMb,
            maxConcurrentLoads: setting.viewer.maxConcurrentLoads,
            autoplay: {
                enabled: setting.viewer.autoplay.enabled,
                intervalSeconds: setting.viewer.autoplay.intervalSeconds,
                loop: setting.viewer.autoplay.loop,
            },
        },
        translate: {
            tags: setting.translate.tags,
        },
        safety: {
            hintEnabled: setting.safety.hintEnabled,
            url: setting.safety.url,
        },
        download: {
            directory: setting.download.directory,
            keepArchive: setting.download.keepArchive,
            preferredResolution: setting.download.preferredResolution,
            concurrency: setting.download.concurrency,
        },
        log: {
            enabled: setting.log.enabled,
            directory: setting.log.directory,
        },
        search: {
            auto: setting.search.auto,
            hintEnabled: setting.search.hintEnabled,
        },
        ui: {
            theme: setting.ui.theme,
            thumbnailSize: setting.ui.thumbnailSize,
            pageSize: setting.ui.pageSize,
            cachedGalleries: setting.ui.cachedGalleries,
        },
    };
}

/** 线上 patch -> 内部 patch：剔除只读字段，其余原样深拷贝。 */
function toInternalPatch(patch: UserSettingPatch): Record<string, unknown> {
    const copy = structuredClone(patch) as Record<string, unknown>;
    for (const path of WIRE_ONLY_PATHS) {
        removePath(copy, path);
    }
    return copy;
}

function removePath(target: Record<string, unknown>, path: string): void {
    const keys = path.split(".");
    const last = keys.pop();
    if (last === undefined) {
        return;
    }
    let current: unknown = target;
    for (const key of keys) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return;
        }
        current = (current as Record<string, unknown>)[key];
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
        delete (current as Record<string, unknown>)[last];
    }
}

/** 出现在文件里的字段记为 file，其余记为 default。env / cli 只影响目录，不参与此处。 */
function collectOrigins(store: JsonStore<InternalUserSetting>): Record<string, SettingOrigin> {
    const origins: Record<string, SettingOrigin> = {};
    walkOrigins(store.raw(), "", origins);
    return origins;
}

/** 递归遍历嵌套对象，每层都记一条，前端按点分路径取用。 */
function walkOrigins(node: unknown, prefix: string, out: Record<string, SettingOrigin>): void {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
        return;
    }
    for (const [key, value] of Object.entries(node)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        out[path] = "file";
        walkOrigins(value, path, out);
    }
}

/** 在现有配置上叠加 patch，仅用于校验，不写盘 */
function mergeSettings(
    base: InternalUserSetting,
    patch: Record<string, unknown>,
): InternalUserSetting {
    const merged = structuredClone(base) as unknown as Record<string, unknown>;
    mergeInto(merged, patch);
    return merged as unknown as InternalUserSetting;
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            target[key] = value;
            continue;
        }
        const current = target[key];
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            target[key] = structuredClone(value);
            continue;
        }
        mergeInto(current as Record<string, unknown>, value as Record<string, unknown>);
    }
}

/** 跨字段规则。 */
function validateSemantics(setting: InternalUserSetting): FieldIssue[] {
    const issues: FieldIssue[] = [];

    const directory = setting.download.directory;
    if (directory !== "" && !isAbsolutePath(directory)) {
        issues.push({
            path: "download.directory",
            code: "conflict",
            message: "需为绝对路径，或留空",
        });
    }

    if (setting.network.proxy.enabled && setting.network.proxy.host.trim() === "") {
        issues.push({ path: "network.proxy.host", code: "missing", message: "启用代理时不能为空" });
    }

    if (setting.viewer.preloadCount > setting.ui.pageSize) {
        issues.push({
            path: "viewer.preloadCount",
            code: "conflict",
            message: "不应超过每页条目数",
        });
    }

    return issues;
}

/** POSIX 以 / 开头，Windows 为盘符:\ 或 UNC */
function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
