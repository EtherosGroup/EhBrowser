/*
 * 手写的补间引擎。搜索卡片的浮起、悬浮预览的展开与收回都走这里。
 * 不用 CSS 过渡的原因：转场随时可能被打断（指针移开、移到另一张卡片、按 Esc），
 * 需要从当前这一帧的数值反向，而 CSS 过渡拿不到「当前值」，只能等它跑完。
 * 每帧只写元素的行内样式，不触发 Vue 重渲染。
 */

/** 缓动曲线，输入输出都是 0～1 的进度 */
export type Easing = (t: number) => number;

/** 起步快、落位稳。出现与放大用 */
export const easeOutCubic: Easing = (t) => 1 - (1 - t) ** 3;

/** 起步慢、收尾快。收回用，越接近卡片越快 */
export const easeInCubic: Easing = (t) => t * t * t;

export interface Tween {
    cancel(): void;
}

export interface TweenOptions {
    /** 毫秒 */
    readonly duration: number;
    readonly easing?: Easing;
    /** 每帧回调，t 为缓动后的进度（0～1） */
    readonly onUpdate: (t: number) => void;
    readonly onDone?: () => void;
}

/** 每帧推进一次。用 requestAnimationFrame 而不是 setTimeout，掉帧时进度跟着时间走 */
export function tween(options: TweenOptions): Tween {
    const easing = options.easing ?? easeOutCubic;
    let start = -1;
    let frame = 0;
    let stopped = false;

    const step = (now: number): void => {
        if (stopped) {
            return;
        }
        // 第一帧只记录起始时间，不推进：起手那一帧的进度为 0，否则首帧会跳过一段缓动
        if (start < 0) {
            start = now;
            frame = requestAnimationFrame(step);
            return;
        }
        const raw = options.duration <= 0 ? 1 : Math.min(1, (now - start) / options.duration);
        options.onUpdate(easing(raw));
        if (raw < 1) {
            frame = requestAnimationFrame(step);
            return;
        }
        options.onDone?.();
    };

    frame = requestAnimationFrame(step);
    return {
        cancel(): void {
            stopped = true;
            cancelAnimationFrame(frame);
        },
    };
}

/** 是否要求减弱动效。要求时所有位移与缩放都直接落到终点 */
export function prefersReducedMotion(): boolean {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** 把 v 收进 [min, max]，两端参数写反时同样可用 */
export function clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, Math.min(min, max)), Math.max(min, max));
}
