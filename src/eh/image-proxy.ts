/*
 * 图片代理的规则：哪些上游地址可以经本机服务端取，以及要不要改写。
 *
 * 为什么需要它：EhViewer 只有一套 OkHttp，API、页面、缩略图、图片全走它，所以「内置 host」换一次解析
 * 就全线生效。EhBrowser 的图片是**浏览器直取**的，浏览器走系统 DNS，于是只改服务端解析会出现
 * 「接口通了、图是白板」。开了直连解析时，服务端把手里的上游图片地址改写成
 * /api/proxy/image?url=…，由服务端（带着修正后的解析）去取，等价性才对得上。
 *
 * 安全：这是本机服务端代取任意 URL 的入口，必须只认上游图床的白名单，否则等于给出一个 SSRF 跳板。
 */

/** 允许代理的上游域名后缀（含子域）。只放图床与站点本体，别的一律拒绝 */
export const PROXYABLE_HOST_SUFFIXES: readonly string[] = [
    "e-hentai.org",
    "exhentai.org",
    "ehgt.org",
    // H@H 图床：每台节点一个子域，但都在这个后缀下
    "hath.network",
];

/** 看域名是否在允许列表里（按标签边界匹配，避免 evil-e-hentai.org 这种被放过） */
export function isProxyableHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return PROXYABLE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 这个 URL 能不能交给代理去取。
 * 只认 http/https、只认白名单域名；带不带端口都行（上游正常不带，测试时会带）。
 */
export function isProxyableImageUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return false;
    }
    return isProxyableHost(parsed.hostname);
}

/**
 * 响应里需要被改写的那种字符串：上游图片地址。
 * 判据故意保守——必须是 http(s) 且域名在白名单里，避免把标题之类的普通文本改掉。
 */
export function looksLikeUpstreamImageUrl(value: unknown): value is string {
    return typeof value === "string" && value.startsWith("http") && isProxyableImageUrl(value);
}

/** 把上游图片地址包成经本机代理的地址。令牌走 query，因为 <img src> 带不了请求头 */
export function proxiedImageUrl(url: string, token: string): string {
    const query = new URLSearchParams({ url, _token: token });
    return `/api/proxy/image?${query.toString()}`;
}

/**
 * 递归改写一份响应负载里的上游图片地址。
 * 只改字符串叶子，不动结构；direct 关闭时调用方根本不调它。
 */
export function rewriteUpstreamImageUrls<T>(payload: T, token: string): T {
    if (typeof payload === "string") {
        return (
            looksLikeUpstreamImageUrl(payload) ? proxiedImageUrl(payload, token) : payload
        ) as T;
    }
    if (Array.isArray(payload)) {
        return payload.map((item) => rewriteUpstreamImageUrls(item, token)) as T;
    }
    if (payload !== null && typeof payload === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
            out[key] = rewriteUpstreamImageUrls(value, token);
        }
        return out as T;
    }
    return payload;
}
