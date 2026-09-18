/**
 * 字段级校验与对象工具
 * 仅处理结构：类型、枚举、范围。跨字段约束（如启用代理需填写主机）属于 services 层
 */

export type FieldKind =
    | "string"
    | "int"
    | "number"
    | "boolean"
    | "enum"
    | "stringArray"
    | "enumArray";

export interface FieldSpec {
    /** 点分路径，如 network.proxy.port */
    readonly path: string;
    readonly kind: FieldKind;
    /** 仅 enum / enumArray 使用 */
    readonly values?: readonly string[];
    readonly min?: number;
    readonly max?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    /** 允许缺省，默认必填 */
    readonly optional?: boolean;
}

export interface FieldIssue {
    readonly path: string;
    readonly code: "missing" | "type" | "range" | "enum" | "conflict";
    readonly message: string;
}

export type ValidationResult<T> = { readonly ok: true; readonly value: T } | typeof INVALID;
const INVALID = { ok: false as const, issues: [] as FieldIssue[] };

/** PATCH 用递归可选类型。与 api/dto 同名属有意为之：两层互不引用 */
export type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends readonly unknown[]
        ? T[K]
        : T[K] extends object
          ? DeepPartial<T[K]>
          : T[K];
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取点分路径，不存在时返回 undefined */
export function getAtPath(root: unknown, path: string): unknown {
    let current: unknown = root;
    for (const key of path.split(".")) {
        if (!isPlainObject(current)) {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

/** 写入点分路径，缺失的中间对象自动创建 */
export function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    const last = keys.pop();
    if (last === undefined) {
        return;
    }
    let current: Record<string, unknown> = root;
    for (const key of keys) {
        const next = current[key];
        if (!isPlainObject(next)) {
            const created: Record<string, unknown> = {};
            current[key] = created;
            current = created;
        } else {
            current = next;
        }
    }
    current[last] = value;
}

/** 深合并：仅覆盖 overlay 中出现的键；数组整体替换，不逐项合并 */
export function deepMerge<T>(base: unknown, overlay: unknown): T {
    if (!isPlainObject(base) || !isPlainObject(overlay)) {
        return (overlay === undefined ? base : overlay) as T;
    }
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out as T;
}

/** 返回 patch 中未声明的路径。未声明字段会被原样写入配置文件，因此在入口拦截 */
export function collectUnknownPaths(patch: unknown, known: unknown, prefix = ""): string[] {
    if (!isPlainObject(patch) || !isPlainObject(known)) {
        return [];
    }
    const out: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        if (!(key in known)) {
            out.push(path);
            continue;
        }
        out.push(...collectUnknownPaths(value, known[key], path));
    }
    return out;
}

/** 一次校验一组字段 */
export function validateFields<T = unknown>(
    value: unknown,
    fields: readonly FieldSpec[],
): ValidationResult<T> {
    const issues: FieldIssue[] = [];
    for (const field of fields) {
        const current = getAtPath(value, field.path);
        if (current === undefined || current === null) {
            if (field.optional !== true) {
                issues.push({ path: field.path, code: "missing", message: "缺少该字段" });
            }
            continue;
        }
        const issue = checkField(field, current);
        if (issue !== null) {
            issues.push(issue);
        }
    }
    return issues.length === 0 ? { ok: true, value: value as T } : { ok: false, issues };
}

/** 坏值就地替换为默认值，返回替换项。用于配置损坏时仍可启动 */
export function repairFields(
    target: Record<string, unknown>,
    defaults: unknown,
    fields: readonly FieldSpec[],
): FieldIssue[] {
    const issues: FieldIssue[] = [];
    for (const field of fields) {
        const current = getAtPath(target, field.path);
        if (current === undefined || current === null) {
            if (field.optional !== true) {
                issues.push({ path: field.path, code: "missing", message: "缺少该字段" });
                const fallback = getAtPath(defaults, field.path);
                if (fallback !== undefined) {
                    setAtPath(target, field.path, fallback);
                }
            }
            continue;
        }
        const issue = checkField(field, current);
        if (issue === null) {
            continue;
        }
        issues.push(issue);
        const fallback = getAtPath(defaults, field.path);
        if (fallback !== undefined) {
            setAtPath(target, field.path, fallback);
        }
    }
    return issues;
}

function checkField(field: FieldSpec, current: unknown): FieldIssue | null {
    const bad = (code: FieldIssue["code"], message: string): FieldIssue => ({
        path: field.path,
        code,
        message,
    });

    switch (field.kind) {
        case "string": {
            if (typeof current !== "string") {
                return bad("type", "类型应为字符串");
            }
            if (field.minLength !== undefined && current.length < field.minLength) {
                return bad("range", `长度不应小于 ${field.minLength}`);
            }
            if (field.maxLength !== undefined && current.length > field.maxLength) {
                return bad("range", `长度不应超过 ${field.maxLength}`);
            }
            return null;
        }
        case "int":
        case "number": {
            if (typeof current !== "number" || !Number.isFinite(current)) {
                return bad("type", "类型应为数字");
            }
            if (field.kind === "int" && !Number.isInteger(current)) {
                return bad("type", "类型应为整数");
            }
            if (field.min !== undefined && current < field.min) {
                return bad("range", `数值不应小于 ${field.min}`);
            }
            if (field.max !== undefined && current > field.max) {
                return bad("range", `数值不应大于 ${field.max}`);
            }
            return null;
        }
        case "boolean": {
            return typeof current === "boolean" ? null : bad("type", "类型应为布尔值");
        }
        case "enum": {
            const values = field.values ?? [];
            if (typeof current !== "string" || !values.includes(current)) {
                return bad("enum", `取值必须是 ${values.join(" / ")}`);
            }
            return null;
        }
        case "stringArray": {
            if (!Array.isArray(current) || current.some((item) => typeof item !== "string")) {
                return bad("type", "类型应为字符串数组");
            }
            return null;
        }
        case "enumArray": {
            const values = field.values ?? [];
            if (
                !Array.isArray(current) ||
                current.some((item) => !values.includes(item as string))
            ) {
                return bad("enum", `元素取值必须是 ${values.join(" / ")}`);
            }
            return null;
        }
    }
}
