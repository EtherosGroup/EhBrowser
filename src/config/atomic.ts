/*
 * 落盘。
 * 流程：临时文件 -> fsync -> rename -> chmod -> fsync 目录。
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
    await mkdir(dir, { recursive: true, mode });
}

/** 文件不存在时返回 null */
export async function readTextIfExists(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf8");
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
}

export function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
    );
}

/**
 * 原子写。临时文件必须与目标文件同目录，跨分区 rename 不再具有原子性。
 * mode 未传入时使用 0o600。
 */
export async function writeFileAtomic(
    file: string,
    text: string,
    options: { mode?: number } = {},
): Promise<void> {
    const dir = dirname(file);
    const mode = options.mode ?? 0o600;
    await ensureDir(dir);

    const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    const handle = await open(tmp, "w", mode);
    try {
        await handle.writeFile(text, "utf8");
        // 写入的内容先落盘，随后执行 sync
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(tmp).catch(() => undefined);
        throw error;
    }
    await handle.close();

    try {
        await rename(tmp, file);
    } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
    }

    // 部分文件系统在 rename 后权限会跟随临时文件，这里显式重设权限
    await chmod(file, mode);
    await syncDir(dir);
}

/** 将损坏文件移到一边，返回移动后的位置 */
export async function moveAside(file: string, suffix: string): Promise<string> {
    const target = `${file}.${suffix}`;
    await rename(file, target);
    return target;
}

/** 备份与损坏文件用的时间戳，形如 20260919-013045 */
export function timeStamp(date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}

async function syncDir(dir: string): Promise<void> {
    try {
        const handle = await open(dir, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // 目录 fsync 失败时忽略该错误
    }
}
