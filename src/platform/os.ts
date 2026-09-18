// 平台判断。整个项目就这儿读 process.platform，别处别再写 "win32" / "darwin"

/** windows / macos / linux，比 Node 给的 win32、darwin 好认 */
export type PlatformName = "windows" | "macos" | "linux";

function detectPlatform(): PlatformName {
    switch (process.platform) {
        case "win32":
            return "windows";
        case "darwin":
            return "macos";
        default:
            // 其它 Unix 当 Linux 使，目录习惯和打开命令都通用
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
    // WSL 会塞 WSL_DISTRO_NAME / WSL_INTEROP。这种环境下 xdg-open 基本打不开
    // Windows 那边的浏览器，得换 wslview 或者 explorer.exe
    return Boolean(process.env["WSL_DISTRO_NAME"] ?? process.env["WSL_INTEROP"]);
}

/** 跑在 WSL 里的话，打开外部程序得换招 */
export const isWsl: boolean = detectWsl();
