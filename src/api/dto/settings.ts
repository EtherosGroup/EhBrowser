/*
 * 配置的线上结构。
 * 与 src/config/schema.ts 的内部类型保持分离：内部重构不影响对外契约，代理凭据等字段不回传。
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

/** 直连解析：只换 DNS，用于绕开本地 DNS 污染 */
export interface DirectSetting {
    readonly enabled: boolean;
    /** 用内置种子表 */
    readonly builtIn: boolean;
    /** 允许 DoH 解析与刷新 */
    readonly doh: boolean;
    /** 自定义 hosts 文本，每行 `域名 = ip1, ip2` */
    readonly hosts: string;
}

export interface NetworkSetting {
    /** 序列请求间隔；上游建议连续 4～5 次后等待约 5 秒 */
    readonly requestIntervalMs: number;
    readonly maxSequentialRequests: number;
    readonly requestTimeoutMs: number;
    readonly proxy: ProxySetting;
    readonly direct: DirectSetting;
}

export interface ViewerSetting {
    /** mpv 连播 / single 单页翻页 */
    readonly mode: "mpv" | "single";
    readonly imageQuality: "org" | "res";
    /** 向后预加载几张 */
    readonly preloadCount: number;
    /** 图片缓存上限，单位 MB */
    readonly maxCacheMb: number;
    /** 同时最多加载几张 */
    readonly maxConcurrentLoads: number;
    readonly autoplay: AutoplaySetting;
}

export interface AutoplaySetting {
    readonly enabled: boolean;
    /** 自动播放间隔，单位秒 */
    readonly intervalSeconds: number;
    readonly loop: boolean;
}

export interface TranslateSetting {
    /** 标签与类别的中文翻译 */
    readonly tags: boolean;
}

export interface SafetySetting {
    /** 进入页面时是否提示紧急避险 */
    readonly hintEnabled: boolean;
    /** 避险地点：网页地址或本地 file:// 地址 */
    readonly url: string;
}

export interface DownloadSetting {
    readonly directory: string;
    readonly keepArchive: boolean;
    readonly preferredResolution: string;
    /** 服务端按安全范围下调 */
    readonly concurrency: number;
}

export interface LogSetting {
    /** 是否把日志写入文件 */
    readonly enabled: boolean;
    /** 日志目录；空表示用默认目录（~/ehbrowser/logs） */
    readonly directory: string;
}

export interface SearchSetting {
    /** 打开界面时是否自动检索画廊（启动预热 + 打开搜索页铺默认结果） */
    readonly auto: boolean;
    /** 进入页面时是否提示可以开自动搜索 */
    readonly hintEnabled: boolean;
}

export interface UiSetting {
    readonly theme: "system" | "light" | "dark";
    readonly thumbnailSize: number;
    /** 每页条目数 */
    readonly pageSize: number;
    /** 详情页缓存的画廊个数，0 表示不缓存 */
    readonly cachedGalleries: number;
}

/** 完整配置；浏览器可见部分 */
export interface UserSetting {
    readonly schemaVersion: number;
    readonly locale: string;
    readonly preferredSite: EhSite;
    readonly network: NetworkSetting;
    readonly viewer: ViewerSetting;
    readonly translate: TranslateSetting;
    readonly safety: SafetySetting;
    readonly download: DownloadSetting;
    readonly log: LogSetting;
    readonly ui: UiSetting;
    readonly search: SearchSetting;
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
