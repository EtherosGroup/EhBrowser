// 数据目录解析
// 三条根：config（配置 + cookie，丢了要重配）/ data（库、下载、日志）/ cache（缩略图，随便删）
// 优先级从高到低：initPaths 传的覆盖 > EHBROWSER_*_DIR > EHBROWSER_HOME 便携模式 > 系统默认
// 这儿只算路径不建目录。建目录是 ensureDirs 的事，别在 import 的时候就动手

import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { isWindows, platform } from "./os.ts";

/** 各平台都叫这个 */
export const APP_DIR_NAME = "ehbrowser";

/** 三条根 */
export interface PathRoots {
    readonly configDir: string;
    readonly dataDir: string;
    readonly cacheDir: string;
}

/** 显式覆盖，一般来自 CLI 参数。相对路径按当前 cwd 算 */
export interface PathOverrides {
    readonly configDir?: string;
    readonly dataDir?: string;
    readonly cacheDir?: string;
}

/** 这个值哪来的，排错的时候看 */
export type PathSource = "override" | "env" | "portable-home" | "os-default";

export interface ResolvedPaths extends PathRoots {
    readonly sources: Readonly<Record<keyof PathRoots, PathSource>>;
}

const CACHE_SUBDIR = "cache";
/** 0700，这棵树里有 cookie */
const DIR_MODE = 0o700;

let cached: ResolvedPaths | null = null;

// 空串当没设，不然能拼出个空路径
function readEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    return value === "" ? undefined : value;
}

// 认 ~ 和 ~/xxx，别的原样返回
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
            // Windows 没有单独的 cache 约定，跟 data 放一起
            cacheDir: join(local, APP_DIR_NAME, CACHE_SUBDIR),
        };
    }

    if (platform === "macos") {
        // macOS 的规矩：配置和数据都在 Application Support，缓存单独扔 Caches
        const support = join(homedir(), "Library", "Application Support", APP_DIR_NAME);
        return {
            configDir: support,
            dataDir: support,
            cacheDir: join(homedir(), "Library", "Caches", APP_DIR_NAME),
        };
    }

    // XDG。注意 XDG_*_HOME 经常压根没设（本机就没设），必须回退到 ~/.config 这些，
    // 不然会拼出 "undefined/ehbrowser" 这种鬼路径
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

/** 算一遍并缓存。再调一次会拿最新的参数和环境变量重算 */
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

/** 拿缓存的，没有就算一次 */
export function getPaths(): ResolvedPaths {
    return cached ?? initPaths();
}

/** 清缓存，测试用。下次 getPaths 会重新读环境变量 */
export function resetPaths(): void {
    cached = null;
}

/**
 * 建目录。POSIX 下顺手把已存在的也收回 0700（里面要放 cookie）
 * Windows 上 chmod 没用，跳过
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

/** 打印三条根和各自的来源，排错用 */
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
