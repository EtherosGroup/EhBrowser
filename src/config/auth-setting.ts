/**
 * auth_setting.json 的接线与账号数据操作
 * 文件包含 cookie：权限 0600、不进入日志、对外输出前脱敏
 * 本层仅做数据操作（增删账号、切换激活）；业务规则属于 services
 */

import { join } from "node:path";

import { getPaths } from "../platform/paths.ts";
import { createJsonStore, type JsonStore, type StoreLogger } from "./json-store.ts";
import { AUTH_SETTING_MIGRATIONS } from "./migrations.ts";
import {
    AUTH_SETTING_DEFAULTS,
    AUTH_SETTING_FIELDS,
    type Account,
    type AuthSetting,
    type EhCookies,
} from "./schema.ts";

export const AUTH_SETTING_FILENAME = "auth_setting.json";

export function authSettingFile(configDir: string = getPaths().configDir): string {
    return join(configDir, AUTH_SETTING_FILENAME);
}

export function createAuthSettingStore(
    options: { file?: string; logger?: StoreLogger } = {},
): JsonStore<AuthSetting> {
    return createJsonStore<AuthSetting>({
        file: options.file ?? authSettingFile(),
        defaults: AUTH_SETTING_DEFAULTS,
        fields: AUTH_SETTING_FIELDS,
        migrations: AUTH_SETTING_MIGRATIONS,
        mode: 0o600,
        logger: options.logger,
    });
}

/** cookie 是否完整。结构校验属于 schema，此处仅检查取值 */
export function isCompleteCookies(cookies: EhCookies): boolean {
    return (
        cookies.ipbMemberId.trim() !== "" &&
        cookies.ipbPassHash.trim() !== "" &&
        cookies.igneous.trim() !== ""
    );
}

/** igneous 有效期；超过一半视为临近过期 */
export const IGNEOUS_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 已存在的天数，无记录返回 null */
export function igneousAgeDays(account: Account | null, now = Date.now()): number | null {
    if (account === null || account.igneousUpdatedAt === null) {
        return null;
    }
    return Math.floor((now / 1000 - account.igneousUpdatedAt) / 86400);
}

/** 超过半个有效期即视为临近过期 */
export function isIgneousStale(account: Account | null, now = Date.now()): boolean {
    const age = igneousAgeDays(account, now);
    if (age === null) {
        return false;
    }
    return age * 86400 > IGNEOUS_TTL_SECONDS * 0.5;
}

/** 未指定时取第一个 */
export function activeAccount(auth: AuthSetting): Account | null {
    if (auth.activeAccountId === null) {
        return auth.accounts[0] ?? null;
    }
    return auth.accounts.find((item) => item.id === auth.activeAccountId) ?? null;
}

/** 对外摘要；输出到服务端的字段仅限这些 */
export function summarizeAccount(auth: AuthSetting, account: Account): Record<string, unknown> {
    return {
        id: account.id,
        label: account.label,
        site: account.site,
        active: activeAccount(auth)?.id === account.id,
        igneousUpdatedAt: account.igneousUpdatedAt,
        hasApiKey: account.apiKey !== undefined,
    };
}

/** 日志用；cookie 仅保留长度 */
export function redactAuth(auth: AuthSetting): Record<string, unknown> {
    return {
        schemaVersion: auth.schemaVersion,
        activeAccountId: auth.activeAccountId,
        accounts: auth.accounts.map((account) => ({
            id: account.id,
            label: account.label,
            site: account.site,
            igneousLength: account.cookies.igneous.length,
            igneousUpdatedAt: account.igneousUpdatedAt,
        })),
        proxyAuth: auth.proxyAuth.username === "" ? "(空)" : "(有)",
    };
}

/** 已存在时替换，否则追加 */
export function upsertAccount(accounts: readonly Account[], account: Account): readonly Account[] {
    const index = accounts.findIndex((item) => item.id === account.id);
    if (index === -1) {
        return [...accounts, account];
    }
    const next = [...accounts];
    next[index] = account;
    return next;
}

export function removeAccount(accounts: readonly Account[], id: string): readonly Account[] {
    return accounts.filter((item) => item.id !== id);
}

/** 随机标识；用户名可重复且可变更，不适合作为 id */
export function newAccountId(): string {
    return `acc_${Math.random().toString(36).slice(2, 10)}`;
}
