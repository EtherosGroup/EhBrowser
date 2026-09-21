/*
 * 弹出消息。对 vue3-toastify 的 toast 做一层薄封装，固定参数集中在此处。
 * 合并顺序为通用固定值 -> 类型固定值 -> 调用方 options，越靠后优先级越高。
 * 统一经模块级单例 messenger 调用，避免与库自带的 toast.success 等混淆。
 *
 * 错误提示不自动关闭：内容往往较长，点击整条把错误信息复制到剪贴板。
 *
 * 用法：
 * messenger.success("已保存")
 * messenger.error("上游不可达")
 */

import {
    toast,
    type Content,
    type Id,
    type ToastOptions,
    type ToastPromiseParams,
    type UpdateOptions,
} from "vue3-toastify";

import { copyText } from "./clipboard.ts";

/** 所有消息共用的固定参数 */
const COMMON_OPTIONS: ToastOptions = {
    closeOnClick: true,
    pauseOnHover: true,
};

/** 各类型的固定参数。统一调整停留时长只改这里 */
const FIXED_OPTIONS = {
    success: { autoClose: 2500 },
    info: { autoClose: 3000 },
    warning: { autoClose: 4000 },
    // 错误需要留到读完；点击由复制接管，因此不关闭
    error: { autoClose: false, closeOnClick: false },
    loading: { autoClose: false },
} satisfies Record<string, ToastOptions>;

/** 复制结果提示的固定 id */
const COPY_FEEDBACK_ID = "error-copied";

/** 成功提示 */
function success(content: Content, options?: ToastOptions): Id {
    return toast.success(content, { ...COMMON_OPTIONS, ...FIXED_OPTIONS.success, ...options });
}

/**
 * 错误提示。不自动关闭，点击整条复制错误信息
 * content 不是字符串时没有可复制的文本，只做展示
 */
function error(content: Content, options?: ToastOptions): Id {
    const plain = typeof content === "string" ? content : "";
    return toast.error(content, {
        ...COMMON_OPTIONS,
        ...FIXED_OPTIONS.error,
        ...(plain === "" ? {} : { onClick: () => void copyError(plain) }),
        ...options,
    });
}

/** 复制错误信息并回报结果。提示固定 toastId，连续点击只刷新同一条 */
async function copyError(text: string): Promise<void> {
    if (await copyText(text)) {
        success("错误信息已复制", { toastId: COPY_FEEDBACK_ID, autoClose: 1500 });
        return;
    }
    warning("复制失败，请手动选中文本", { autoClose: 3000 });
}

/** 警告提示 */
function warning(content: Content, options?: ToastOptions): Id {
    return toast.warning(content, { ...COMMON_OPTIONS, ...FIXED_OPTIONS.warning, ...options });
}

/** 信息提示 */
function info(content: Content, options?: ToastOptions): Id {
    return toast.info(content, { ...COMMON_OPTIONS, ...FIXED_OPTIONS.info, ...options });
}

/** 进行中提示，不自动关闭。收尾用 update 换成结果提示 */
function loading(content: Content, options?: ToastOptions): Id {
    return toast.loading(content, { ...COMMON_OPTIONS, ...FIXED_OPTIONS.loading, ...options });
}

/** 把字符串或 UpdateOptions 统一为带固定参数的形式，供 promise 各阶段使用 */
function stage<T>(
    spec: string | UpdateOptions<T> | undefined,
    fixed: Omit<ToastOptions, "data">,
): UpdateOptions<T> | undefined {
    if (spec === undefined) {
        return undefined;
    }
    return typeof spec === "string" ? { render: spec, ...fixed } : { ...fixed, ...spec };
}

/**
 * 异步流程提示：进行中自动切到成功或失败
 * 三个阶段的配置都可省略；返回的是原 Promise，失败时 await 依然会抛出
 */
function promise<T = unknown>(
    input: Promise<T> | (() => Promise<T>),
    params: ToastPromiseParams<T>,
    options?: ToastOptions,
): Promise<T> {
    return toast.promise(
        input,
        {
            pending: params.pending,
            success: stage(params.success, FIXED_OPTIONS.success),
            error: stage(params.error, FIXED_OPTIONS.error),
        },
        { ...COMMON_OPTIONS, ...options },
    );
}

/**
 * 更新已存在的提示，常用于把 loading 收尾为结果
 * 库的 update 会把新选项合并到旧选项上，loading 自带的 isLoading 需显式覆盖，否则不会自动关闭
 */
function update(toastId: Id, options?: UpdateOptions): void {
    toast.update(toastId, { isLoading: false, ...options });
}

/** 指定提示是否仍在显示 */
function isActive(toastId: Id): boolean {
    return toast.isActive(toastId);
}

/** 关闭指定提示。不传 id 则关闭全部 */
function remove(toastId?: Id): void {
    toast.remove(toastId);
}

/** 关闭全部提示 */
function clearAll(containerId?: Id, withExitAnimation?: boolean): void {
    toast.clearAll(containerId, withExitAnimation);
}

/** 位置常量，避免手写字符串 */
export const POSITION = toast.POSITION;

/** 主题常量 */
export const THEME = toast.THEME;

/** 类型常量 */
export const TYPE = toast.TYPE;

/** 消息提示单例。无状态，可在任意模块使用 */
export const messenger = {
    success,
    error,
    warning,
    info,
    loading,
    promise,
    update,
    isActive,
    remove,
    clearAll,
    POSITION,
    THEME,
    TYPE,
} as const;
