/**
 * 用系统默认程序打开 URL 或文件/目录。
 *
 * 主要用途：本地服务启动后把界面地址交给默认浏览器，用户不需要敲命令行。
 *
 * 安全：target 将来可能来自网页内容，所以必须校验 —— 尤其要挡住以 "-" 开头的字符串
 * （会被 open / cmd start 当成命令行参数）以及不在白名单里的协议（如 javascript:）。
 */

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { isWsl, platform, type PlatformName } from "./os.ts";

/** 一个候选启动命令。 */
export interface OpenCommand {
    readonly command: string;
    readonly args: readonly string[];
}

/** 允许交给系统程序打开的协议。 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

/**
 * 校验并规范化目标：绝对路径原样返回，其余必须是白名单协议的 URL。
 * 校验失败直接抛出（错误信息面向日志/开发者，不直接展示给终端用户）。
 */
function normalizeTarget(input: string): string {
    const target = input.trim();
    if (target === "") {
        throw new Error("打开目标为空");
    }
    // 控制字符（含换行）会破坏命令行语义
    if (/[\u0000-\u001f\u007f]/.test(target)) {
        throw new Error("打开目标包含控制字符");
    }
    if (target.startsWith("-")) {
        throw new Error(`打开目标不能以 "-" 开头（防止被当作命令行参数）：${target}`);
    }
    // 本地路径（Windows 的 "C:\\..." 也走这一支）
    if (isAbsolute(target)) {
        return target;
    }

    let parsed: URL;
    try {
        parsed = new URL(target);
    } catch {
        throw new Error(`既不是绝对路径也不是合法 URL：${target}`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`不允许通过系统程序打开的协议：${parsed.protocol}`);
    }
    return parsed.href;
}

/**
 * 生成候选启动命令，按优先级排列。
 *
 * 单独导出是为了可测试：可以在不改动当前平台的情况下检查三种系统的命令构造。
 */
export function buildOpenCommands(
    rawTarget: string,
    targetPlatform: PlatformName = platform,
    inWsl: boolean = isWsl,
): OpenCommand[] {
    const target = normalizeTarget(rawTarget);

    if (targetPlatform === "windows") {
        // 第二个空参数是 start 的「窗口标题」占位：缺了它，带引号的路径会被当成标题
        return [{ command: "cmd", args: ["/c", "start", "", target] }];
    }

    if (targetPlatform === "macos") {
        return [{ command: "open", args: [target] }];
    }

    const candidates: OpenCommand[] = [];
    if (inWsl) {
        // WSL 下 xdg-open 经常无效：优先 wslview（wslu），再退回 explorer.exe
        candidates.push({ command: "wslview", args: [target] });
        candidates.push({ command: "explorer.exe", args: [target] });
    }
    candidates.push({ command: "xdg-open", args: [target] });
    candidates.push({ command: "gio", args: ["open", target] });
    return candidates;
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
            // 不等待退出：浏览器/文件管理器是长驻进程
            child.unref();
            resolve();
        });
    });
}

/**
 * 打开目标：依次尝试候选命令，全部失败时抛出聚合错误。
 *
 * 已知局限：只确认「进程成功启动」，不判断它是否真的打开了目标 ——
 * xdg-open 存在但执行失败时会返回非 0 退出码，这里不会等待也不会检测。
 */
export async function openExternal(rawTarget: string): Promise<void> {
    const target = normalizeTarget(rawTarget);
    const failures: string[] = [];

    for (const candidate of buildOpenCommands(target)) {
        try {
            await spawnDetached(candidate.command, candidate.args);
            return;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            failures.push(`${candidate.command}: ${reason}`);
        }
    }

    throw new Error(`无法打开 ${target}；已尝试 ${failures.join("，")}`);
}
