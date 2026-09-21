/*
 * 账号与鉴权
 * Cookie 单向流入：下列 Input 类型仅出现在请求方向，响应中始终为脱敏摘要
 */

import type { EpochSeconds, EntityId, EhSite } from "./common.ts";

/** 账号摘要，已脱敏；不含任何凭据 */
export interface AccountSummary {
    readonly id: EntityId;
    readonly label: string;
    readonly site: EhSite;
    /** 是否为当前使用账号 */
    readonly active: boolean;
    readonly igneousUpdatedAt: EpochSeconds | null;
    /** 是否已配置 apiuid / apikey（评分使用） */
    readonly hasApiKey: boolean;
}

/** 鉴权总览；igneous 有效期约一个月，故返回其年龄供界面提示重新登录 */
export interface AuthStatus {
    readonly loggedIn: boolean;
    readonly activeAccount: AccountSummary | null;
    readonly accountCount: number;
    /** igneous 已存在的天数；未知为 null */
    readonly igneousAgeDays: number | null;
    /** 临近过期或已过期 */
    readonly igneousStale: boolean;
    /** 里站是否可达；未探测为 null */
    readonly exAccessible: boolean | null;
}

/**
 * Cookie 三件套（含可选会话 id）
 * 字段名与上游保持一致，避免转换引入歧义
 */
export interface EhCookies {
    readonly ipbMemberId: string;
    readonly ipbPassHash: string;
    /** 里站通行证，由服务端签发，有效期约一个月；为空通常表示出口节点不适用 */
    readonly igneous: string;
    readonly ipbSessionId?: string;
}

/** 来自 uconfig.php，评分接口使用 */
export interface EhApiKey {
    readonly apiUid: string;
    readonly apiKey: string;
}

/** 仅请求方向；用于导入浏览器中已有的登录态 */
export interface AccountCredentialsInput {
    readonly label: string;
    readonly site: EhSite;
    readonly cookies: EhCookies;
    readonly apiKey?: EhApiKey;
}

/** 账号密码登录；Cookie 由服务端保存 */
export interface LoginInput {
    readonly username: string;
    readonly password: string;
    readonly site: EhSite;
    /** 缺省使用用户名 */
    readonly label?: string;
}

/** 更新备注或凭据 */
export interface AccountUpdateInput {
    readonly label?: string;
    readonly cookies?: EhCookies;
    readonly apiKey?: EhApiKey;
}
