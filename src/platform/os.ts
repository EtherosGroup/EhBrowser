/**
 * 平台识别。本项目仅此模块读取 process.platform
 */

/** 人类可读的平台名，不使用 Node 的 win32 / darwin 原始值 */
export type PlatformName = "windows" | "macos" | "linux";

function detectPlatform(): PlatformName {
    switch (process.platform) {
        case "win32":
            return "windows";
        case "darwin":
            return "macos";
        default:
            // 其余 Unix 按 Linux 处理，目录惯例与打开命令一致
            return "linux";
    }
}

export const platform: PlatformName = detectPlatform();

export const isWindows: boolean = platform === "windows";
export const isMacOS: boolean = platform === "macos";
export const isLinux: boolean = platform === "linux";

function detectWsl(): boolean {
    if (platform !== "linux") {
        return false;
    }
    // WSL 会注入 WSL_DISTRO_NAME / WSL_INTEROP。该环境下 xdg-open 通常无法打开
    // Windows 侧浏览器，需改用 wslview 或 explorer.exe
    return Boolean(process.env["WSL_DISTRO_NAME"] ?? process.env["WSL_INTEROP"]);
}

/** 是否运行于 WSL，影响外部程序打开策略 */
export const isWsl: boolean = detectWsl();
