/*
 * 标签翻译词库的线上结构。
 * 数据来自上游项目 EhTagTranslation/Database 的发布包，按需下载后移除简介，
 * 只保留「原文 -> 中文名」，因此这里只有名字与出处，没有简介文本。
 */

import type { EpochSeconds } from "./common.ts";

/** 一个命名空间的翻译：命名空间名 + 该空间下的标签名 */
export interface TranslateNamespace {
    /** 命名空间的中文名，如 language -> 语言 */
    readonly label: string;
    /** 标签原文 -> 中文名。原文一律小写，与上游本站的写法一致 */
    readonly tags: Readonly<Record<string, string>>;
}

/** 整份词库 */
export interface TranslateDatabase {
    /** 上游发布包的版本号，如 7.28221.1 */
    readonly version: string;
    /** 下载到本地的时间 */
    readonly updatedAt: EpochSeconds;
    /** 出处，界面需要标注来源 */
    readonly source: string;
    readonly namespaces: Readonly<Record<string, TranslateNamespace>>;
}

/** 词库状态：未安装、已安装、正在更新、上次更新失败均记录在此结构 */
export interface TranslateStatus {
    readonly installed: boolean;
    readonly version: string | null;
    readonly updatedAt: EpochSeconds | null;
    /** 下载地址，界面显示该值便于排查 */
    readonly source: string;
    readonly tagCount: number;
    readonly namespaceCount: number;
    readonly updating: boolean;
    /** 最近一次更新的失败原因；null 表示没出错 */
    readonly error: string | null;
}
