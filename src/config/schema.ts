/**
 * 类型、默认值与字段表的唯一定义处
 * 字段变更涉及三处：本文件的类型/默认值/字段表、版本号、migrations.ts 中的迁移步骤
 */

import type { FieldSpec } from "./validate.ts";

export const USER_SETTING_VERSION = 1;

export interface ProxyConfig {
    readonly enabled: boolean;
    readonly protocol: "http" | "socks5";
    readonly host: string;
    readonly port: number;
    // 代理认证信息不在本文件，位于 auth_setting；settings 可对外展示
}

export interface NetworkConfig {
    /** 上游限流建议：连续 4～5 次后等待约 5 秒 */
    readonly requestIntervalMs: number;
    readonly maxSequentialRequests: number;
    readonly requestTimeoutMs: number;
    readonly proxy: ProxyConfig;
}

export interface ViewerConfig {
    readonly mode: "mpv" | "single";
    readonly imageQuality: "org" | "res";
    readonly preloadCount: number;
}

export interface DownloadConfig {
    readonly directory: string;
    readonly keepArchive: boolean;
    readonly preferredResolution: string;
    readonly concurrency: number;
}

export interface UiConfig {
    readonly theme: "system" | "light" | "dark";
    readonly thumbnailSize: number;
    readonly pageSize: number;
}

export interface UserSetting {
    readonly schemaVersion: number;
    readonly locale: string;
    readonly preferredSite: "e-hentai" | "exhentai";
    readonly network: NetworkConfig;
    readonly viewer: ViewerConfig;
    readonly download: DownloadConfig;
    readonly ui: UiConfig;
}

export const USER_SETTING_DEFAULTS: UserSetting = {
    schemaVersion: USER_SETTING_VERSION,
    locale: "zh-CN",
    preferredSite: "e-hentai",
    network: {
        requestIntervalMs: 5000,
        maxSequentialRequests: 5,
        requestTimeoutMs: 30000,
        proxy: {
            enabled: false,
            protocol: "http",
            host: "127.0.0.1",
            port: 7897,
        },
    },
    viewer: {
        mode: "mpv",
        imageQuality: "org",
        preloadCount: 2,
    },
    download: {
        directory: "",
        keepArchive: true,
        preferredResolution: "org",
        concurrency: 2,
    },
    ui: {
        theme: "system",
        thumbnailSize: 250,
        pageSize: 25,
    },
};

export const USER_SETTING_FIELDS: readonly FieldSpec[] = [
    { path: "schemaVersion", kind: "int", min: 1 },
    { path: "locale", kind: "string", minLength: 2, maxLength: 20 },
    { path: "preferredSite", kind: "enum", values: ["e-hentai", "exhentai"] },
    { path: "network.requestIntervalMs", kind: "int", min: 1000, max: 60000 },
    { path: "network.maxSequentialRequests", kind: "int", min: 1, max: 25 },
    { path: "network.requestTimeoutMs", kind: "int", min: 1000, max: 300000 },
    { path: "network.proxy.enabled", kind: "boolean" },
    { path: "network.proxy.protocol", kind: "enum", values: ["http", "socks5"] },
    { path: "network.proxy.host", kind: "string", minLength: 1, maxLength: 255 },
    { path: "network.proxy.port", kind: "int", min: 1, max: 65535 },
    { path: "viewer.mode", kind: "enum", values: ["mpv", "single"] },
    { path: "viewer.imageQuality", kind: "enum", values: ["org", "res"] },
    { path: "viewer.preloadCount", kind: "int", min: 0, max: 10 },
    // 空字符串有效，表示尚未设置
    { path: "download.directory", kind: "string", maxLength: 4096 },
    { path: "download.keepArchive", kind: "boolean" },
    { path: "download.preferredResolution", kind: "string", minLength: 1, maxLength: 16 },
    { path: "download.concurrency", kind: "int", min: 1, max: 8 },
    { path: "ui.theme", kind: "enum", values: ["system", "light", "dark"] },
    { path: "ui.thumbnailSize", kind: "int", min: 100, max: 1000 },
    { path: "ui.pageSize", kind: "int", min: 5, max: 100 },
];

export const AUTH_SETTING_VERSION = 1;

/** 字段名与上游保持一致 */
export interface EhCookies {
    readonly ipbMemberId: string;
    readonly ipbPassHash: string;
    /** 里站通行证，有效期约一个月；为空通常表示出口节点不适用 */
    readonly igneous: string;
    readonly ipbSessionId?: string;
}

export interface EhApiKey {
    readonly apiUid: string;
    readonly apiKey: string;
}

export interface Account {
    readonly id: string;
    readonly label: string;
    readonly site: "e-hentai" | "exhentai";
    readonly cookies: EhCookies;
    /** 获取 igneous 的时间戳（unix 秒），用于计算是否临近过期 */
    readonly igneousUpdatedAt: number | null;
    readonly apiKey?: EhApiKey;
}

export interface AuthSetting {
    readonly schemaVersion: number;
    readonly activeAccountId: string | null;
    readonly accounts: readonly Account[];
    /** 代理认证信息，属密钥，不放入 settings */
    readonly proxyAuth: {
        readonly username: string;
        readonly password: string;
    };
}

export const AUTH_SETTING_DEFAULTS: AuthSetting = {
    schemaVersion: AUTH_SETTING_VERSION,
    activeAccountId: null,
    accounts: [],
    proxyAuth: { username: "", password: "" },
};

/** accounts 元素不在此校验，结构可变，由 auth-setting.ts 逐项校验 */
export const AUTH_SETTING_FIELDS: readonly FieldSpec[] = [
    { path: "schemaVersion", kind: "int", min: 1 },
    { path: "activeAccountId", kind: "string", optional: true },
    { path: "proxyAuth.username", kind: "string", maxLength: 255 },
    { path: "proxyAuth.password", kind: "string", maxLength: 255 },
];
