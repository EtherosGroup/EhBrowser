/*
 * config 层的门面。
 */

import { ensureDirs, getPaths, type ResolvedPaths } from "../platform/paths.ts";
import { authSettingFile, createAuthSettingStore } from "./auth-setting.ts";
import { databaseFile, openDatabase, type DbHandle } from "./db.ts";
import type { JsonStore, StoreLogger } from "./json-store.ts";
import type { AuthSetting, UserSetting } from "./schema.ts";
import { createUserSettingStore, userSettingFile } from "./user-setting.ts";

export interface ConfigContext {
    readonly paths: ResolvedPaths;
    readonly user: JsonStore<UserSetting>;
    readonly auth: JsonStore<AuthSetting>;
    readonly db: DbHandle;
    /** 退出时调用：刷写待写数据并关闭数据库。 */
    close(): Promise<void>;
}

export interface InitConfigOptions {
    /** 测试可指向临时目录，由 platform 的 initPaths({...}) 构造 */
    readonly paths?: ResolvedPaths;
    /** 不传时输出到 console。 */
    readonly logger?: StoreLogger;
}

export async function initConfig(options: InitConfigOptions = {}): Promise<ConfigContext> {
    const paths = options.paths ?? getPaths();
    const logger = options.logger ?? consoleLogger;

    await ensureDirs(paths);

    const user = createUserSettingStore({ file: userSettingFile(paths.configDir), logger });
    const auth = createAuthSettingStore({ file: authSettingFile(paths.configDir), logger });

    // 并行加载；文件损坏时回退默认值，不阻塞启动。
    await Promise.all([user.load(), auth.load()]);

    const db = openDatabase(databaseFile(paths.dataDir));
    db.setMeta("last_started_at", String(Math.floor(Date.now() / 1000)));
    db.setMeta("user_setting_version", String(user.get().schemaVersion));

    return {
        paths,
        user,
        auth,
        db,
        async close() {
            await Promise.all([user.flush(), auth.flush()]);
            db.close();
        },
    };
}

const consoleLogger: StoreLogger = (level, message, meta) => {
    const line = `[config] ${message}`;
    if (level === "error") {
        console.error(line, meta ?? "");
    } else if (level === "warn") {
        console.warn(line, meta ?? "");
    } else {
        console.info(line, meta ?? "");
    }
};

export { createJsonStore, ConfigInvalidError } from "./json-store.ts";
export type { JsonStore, JsonStoreOptions, StoreLogger } from "./json-store.ts";
export { describePaths, getPaths, initPaths, resetPaths } from "../platform/paths.ts";
export * from "./schema.ts";
export {
    activeAccount,
    igneousAgeDays,
    isCompleteCookies,
    isIgneousStale,
    newAccountId,
    redactAuth,
    removeAccount,
    summarizeAccount,
    upsertAccount,
} from "./auth-setting.ts";
export { databaseFile, DB_FILENAME, openDatabase } from "./db.ts";
export type { DbHandle } from "./db.ts";
export { createUserSettingStore, USER_SETTING_FILENAME, userSettingFile } from "./user-setting.ts";
export { authSettingFile, AUTH_SETTING_FILENAME, createAuthSettingStore } from "./auth-setting.ts";
