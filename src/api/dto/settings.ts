/**
 * 配置的线上结构
 * 与 src/config/schema.ts 的内部类型刻意分离：内部重构不影响对外契约，代理凭据等不回传
 */

import type { DeepPartial, EhSite } from "./common.ts";

/** 取值来源；default < file < env < cli，与解析优先级一致 */
export type SettingOrigin = "default" | "file" | "env" | "cli";

/** 取值与其来源 */
export interface Effective<T> {
    readonly value: T;
    readonly origin: SettingOrigin;
}

export interface ProxySetting {
    readonly enabled: boolean;
    readonly protocol: "http" | "socks5";
    readonly host: string;
    readonly port: number;
    /** 是否配置认证；凭据不回传 */
    readonly hasCredentials: boolean;
}

export interface NetworkSetting {
    /** 序列请求间隔；上游建议连续 4～5 次后等待约 5 秒 */
    readonly requestIntervalMs: number;
    readonly maxSequentialRequests: number;
    readonly requestTimeoutMs: number;
    readonly proxy: ProxySetting;
}

export interface ViewerSetting {
    /** mpv 连播 / single 单页翻页 */
    readonly mode: "mpv" | "single";
    readonly imageQuality: "org" | "res";
    /** 预加载页数 */
    readonly preloadCount: number;
}

export interface DownloadSetting {
    readonly directory: string;
    readonly keepArchive: boolean;
    readonly preferredResolution: string;
    /** 服务端按安全范围下调 */
    readonly concurrency: number;
}

export interface UiSetting {
    readonly theme: "system" | "light" | "dark";
    readonly thumbnailSize: number;
    /** 每页条目数 */
    readonly pageSize: number;
}

/** 完整配置；浏览器可见部分 */
export interface UserSetting {
    readonly schemaVersion: number;
    readonly locale: string;
    readonly preferredSite: EhSite;
    readonly network: NetworkSetting;
    readonly viewer: ViewerSetting;
    readonly download: DownloadSetting;
    readonly ui: UiSetting;
}

/** 仅包含需修改的字段，由服务端深合并 */
export type UserSettingPatch = DeepPartial<UserSetting>;

/** 生效值与各字段来源；origins 以点分路径为键 */
export interface ConfigSnapshot {
    readonly setting: UserSetting;
    readonly origins: Readonly<Record<string, SettingOrigin>>;
}

/** 数据目录，用于诊断；对应 platform/paths.ts 的 describePaths */
export interface PathsInfo {
    readonly configDir: string;
    readonly dataDir: string;
    readonly cacheDir: string;
    /** 取值来源：override / env / portable-home / os-default */
    readonly sources: Readonly<Record<"configDir" | "dataDir" | "cacheDir", string>>;
}

/** true 时导出包包含账号凭据，界面需二次确认 */
export interface ExportConfigInput {
    readonly includeSecrets: boolean;
}

export interface ExportConfigResult {
    readonly fileName: string;
    readonly bytes: number;
    readonly includesSecrets: boolean;
}

export interface ImportConfigInput {
    /** 由浏览器读取文件后回传 */
    readonly content: string;
    /** 是否覆盖现有账号凭据 */
    readonly overwriteSecrets: boolean;
}

export interface ImportConfigResult {
    readonly schemaVersion: number;
    readonly migratedFrom: number | null;
    readonly accountsImported: number;
    /** 覆盖前的备份文件名 */
    readonly backupFile: string | null;
}
