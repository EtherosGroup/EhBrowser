/** user_setting.json 的接线，不含业务逻辑 */

import { join } from "node:path";

import { getPaths } from "../platform/paths.ts";
import { createJsonStore, type JsonStore, type StoreLogger } from "./json-store.ts";
import { USER_SETTING_MIGRATIONS } from "./migrations.ts";
import { USER_SETTING_DEFAULTS, USER_SETTING_FIELDS, type UserSetting } from "./schema.ts";

export const USER_SETTING_FILENAME = "user_setting.json";

export function userSettingFile(configDir: string = getPaths().configDir): string {
    return join(configDir, USER_SETTING_FILENAME);
}

/** 0644：不含密钥，允许用户直接编辑或分享 */
export function createUserSettingStore(
    options: { file?: string; logger?: StoreLogger } = {},
): JsonStore<UserSetting> {
    return createJsonStore<UserSetting>({
        file: options.file ?? userSettingFile(),
        defaults: USER_SETTING_DEFAULTS,
        fields: USER_SETTING_FIELDS,
        migrations: USER_SETTING_MIGRATIONS,
        mode: 0o644,
        logger: options.logger,
    });
}
