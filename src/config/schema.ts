/*
 * 类型、默认值与字段表的唯一定义处。
 * 字段变更涉及三处：本文件的类型/默认值/字段表、版本号、migrations.ts 中的迁移步骤。
 */

import type { FieldSpec } from "./validate.ts";

export const USER_SETTING_VERSION = 6;

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
    /** 向后预加载几张 */
    readonly preloadCount: number;
    /** 图片缓存上限，单位 MB */
    readonly maxCacheMb: number;
    /** 同时最多加载几张 */
    readonly maxConcurrentLoads: number;
    readonly autoplay: AutoplayConfig;
}

export interface AutoplayConfig {
    readonly enabled: boolean;
    /** 自动播放的间隔，单位秒 */
    readonly intervalSeconds: number;
    /** 播完最后一张是否回到第一张 */
    readonly loop: boolean;
}

export interface TranslateConfig {
    /** 标签与类别的中文翻译 */
    readonly tags: boolean;
}

export interface SafetyConfig {
    /** 进入页面时是否提示紧急避险 */
    readonly hintEnabled: boolean;
    /** 避险地点：网页地址或本地 file:// 地址。默认空屏 */
    readonly url: string;
}

export interface DownloadConfig {
    readonly directory: string;
    readonly keepArchive: boolean;
    readonly preferredResolution: string;
    readonly concurrency: number;
}

export interface LogConfig {
    /** 是否把日志写入文件；关闭时只有控制台与界面可见 */
    readonly enabled: boolean;
    /** 日志目录。空字符串表示用默认目录 ~/ehbrowser/logs */
    readonly directory: string;
}

export interface SearchConfig {
    /**
     * 打开界面时是否自动检索画廊：启动时预热一次，打开搜索页时铺一份默认结果。
     * 默认关闭——不打招呼就去上游拉内容，对这类工具不合适。
     */
    readonly auto: boolean;
    /** 进入页面时是否提示可以开自动搜索 */
    readonly hintEnabled: boolean;
}

export interface UiConfig {
    readonly theme: "system" | "light" | "dark";
    readonly thumbnailSize: number;
    readonly pageSize: number;
    /** 详情页缓存的画廊个数，0 表示不缓存 */
    readonly cachedGalleries: number;
}

export interface UserSetting {
    readonly schemaVersion: number;
    readonly locale: string;
    readonly preferredSite: "e-hentai" | "exhentai";
    readonly network: NetworkConfig;
    readonly viewer: ViewerConfig;
    readonly translate: TranslateConfig;
    readonly safety: SafetyConfig;
    readonly download: DownloadConfig;
    readonly log: LogConfig;
    readonly ui: UiConfig;
    readonly search: SearchConfig;
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
        maxCacheMb: 512,
        maxConcurrentLoads: 3,
        autoplay: {
            enabled: false,
            intervalSeconds: 5,
            loop: false,
        },
    },
    translate: {
        tags: false,
    },
    safety: {
        // 默认落到空白页：未配置地点时，按快捷键也能立即替换屏幕内容
        hintEnabled: true,
        url: "about:blank",
    },
    download: {
        directory: "",
        keepArchive: true,
        preferredResolution: "org",
        concurrency: 2,
    },
    log: {
        enabled: true,
        // 空字符串有效：表示用默认目录
        directory: "",
    },
    ui: {
        theme: "system",
        thumbnailSize: 250,
        pageSize: 25,
        cachedGalleries: 20,
    },
    search: {
        // 默认不自动搜索：打开界面时不主动去上游拉内容
        auto: false,
        hintEnabled: true,
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
    { path: "viewer.preloadCount", kind: "int", min: 0, max: 20 },
    { path: "viewer.maxCacheMb", kind: "int", min: 64, max: 8192 },
    { path: "viewer.maxConcurrentLoads", kind: "int", min: 1, max: 8 },
    { path: "viewer.autoplay.enabled", kind: "boolean" },
    { path: "viewer.autoplay.intervalSeconds", kind: "int", min: 1, max: 120 },
    { path: "viewer.autoplay.loop", kind: "boolean" },
    { path: "translate.tags", kind: "boolean" },
    { path: "safety.hintEnabled", kind: "boolean" },
    // 空字符串有效：表示未设置，按快捷键时落到空白页
    { path: "safety.url", kind: "string", maxLength: 4096 },
    // 空字符串有效，表示尚未设置
    { path: "download.directory", kind: "string", maxLength: 4096 },
    { path: "download.keepArchive", kind: "boolean" },
    { path: "download.preferredResolution", kind: "string", minLength: 1, maxLength: 16 },
    { path: "download.concurrency", kind: "int", min: 1, max: 8 },
    { path: "log.enabled", kind: "boolean" },
    // 空字符串有效，表示用默认目录
    { path: "log.directory", kind: "string", maxLength: 4096 },
    { path: "ui.theme", kind: "enum", values: ["system", "light", "dark"] },
    { path: "ui.thumbnailSize", kind: "int", min: 100, max: 1000 },
    { path: "ui.pageSize", kind: "int", min: 5, max: 100 },
    { path: "ui.cachedGalleries", kind: "int", min: 0, max: 500 },
    { path: "search.auto", kind: "boolean" },
    { path: "search.hintEnabled", kind: "boolean" },
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
