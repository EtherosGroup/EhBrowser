/*
 * 内置 hosts 种子表。用途与 EhViewer 的「内置 host」一样：绕开本地 DNS 污染。
 *
 * 这不是权威数据，只是**种子**：程序会优先用用户自己的 hosts，其次用这张表，
 * 再不行就问 DoH（`doh.ts`）并缓存结果，最后才落到系统解析。因此这张表过期不会致命，
 * 它只负责「第一次运行时不必先解析成功也能摸到上游」。
 *
 * 记两个实测结论，避免以后有人误以为表写小了不行：
 *   - Cloudflare 是 anycast：**任意** CF 边缘 IP 配上正确 SNI 都能服务这些站（实测 104.16.132.229 + e-hentai.org → 200），
 *     所以 CF 前置的域名（e-hentai / exhentai / forums / repo）只要有几个 CF IP 就够了，不必精确。
 *   - ehgt.org、upld.e-hentai.org、s.exhentai.org 不在 CF 上，是各自的主机，IP 会变，靠 DoH 刷新。
 *
 * 本表的 IP 来自 Cloudflare DoH 实测解析（2026-09-24），并与 EhViewer（xiaojieonly 分支）内置表交叉核对。
 */

/** 取表的时间。刷新这张表时一并改这里，方便排查「表太旧」 */
export const BUILT_IN_HOSTS_UPDATED_AT = "2026-09-24";

export const BUILT_IN_HOSTS: Readonly<Record<string, readonly string[]>> = {
    // Cloudflare 前置（任意 CF IP 都行，这里给 EH 自己解析到的）
    "e-hentai.org": ["172.66.132.196", "172.66.140.62"],
    "forums.e-hentai.org": ["172.66.132.196", "172.66.140.62"],
    "repo.e-hentai.org": ["172.66.132.196", "172.66.140.62"],
    "exhentai.org": ["104.21.56.202", "172.67.187.219"],

    // 自建主机
    "ehgt.org": ["89.39.106.43", "62.112.8.21", "109.236.85.28"],
    "upld.e-hentai.org": ["95.211.208.236", "89.149.221.236"],
    "s.exhentai.org": ["178.175.129.254", "178.175.128.254", "178.175.132.22"],

    // 词库与更新检查会用到；GitHub 本身也常被污染
    "raw.githubusercontent.com": [
        "185.199.108.133",
        "185.199.109.133",
        "185.199.110.133",
        "185.199.111.133",
    ],
    "github.com": ["140.82.112.4", "140.82.113.4", "140.82.114.4", "140.82.121.4"],
    "objects.githubusercontent.com": ["185.199.108.133", "185.199.109.133"],
};
