const KNOWN: Readonly<Record<string, keyof PastedCookies>> = {
    ipb_member_id: "ipbMemberId",
    ipb_pass_hash: "ipbPassHash",
    igneous: "igneous",
    ipb_session_id: "ipbSessionId",
};

const ATTRIBUTES: ReadonlySet<string> = new Set([
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "version",
    "comment",
    "commenturl",
    "discard",
    "port",
    "priority",
    "partitioned",
]);

export interface PastedCookies {
    readonly ipbMemberId: string;
    readonly ipbPassHash: string;
    readonly igneous: string;
    readonly ipbSessionId: string;
}

export interface PasteResult {
    readonly cookies: PastedCookies;
    readonly ignored: readonly string[];
    readonly missing: readonly string[];
}

export function parsePastedCookies(text: string): PasteResult {
    const found: Partial<Record<keyof PastedCookies, string>> = {};
    const ignored: string[] = [];
    const seenIgnored = new Set<string>();

    const body = text.replace(/^\s*cookie\s*:/i, "");
    for (const chunk of body.split(/[;\n\r\t]+/)) {
        const pair = chunk.trim();
        const separator = pair.indexOf("=");
        if (separator <= 0) {
            continue;
        }
        const name = pair.slice(0, separator).trim().toLowerCase();
        if (name === "") {
            continue;
        }
        const value = unquote(pair.slice(separator + 1).trim());
        const field = KNOWN[name];
        if (field !== undefined) {
            if (value !== "" && found[field] === undefined) {
                found[field] = value;
            }
            continue;
        }
        if (!ATTRIBUTES.has(name) && !seenIgnored.has(name)) {
            seenIgnored.add(name);
            ignored.push(name);
        }
    }

    const cookies: PastedCookies = {
        ipbMemberId: found.ipbMemberId ?? "",
        ipbPassHash: found.ipbPassHash ?? "",
        igneous: found.igneous ?? "",
        ipbSessionId: found.ipbSessionId ?? "",
    };

    const missing: string[] = [];
    if (cookies.ipbMemberId === "") {
        missing.push("ipb_member_id");
    }
    if (cookies.ipbPassHash === "") {
        missing.push("ipb_pass_hash");
    }
    return { cookies, ignored, missing };
}

function unquote(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).trim();
    }
    return value;
}
