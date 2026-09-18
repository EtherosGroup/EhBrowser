/**
 * 数据目录解析。
 *
 * 三条根目录，按「敏感度 × 是否可重建」划分：
 *   config —— 用户可手改的配置 + 账号 cookie（唯一真相源，丢了要重配）
 *   data   —— 数据库、下载、日志（含可重建的索引）
 *   cache  —— 缩略图等（随时可删）
 *
 * 优先级（高 → 低）：
 *   1. initPaths() 传入的显式覆盖（给 CLI 参数用）
 *   2. 分项环境变量 EHBROWSER_CONFIG_DIR / EHBROWSER_DATA_DIR / EHBROWSER_CACHE_DIR
 *   3. 便携模式 EHBROWSER_HOME：三根收敛为 <HOME>/config、<HOME>/data、<HOME>/cache
 *   4. 操作系统默认位置（XDG / Library / APPDATA）
 *
 * 本模块只解析路径，不创建目录 —— 创建走 ensureDirs()，避免 import 时产生副作用。
 */

import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { isWindows, platform } from "./os.ts";

/** 各平台统一使用的应用目录名。 */
export const APP_DIR_NAME = "ehbrowser";

/** 三条根目录。 */
export interface PathRoots {
    readonly configDir: string;
    readonly dataDir: string;
    readonly cacheDir: string;
}

/** 显式覆盖（通常来自 CLI 参数）。相对路径按当前工作目录解析。 */
export interface PathOverrides {
    readonly configDir?: string;
    readonly dataDir?: string;
    readonly cacheDir?: string;
}

/** 某个根目录最终取值的来源层，用于诊断。 */
export type PathSource = "override" | "env" | "portable-home" | "os-default";

export interface ResolvedPaths extends PathRoots {
    readonly sources: Readonly<Record<keyof PathRoots, PathSource>>;
}

const CACHE_SUBDIR = "cache";
/** 目录权限：这棵树里会放账号 cookie，一律 0700。 */
const DIR_MODE = 0o700;

let cached: ResolvedPaths | null = null;

function readEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    return value === "" ? undefined : value;
}

function expandTilde(input: string): string {
    if (input === "~") {
        return homedir();
    }
    if (input.startsWith("~/") || input.startsWith("~\\")) {
        return join(homedir(), input.slice(2));
    }
    return input;
}

function toAbsolute(input: string): string {
    const expanded = expandTilde(input);
    return normalize(isAbsolute(expanded) ? expanded : join(process.cwd(), expanded));
}

function osDefaultRoots(): PathRoots {
    if (isWindows) {
        const roaming = readEnv("APPDATA") ?? join(homedir(), "AppData", "Roaming");
        const local = readEnv("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local");
        return {
            configDir: join(roaming, APP_DIR_NAME),
            dataDir: join(local, APP_DIR_NAME),
            // Windows 没有独立的 cache 约定，缓存跟在 data 下
            cacheDir: join(local, APP_DIR_NAME, CACHE_SUBDIR),
        };
    }

    if (platform === "macos") {
        // macOS 惯例：配置与数据同在 Application Support，缓存单独放 Caches
        const support = join(homedir(), "Library", "Application Support", APP_DIR_NAME);
        return {
            configDir: support,
            dataDir: support,
            cacheDir: join(homedir(), "Library", "Caches", APP_DIR_NAME),
        };
    }

    // Linux 及其它 Unix：遵循 XDG。注意 XDG_*_HOME 经常没有被设置，
    // 必须回退到 ~/.config、~/.local/share、~/.cache，否则会解析出 "undefined/..." 这类路径。
    return {
        configDir: join(readEnv("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), APP_DIR_NAME),
        dataDir: join(readEnv("XDG_DATA_HOME") ?? join(homedir(), ".local", "share"), APP_DIR_NAME),
        cacheDir: join(readEnv("XDG_CACHE_HOME") ?? join(homedir(), ".cache"), APP_DIR_NAME),
    };
}

function portableRoots(home: string): PathRoots {
    const base = toAbsolute(home);
    return {
        configDir: join(base, "config"),
        dataDir: join(base, "data"),
        cacheDir: join(base, CACHE_SUBDIR),
    };
}

/** 解析三条根目录并缓存。重复调用会用最新的参数与环境变量重新解析。 */
export function initPaths(overrides: PathOverrides = {}): ResolvedPaths {
    const portableHome = readEnv("EHBROWSER_HOME");
    const base: PathRoots =
        portableHome === undefined ? osDefaultRoots() : portableRoots(portableHome);

    const sources: Record<keyof PathRoots, PathSource> = {
        configDir: portableHome === undefined ? "os-default" : "portable-home",
        dataDir: portableHome === undefined ? "os-default" : "portable-home",
        cacheDir: portableHome === undefined ? "os-default" : "portable-home",
    };

    const resolveOne = (
        key: keyof PathRoots,
        envName: string,
        override: string | undefined,
    ): string => {
        if (override !== undefined && override.trim() !== "") {
            sources[key] = "override";
            return toAbsolute(override);
        }
        const fromEnv = readEnv(envName);
        if (fromEnv !== undefined) {
            sources[key] = "env";
            return toAbsolute(fromEnv);
        }
        return base[key];
    };

    const resolved: ResolvedPaths = {
        configDir: resolveOne("configDir", "EHBROWSER_CONFIG_DIR", overrides.configDir),
        dataDir: resolveOne("dataDir", "EHBROWSER_DATA_DIR", overrides.dataDir),
        cacheDir: resolveOne("cacheDir", "EHBROWSER_CACHE_DIR", overrides.cacheDir),
        sources,
    };

    cached = resolved;
    return resolved;
}

/** 取当前解析结果；若尚未解析过，按默认优先级解析一次。 */
export function getPaths(): ResolvedPaths {
    return cached ?? initPaths();
}

/** 清空缓存（测试用：下次 getPaths() 会重新读取环境变量）。 */
export function resetPaths(): void {
    cached = null;
}

/**
 * 创建三条根目录。POSIX 下会把已存在目录的权限收紧到 0700 ——
 * 因为这棵树里会放账号 cookie。Windows 上 chmod 基本无效，直接跳过。
 */
export async function ensureDirs(roots: PathRoots = getPaths()): Promise<void> {
    for (const dir of [roots.configDir, roots.dataDir, roots.cacheDir]) {
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        if (isWindows) {
            continue;
        }
        const info = await stat(dir);
        if ((info.mode & 0o777) !== DIR_MODE) {
            await chmod(dir, DIR_MODE);
        }
    }
}

/** 供诊断命令使用：打印三条根目录及其来源层。 */
export function describePaths(roots: ResolvedPaths = getPaths()): string {
    const rows: Array<[string, string, PathSource]> = [
        ["config", roots.configDir, roots.sources.configDir],
        ["data", roots.dataDir, roots.sources.dataDir],
        ["cache", roots.cacheDir, roots.sources.cacheDir],
    ];
    return rows
        .map(([name, value, source]) => `${name.padEnd(6)} ${value}  (${source})`)
        .join("\n");
}
