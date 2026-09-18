/**
 * 平台识别。
 *
 * 这是整个项目里唯一直接读取 process.platform 的模块 —— config、db、services
 * 都从这里取平台信息，不要在别处散落 "win32" / "darwin" 这类原始字符串判断。
 */

/** 人类可读的平台名（不用 Node 的 "win32" / "darwin" 原始值）。 */
export type PlatformName = "windows" | "macos" | "linux";

function detectPlatform(): PlatformName {
    switch (process.platform) {
        case "win32":
            return "windows";
        case "darwin":
            return "macos";
        default:
            // 其余 Unix（freebsd 等）按 Linux 处理：目录习惯和打开命令都适用
            return "linux";
    }
}

/** 当前平台。 */
export const platform: PlatformName = detectPlatform();

export const isWindows: boolean = platform === "windows";
export const isMacOS: boolean = platform === "macos";
export const isLinux: boolean = platform === "linux";

function detectWsl(): boolean {
    if (platform !== "linux") {
        return false;
    }
    // WSL 会注入 WSL_DISTRO_NAME / WSL_INTEROP。这种环境下 xdg-open 往往打不开
    // Windows 侧的浏览器，需要改用 wslview 或 explorer.exe。
    return Boolean(process.env["WSL_DISTRO_NAME"] ?? process.env["WSL_INTEROP"]);
}

/** 是否运行在 WSL 中（影响「打开外部程序」的实现）。 */
export const isWsl: boolean = detectWsl();
