/**
 * 数据目录解析
 * 三条根目录：config（配置与 Cookie）、data（数据库、下载、日志）、cache（缩略图等可再生成数据）
 * 优先级由高到低：initPaths 显式覆盖 > EHBROWSER_*_DIR > EHBROWSER_HOME 便携模式 > 系统默认
 * 本模块仅解析路径，不创建目录；创建由 ensureDirs 负责
 */

import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { isWindows, platform } from "./os.ts";

/** 各平台统一使用的目录名 */
export const APP_DIR_NAME = "ehbrowser";

/** 三条根目录 */
export interface PathRoots {
    readonly configDir: string;
    readonly dataDir: string;
    readonly cacheDir: string;
}

/** 显式覆盖，通常来自 CLI 参数；相对路径按当前工作目录解析 */
export interface PathOverrides {
    readonly configDir?: string;
    readonly dataDir?: string;
    readonly cacheDir?: string;
}

/** 取值来源，用于诊断 */
export type PathSource = "override" | "env" | "portable-home" | "os-default";

export interface ResolvedPaths extends PathRoots {
    readonly sources: Readonly<Record<keyof PathRoots, PathSource>>;
}

const CACHE_SUBDIR = "cache";
/** 目录权限 0700，树下含 Cookie */
const DIR_MODE = 0o700;

let cached: ResolvedPaths | null = null;

// 空字符串按未设置处理
function readEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    return value === "" ? undefined : value;
}

// 展开 ~ 与 ~/…，其余原样返回
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
            // Windows 无独立缓存约定，缓存置于 data 下
            cacheDir: join(local, APP_DIR_NAME, CACHE_SUBDIR),
        };
    }

    if (platform === "macos") {
        // macOS 惯例：配置与数据同放 Application Support，缓存单独置于 Caches
        const support = join(homedir(), "Library", "Application Support", APP_DIR_NAME);
        return {
            configDir: support,
            dataDir: support,
            cacheDir: join(homedir(), "Library", "Caches", APP_DIR_NAME),
        };
    }

    // 遵循 XDG。XDG_*_HOME 常常未设置，须回退到 ~/.config 等默认值，
    // 否则会拼出 undefined/ehbrowser 这样的路径
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

/** 解析并缓存；重复调用会按最新参数与环境变量重新解析 */
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

/** 取缓存结果，未解析时先解析一次 */
export function getPaths(): ResolvedPaths {
    return cached ?? initPaths();
}

/** 清空缓存，供测试使用；下次 getPaths 重新读取环境变量 */
export function resetPaths(): void {
    cached = null;
}

/**
 * 创建三条根目录。POSIX 下将已存在目录的权限收紧至 0700（树下含 Cookie）
 * Windows 上 chmod 无效，跳过
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

/** 打印三条根目录及其来源，用于诊断 */
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
