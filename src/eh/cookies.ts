/*
 * Cookie 处理。上游使用 IPB 论坛体系，字段名固定。
 * 仅在服务端使用；解析结果是纯数据，可直接写入 auth_setting。
 */

import type { UpstreamResponse } from "./http.ts";

/** 登录凭据：论坛登录成功后立即拿到 */
export interface LoginCookies {
    readonly ipbMemberId: string;
    readonly ipbPassHash: string;
    readonly ipbSessionId?: string;
}

/** 完整 Cookie：igneous 由画廊站在登录后另行下发 */
export interface EhCookieJar extends LoginCookies {
    readonly igneous: string;
}

export type CookieMap = Record<string, string>;

/** Set-Cookie 逐条解析为键值。只取第一段，忽略 expires / path 等属性 */
export function parseSetCookie(lines: readonly string[]): CookieMap {
    const out: CookieMap = {};
    for (const line of lines) {
        const first = line.split(";", 1)[0] ?? "";
        const separator = first.indexOf("=");
        if (separator <= 0) {
            continue;
        }
        const name = first.slice(0, separator).trim();
        const value = first.slice(separator + 1).trim();
        if (name !== "") {
            out[name] = value;
        }
    }
    return out;
}

export function cookiesOf(response: UpstreamResponse): CookieMap {
    return parseSetCookie(response.setCookie);
}

/** 只保留对接上游需要的字段，session_id、uconfig 之类丢弃 */
export function pickLoginCookies(cookies: CookieMap): Partial<LoginCookies & { igneous: string }> {
    const picked: {
        ipbMemberId?: string;
        ipbPassHash?: string;
        igneous?: string;
        ipbSessionId?: string;
    } = {};
    for (const [source, target] of [
        ["ipb_member_id", "ipbMemberId"],
        ["ipb_pass_hash", "ipbPassHash"],
        ["igneous", "igneous"],
        ["ipb_session_id", "ipbSessionId"],
    ] as const) {
        const value = cookies[source];
        if (value !== undefined) {
            picked[target] = value;
        }
    }
    return picked;
}

/** 拿到 member id 与 pass hash 才算登录成功；igneous 可能稍后才下发 */
export function hasLoginCookies(cookies: Partial<EhCookieJar>): boolean {
    return (cookies.ipbMemberId ?? "") !== "" && (cookies.ipbPassHash ?? "") !== "";
}

/** 拼成请求头用的对象，空值不发送 */
export function toCookieMap(jar: Partial<EhCookieJar>): CookieMap {
    const map: CookieMap = {};
    if (jar.ipbMemberId !== undefined && jar.ipbMemberId !== "") {
        map["ipb_member_id"] = jar.ipbMemberId;
    }
    if (jar.ipbPassHash !== undefined && jar.ipbPassHash !== "") {
        map["ipb_pass_hash"] = jar.ipbPassHash;
    }
    if (jar.igneous !== undefined && jar.igneous !== "") {
        map["igneous"] = jar.igneous;
    }
    if (jar.ipbSessionId !== undefined && jar.ipbSessionId !== "") {
        map["ipb_session_id"] = jar.ipbSessionId;
    }
    return map;
}

/** igneous 约十几位；旧的 9 位版本已被上游作废，空值与 mystery 均视为无效 */
export function isIgneousValue(value: string): boolean {
    return value !== "" && value !== "mystery" && value.length >= 12;
}
