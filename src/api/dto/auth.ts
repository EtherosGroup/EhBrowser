/** 账号和鉴权 */
// cookie 只进不出：下面这些 Input 类型只在请求方向出现，响应里永远是脱敏摘要
import type { EpochSeconds, EntityId, EhSite } from "./common.ts";

/** 账号摘要，脱敏过的。展示够用，凭据一个都没有 */
export interface AccountSummary {
    readonly id: EntityId;
    readonly label: string;
    readonly site: EhSite;
    /** 现在用的是不是它 */
    readonly active: boolean;
    readonly igneousUpdatedAt: EpochSeconds | null;
    /** 配了 apiuid / apikey 没有，评分要用 */
    readonly hasApiKey: boolean;
}

/** 鉴权总览。igneous 一个月左右就废，所以把年龄也吐出来，界面好提示重登 */
export interface AuthStatus {
    readonly loggedIn: boolean;
    readonly activeAccount: AccountSummary | null;
    readonly accountCount: number;
    /** igneous 放了多少天，不知道就 null */
    readonly igneousAgeDays: number | null;
    /** 快过期或者已经过期了，该重登 */
    readonly igneousStale: boolean;
    /** 里站通不通。没探过是 null */
    readonly exAccessible: boolean | null;
}

/**
 * cookie 三件套（+ 可选会话 id）
 * 字段名跟上游一样，别翻译，翻译了对接的时候就知道疼
 */
export interface EhCookies {
    readonly ipbMemberId: string;
    readonly ipbPassHash: string;
    /** 里站通行证，服务端签的。一个月左右废一次，变成 null 就换个节点重登 */
    readonly igneous: string;
    readonly ipbSessionId?: string;
}

/** uconfig.php 里那个，评分要用 */
export interface EhApiKey {
    readonly apiUid: string;
    readonly apiKey: string;
}

/** 只往服务端传。想把浏览器里已有的登录态导进来就用它 */
export interface AccountCredentialsInput {
    readonly label: string;
    readonly site: EhSite;
    readonly cookies: EhCookies;
    readonly apiKey?: EhApiKey;
}

/** 账号密码登录，cookie 服务端自己留着 */
export interface LoginInput {
    readonly username: string;
    readonly password: string;
    readonly site: EhSite;
    /** 不给就用用户名 */
    readonly label?: string;
}

/** 改备注或者换凭据 */
export interface AccountUpdateInput {
    readonly label?: string;
    readonly cookies?: EhCookies;
    readonly apiKey?: EhApiKey;
}
