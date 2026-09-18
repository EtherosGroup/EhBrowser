/**
 * 版本迁移。当前均为 v1，迁移链为空
 * 约定：迁移前备份；文件版本高于程序时只读；migrate 为纯函数
 */

import { AUTH_SETTING_VERSION, USER_SETTING_VERSION } from "./schema.ts";

export interface Migration {
    readonly from: number;
    readonly to: number;
    /** 纯函数，不做 IO，便于单测 */
    migrate(data: Record<string, unknown>): Record<string, unknown>;
}

export interface MigrationOutcome {
    readonly data: Record<string, unknown>;
    /** 实际跑了哪些步，用来决定要不要写回文件 */
    readonly applied: readonly number[];
}

/** 结构变更示例
 *  { from: 1, to: 2, migrate: (data) => ({ ...data, schemaVersion: 2, 新字段: 默认值 }) }
 */
export const USER_SETTING_MIGRATIONS: readonly Migration[] = [];

export const AUTH_SETTING_MIGRATIONS: readonly Migration[] = [];

export const CURRENT_VERSIONS = {
    user: USER_SETTING_VERSION,
    auth: AUTH_SETTING_VERSION,
} as const;

export type SettingFile = keyof typeof CURRENT_VERSIONS;

export function migrationsFor(file: SettingFile): readonly Migration[] {
    return file === "user" ? USER_SETTING_MIGRATIONS : AUTH_SETTING_MIGRATIONS;
}

/** 将 data.schemaVersion 升至 target。缺失步骤直接抛错，避免写入不完整数据 */
export function runMigrations(
    data: Record<string, unknown>,
    target: number,
    migrations: readonly Migration[],
): MigrationOutcome {
    let current = data;
    let version = readVersion(current);
    const applied: number[] = [];

    while (version < target) {
        const step = migrations.find((m) => m.from === version);
        if (step === undefined) {
            throw new Error(`没有 v${version} → 更上层的迁移步骤，代码里的版本是 v${target}`);
        }
        current = step.migrate(current);
        version = step.to;
        applied.push(step.to);
    }

    return { data: current, applied };
}

/** 无法读取版本号时按 1 处理 */
export function readVersion(data: Record<string, unknown>): number {
    const raw = data["schemaVersion"];
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}
