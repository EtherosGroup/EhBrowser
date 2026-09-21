/*
 * 剪贴板。不依赖 Vue，便于单独验证。
 * 优先用剪贴板 API。非安全上下文（例如局域网地址直连）没有该 API，退回临时 textarea 选中复制。
 */

export interface ClipboardWriter {
    writeText(value: string): Promise<void>;
}

export interface CopyDocument {
    createElement(tag: string): CopyElement;
    execCommand(command: string): boolean;
    body: { append(node: unknown): void };
}

export interface CopyElement {
    value: string;
    style: { position: string; opacity: string };
    setAttribute(name: string, value: string): void;
    select(): void;
    remove(): void;
}

/** 复制文本，返回是否成功。空文本视为失败。 */
export async function copyText(text: string): Promise<boolean> {
    if (text === "") {
        return false;
    }
    const clipboard = readClipboard();
    if (clipboard !== null) {
        try {
            await clipboard.writeText(text);
            return true;
        } catch {
            // 权限被拒或剪贴板不可用时落到兜底路径。
        }
    }
    return copyBySelection(text);
}

function readClipboard(): ClipboardWriter | null {
    const host = globalThis as { navigator?: { clipboard?: ClipboardWriter } };
    return host.navigator?.clipboard ?? null;
}

/** 兜底路径：插入不可见的 textarea，选中后交给 execCommand。 */
function copyBySelection(text: string): boolean {
    const host = globalThis as { document?: CopyDocument };
    const doc = host.document;
    if (doc === undefined || typeof doc.execCommand !== "function") {
        return false;
    }

    const holder = doc.createElement("textarea");
    holder.value = text;
    holder.setAttribute("readonly", "");
    holder.style.position = "fixed";
    holder.style.opacity = "0";
    doc.body.append(holder as unknown);
    holder.select();

    let copied = false;
    try {
        copied = doc.execCommand("copy");
    } catch {
        copied = false;
    }
    holder.remove();
    return copied;
}
