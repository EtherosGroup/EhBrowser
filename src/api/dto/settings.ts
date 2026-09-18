// 线上配置结构
// 跟 src/config/schema.ts 那份内部类型故意分开：内部怎么重构不该动到对外契约，
// 代理密码这类东西也永远不回传

import type { DeepPartial, EhSite } from "./common.ts";

/** 这个值是谁定的。default < file < env < cli，跟解析优先级一致 */
export type SettingOrigin = "default" | "file" | "env" | "cli";

/** 值 + 来源 */
export interface Effective<T> {
    readonly value: T;
    readonly origin: SettingOrigin;
}

export interface ProxySetting {
    readonly enabled: boolean;
    readonly protocol: "http" | "socks5";
    readonly host: string;
    readonly port: number;
    /** 配了认证没有。用户名密码不出服务端 */
    readonly hasCredentials: boolean;
}

export interface NetworkSetting {
    /** 序列请求之间的间隔。上游说连发 4～5 次就得歇 5 秒左右 */
    readonly requestIntervalMs: number;
    readonly maxSequentialRequests: number;
    readonly requestTimeoutMs: number;
    readonly proxy: ProxySetting;
}

export interface ViewerSetting {
    /** mpv 连播 / single 单页翻 */
    readonly mode: "mpv" | "single";
    readonly imageQuality: "org" | "res";
    /** 提前抓几页 */
    readonly preloadCount: number;
}

export interface DownloadSetting {
    readonly directory: string;
    readonly keepArchive: boolean;
    readonly preferredResolution: string;
    /** 服务端会往下削，别指望填多少就是多少 */
    readonly concurrency: number;
}

export interface UiSetting {
    readonly theme: "system" | "light" | "dark";
    readonly thumbnailSize: number;
    /** 一页几条 */
    readonly pageSize: number;
}

/** 完整配置。浏览器能看见的就这些 */
export interface UserSetting {
    readonly schemaVersion: number;
    readonly locale: string;
    readonly preferredSite: EhSite;
    readonly network: NetworkSetting;
    readonly viewer: ViewerSetting;
    readonly download: DownloadSetting;
    readonly ui: UiSetting;
}

/** 只带要改的，服务端负责深合并 */
export type UserSettingPatch = DeepPartial<UserSetting>;

/** 生效值 + 每个字段的来源。origins 用点分路径当 key，界面直接按字段读 */
export interface ConfigSnapshot {
    readonly setting: UserSetting;
    readonly origins: Readonly<Record<string, SettingOrigin>>;
}

/** 数据目录，排错用。就是 platform/paths.ts 里那个 describePaths */
export interface PathsInfo {
    readonly configDir: string;
    readonly dataDir: string;
    readonly cacheDir: string;
    /** override / env / portable-home / os-default */
    readonly sources: Readonly<Record<"configDir" | "dataDir" | "cacheDir", string>>;
}

/** true 会把账号凭据也打进包里，界面上必须再问一次 */
export interface ExportConfigInput {
    readonly includeSecrets: boolean;
}

export interface ExportConfigResult {
    readonly fileName: string;
    readonly bytes: number;
    readonly includesSecrets: boolean;
}

export interface ImportConfigInput {
    /** 浏览器读完文件回传过来的 */
    readonly content: string;
    /** 覆盖不覆盖现有的账号 */
    readonly overwriteSecrets: boolean;
}

export interface ImportConfigResult {
    readonly schemaVersion: number;
    readonly migratedFrom: number | null;
    readonly accountsImported: number;
    /** 覆盖前备份到哪了 */
    readonly backupFile: string | null;
}
