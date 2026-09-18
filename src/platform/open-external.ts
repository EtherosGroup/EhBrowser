// 用系统默认程序打开 URL 或路径
// 主要就干一件事：服务起来之后把界面地址丢给浏览器，用户不用敲命令行
// target 以后可能来自网页内容，所以必须校验：以 "-" 开头的会被 open / cmd start
// 当成命令行参数，协议也得卡个白名单（javascript: 那种）

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { isWsl, platform, type PlatformName } from "./os.ts";

/** 一个候选命令 */
export interface OpenCommand {
    readonly command: string;
    readonly args: readonly string[];
}

/** 只放这几个协议过去 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

/** 绝对路径原样放行，其它必须是白名单协议的 URL。不合格直接抛，错误信息给日志看 */
function normalizeTarget(input: string): string {
    const target = input.trim();
    if (target === "") {
        throw new Error("打开目标为空");
    }
    // 控制字符（包括换行）会把命令行搞乱
    if (/[\u0000-\u001f\u007f]/.test(target)) {
        throw new Error("打开目标包含控制字符");
    }
    if (target.startsWith("-")) {
        throw new Error(`打开目标不能以 "-" 开头（防止被当作命令行参数）：${target}`);
    }
    // 本地路径。Windows 的 "C:\\..." 也走这一支
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

/** 生成候选命令，按优先级排。单独导出是为了能测：不用换平台就能验三种系统的拼法 */
export function buildOpenCommands(
    rawTarget: string,
    targetPlatform: PlatformName = platform,
    inWsl: boolean = isWsl,
): OpenCommand[] {
    const target = normalizeTarget(rawTarget);

    if (targetPlatform === "windows") {
        // 第二个参数是 start 的"窗口标题"占位，少了它带引号的路径会被当成标题
        return [{ command: "cmd", args: ["/c", "start", "", target] }];
    }

    if (targetPlatform === "macos") {
        return [{ command: "open", args: [target] }];
    }

    const candidates: OpenCommand[] = [];
    if (inWsl) {
        // WSL 里 xdg-open 经常不灵，先 wslview（wslu）再 explorer.exe
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
            // 不等退出，浏览器和文件管理器都是长驻进程
            child.unref();
            resolve();
        });
    });
}

/**
 * 挨个候选试，全挂了才抛，错误里带上都试过谁
 * 只确认进程起来了，不管有没有真的打开。xdg-open 存在但执行失败会返回非 0，这儿不等也不看
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
