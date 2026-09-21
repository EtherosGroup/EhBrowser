/*
 * 登录与通行证获取。
 * 登录在论坛域完成（表单 POST），igneous 由画廊站在登录后下发。
 * 出口节点会影响 igneous 是否下发：拿不到时通常需要更换节点后重新登录。
 */

import {
    cookiesOf,
    hasLoginCookies,
    isIgneousValue,
    pickLoginCookies,
    toCookieMap,
    type EhCookieJar,
    type LoginCookies,
} from "./cookies.ts";
import { callApi, type UpstreamSite } from "./http.ts";

const FORUM_ORIGIN = "https://forums.e-hentai.org";
const FORUM_LOGIN_URL = `${FORUM_ORIGIN}/index.php?act=Login&CODE=01`;
const FORUM_LOGIN_REFERER = `${FORUM_ORIGIN}/index.php?act=Login&CODE=00`;

export interface LoginCredentials {
    readonly username: string;
    readonly password: string;
}

/** 表单登录论坛。失败时上游不下发凭据 Cookie，此处据此抛错 */
export async function forumLogin(credentials: LoginCredentials): Promise<LoginCookies> {
    const body = new URLSearchParams({
        referer: FORUM_LOGIN_REFERER,
        b: "",
        bt: "",
        UserName: credentials.username,
        PassWord: credentials.password,
        CookieDate: "1",
    }).toString();

    const response = await callApi({
        url: FORUM_LOGIN_URL,
        method: "POST",
        body,
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: FORUM_LOGIN_REFERER,
            origin: FORUM_ORIGIN,
        },
    });

    const picked = pickLoginCookies(cookiesOf(response));
    if (!hasLoginCookies(picked)) {
        throw new Error("登录失败：未获得凭据 Cookie。账号密码可能有误，或当前出口节点被上游拒绝");
    }

    const result: { ipbMemberId: string; ipbPassHash: string; ipbSessionId?: string } = {
        ipbMemberId: picked.ipbMemberId ?? "",
        ipbPassHash: picked.ipbPassHash ?? "",
    };
    if (picked.ipbSessionId !== undefined) {
        result.ipbSessionId = picked.ipbSessionId;
    }
    return result;
}

/**
 * 用凭据 Cookie 访问画廊站以取得 igneous
 * 外站与里站各试一次：不同出口节点下发的域不同
 * 里站一次仅作兜底，连不上（代理不放行、节点不稳）不影响整体流程，因此逐个 try：
 * 两个站点都问不到时返回 null，由调用方决定如何提示
 */
export async function fetchIgneous(
    jar: Partial<EhCookieJar>,
    options: { readonly onFailure?: (site: UpstreamSite, error: unknown) => void } = {},
): Promise<string | null> {
    const cookies = toCookieMap(jar);
    const targets: ReadonlyArray<{ url: string; site: UpstreamSite }> = [
        { url: "https://e-hentai.org/", site: "e-hentai" },
        { url: "https://exhentai.org/", site: "exhentai" },
    ];

    for (const target of targets) {
        let response;
        try {
            response = await callApi({
                url: target.url,
                site: target.site,
                cookies,
                followRedirects: false,
            });
        } catch (error) {
            options.onFailure?.(target.site, error);
            continue;
        }
        const found = cookiesOf(response)["igneous"];
        if (found !== undefined && isIgneousValue(found)) {
            return found;
        }
    }
    return null;
}

/** 里站是否可访问：未登录或 igneous 无效时会被 302 到 remoteapi */
export async function probeExAccess(jar: Partial<EhCookieJar>): Promise<boolean> {
    const response = await callApi({
        url: "https://exhentai.org/",
        site: "exhentai",
        cookies: toCookieMap(jar),
        followRedirects: false,
    });
    if (response.status >= 300 && response.status < 400) {
        return false;
    }
    return response.status === 200 && !response.text.includes("sadpanda");
}
