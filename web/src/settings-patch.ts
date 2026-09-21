/*
 * 设置保存前的两道处理
 * 界面使用的是最新构建产物，服务端可能是「代码更新之前启动、之后一直未重启」的进程：
 * 此时服务端不认识界面新增的字段（例如后加入的 ui.cachedGalleries），
 * 而设置页会把整份 setting 原样回传，服务端因此判定存在未声明字段，整个保存请求都被拒绝，
 * 表现为只改了缓存条数却存不上。
 * 这里做两件事：找出服务端不认识的字段（界面上提示需要重启），保存时把它们剔除。
 * 其余设置仍可正常保存。
 */

/** 界面已知、且加入较晚的字段。服务端缺少这些路径，说明它运行的是旧代码 */
export const REQUIRED_SETTING_PATHS: readonly string[] = [
    "log.enabled",
    "log.directory",
    "ui.cachedGalleries",
];

/** 按点分路径取值；中间缺一层就返回 undefined */
export function getAtPath(value: unknown, path: string): unknown {
    let current: unknown = value;
    for (const key of path.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/** 服务端快照中缺失的、界面已知的字段 */
export function missingPaths(
    setting: unknown,
    paths: readonly string[] = REQUIRED_SETTING_PATHS,
): readonly string[] {
    return paths.filter((path) => getAtPath(setting, path) === undefined);
}

/**
 * 就地删除这些路径，返回同一个对象（调用方拿到的即为将要发出的 body）
 * 只删除路径确实存在的那部分，其余字段不受影响
 */
export function prunePaths<T extends object>(target: T, paths: readonly string[]): T {
    for (const path of paths) {
        const keys = path.split(".");
        const last = keys.pop();
        if (last === undefined) {
            continue;
        }
        let current: unknown = target;
        for (const key of keys) {
            if (current === null || typeof current !== "object" || Array.isArray(current)) {
                current = null;
                break;
            }
            current = (current as Record<string, unknown>)[key];
        }
        if (current !== null && typeof current === "object" && !Array.isArray(current)) {
            delete (current as Record<string, unknown>)[last];
        }
    }
    return target;
}
