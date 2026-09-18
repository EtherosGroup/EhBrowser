/**
 * 落盘
 * 临时文件 → fsync → rename → chmod → fsync 目录
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
    await mkdir(dir, { recursive: true, mode });
}

/** 文件不存在就当 null */
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
 * 原子写。临时文件必须和目标同目录，跨分区 rename 就不是原子的了
 * mode 不传就用 0o600
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
        // 内容先落盘，再动指针
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

    // 防止某些傻逼文件系统 rename 后权限会跟着临时文件走
    await chmod(file, mode);
    await syncDir(dir);
}

/** 坏文件移动，返回移动后位置 */
export async function moveAside(file: string, suffix: string): Promise<string> {
    const target = `${file}.${suffix}`;
    await rename(file, target);
    return target;
}

/** 给备份/损坏文件用的时间戳 e.g 20260919-013045 */
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
        // :D 不知道要干啥
    }
}
