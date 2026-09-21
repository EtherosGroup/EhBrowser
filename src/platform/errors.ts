/*
 * 错误描述。undici 的失败原因嵌在 cause 链里。
 * 只取 message 会得到 "fetch failed"，真实原因（连接被拒、超时、DNS）在下一层。
 */

/** 读取错误对象上的 code。Node 的 DNS 与 syscall 错误只有 code。 */
export function errorCode(error: unknown): string {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
        if (current === null || current === undefined) {
            return "";
        }
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string" && code !== "") {
            return code;
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return "";
}

/** 把 message 与各层 cause 合并为一句。重复文本只保留一次。 */
export function describeError(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;

    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
        if (current === null || current === undefined) {
            break;
        }
        const message = current instanceof Error ? current.message : String(current);
        const code = (current as { code?: unknown }).code;
        const text =
            message === "" && typeof code === "string"
                ? code
                : typeof code === "string" && code !== "" && !message.includes(code)
                  ? `${message}（${code}）`
                  : message;
        if (text !== "" && !parts.includes(text)) {
            parts.push(text);
        }
        current = current instanceof Error ? current.cause : undefined;
    }

    if (parts.length === 0) {
        return String(error);
    }
    return parts.join("：");
}

/** cause 链可能成环，也有平台自造的深链。 */
const MAX_DEPTH = 6;

/*
 * 传输层失败的说明文字。
 * undici 的原文是英文，且只说「fetch failed：Client network socket disconnected…」，
 * 用户看不出是代理在握手阶段断连，还是本站解析出错。这里按特征补一句可能的原因。
 */
export function hintForTransportFailure(error: unknown): string {
    const text = describeError(error);
    if (/disconnected before secure TLS|ECONNRESET/i.test(text)) {
        return "连接在 TLS 握手阶段被重置，请求没到达上游：多半是代理/节点不稳定，或该站点没走代理（被拒绝直连）；重试一次通常就好";
    }
    if (/socket hang up|other side closed|UND_ERR_SOCKET/i.test(text)) {
        return "连接被对端提前关闭，请求没到达上游：多半是代理/节点不稳定；重试一次通常就好";
    }
    if (/UND_ERR_CONNECT_TIMEOUT|Connect Timeout Error|ETIMEDOUT/i.test(text)) {
        return "连接上游超时：代理/节点不通，或该站点被直连后遭阻断";
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
        return "上游域名解析失败：检查 DNS 与代理设置";
    }
    if (/ECONNREFUSED/i.test(text)) {
        return "连接被拒绝：代理端口可能不对，或代理没有在监听";
    }
    return "";
}

/** 上游失败的一句话：原文在前，可能的原因附在后面 */
export function describeTransportError(error: unknown): string {
    const reason = describeError(error);
    const hint = hintForTransportFailure(error);
    return hint === "" ? reason : `${reason}（${hint}）`;
}
