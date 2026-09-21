/*
 * 悬浮预览的几何计算。全部为纯函数，不操作 DOM，便于单独验算。
 *
 * 关键约束：展开的预览区必须盖住指针停留的那张卡片，且 t=0 时与卡片完全重合，
 * 因此卡片的浮起动画与预览的展开动画属于同一段连续运动，而不是两段动画。
 */

import { clamp } from "./animation.ts";

/** 视口内的矩形 */
export interface Box {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface Viewport {
    readonly width: number;
    readonly height: number;
}

/** 卡片或预览区的实际几何。rotate 为角度制 */
export interface Placement {
    readonly centreX: number;
    readonly centreY: number;
    readonly width: number;
    readonly height: number;
    readonly rotate: number;
}

/** 卡片浮起时的位移、缩放与倾斜 */
export interface Pop {
    readonly lift: number;
    readonly scale: number;
    readonly rotate: number;
}

/** 与 SearchPanel 中卡片浮起的样式同源，两处数值需保持一致 */
export const POPPED: Pop = { lift: 4, scale: 1.04, rotate: -1.5 };

/** 预览区相对卡片放大多少、至少多大、最大多大、离视口边留多少 */
const GROW = { width: 1.9, height: 1.2 };
const MIN_SIZE = { width: 420, height: 320 };
const MAX_SIZE = { width: 620, height: 560 };
const VIEWPORT_MARGIN = 16;

/* 预览区内部的排版尺寸。SearchPanel 将其写入 CSS 变量，排版与宽度换算共用这一套数值 */

/** 内边距 */
export const PREVIEW_PADDING = 14;
/** 缩略图与文字列之间的间距 */
export const PREVIEW_GAP = 14;
/** 上游缩略图是竖图，宽高比取 2:3 */
const THUMB_RATIO = 2 / 3;
/** 右侧文字列的最小宽度，宽度不足时加宽预览区 */
const TEXT_MIN_WIDTH = 220;

/** 内容开始出现的展开进度阈值。盒子先成形、内容后进入，缩放过程中的形变因此不明显 */
const CONTENT_FROM = 0.32;

/**
 * 卡片在给定浮起进度下的实际几何。
 * 浮起是绕中心位移加缩放：中心随位移移动，尺寸随缩放变化，据此可将布局盒换算到浮起后的位置。
 */
export function poppedPlacement(box: Box, value: number, pop: Pop = POPPED): Placement {
    const scale = 1 + (pop.scale - 1) * value;
    return {
        centreX: box.left + box.width / 2,
        centreY: box.top + box.height / 2 - pop.lift * value,
        width: box.width * scale,
        height: box.height * scale,
        rotate: pop.rotate * value,
    };
}

/** 旋转 + 缩放之后的轴对齐包围盒。判断是否盖住卡片时按该包围盒计算 */
export function boundingBox(placement: Placement): Box {
    const radians = (placement.rotate * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const width = placement.width * cos + placement.height * sin;
    const height = placement.width * sin + placement.height * cos;
    return {
        left: placement.centreX - width / 2,
        top: placement.centreY - height / 2,
        width,
        height,
    };
}

/**
 * 左侧缩略图的宽度。竖图铺满预览区的内容高度，宽度由此确定，
 * 缩略图可整张放入格子，不会被 cover 裁掉两侧。
 */
export function previewThumbWidth(boxHeight: number): number {
    return Math.round(Math.max(0, boxHeight - PREVIEW_PADDING * 2) * THUMB_RATIO);
}

/** 预览区需容纳缩略图、间距与文字列，宽度不足时加宽盒子 */
function contentMinWidth(height: number): number {
    return PREVIEW_PADDING * 2 + previewThumbWidth(height) + PREVIEW_GAP + TEXT_MIN_WIDTH;
}

/**
 * 展开后的预览区。以卡片为中心放到足够大，尺寸不小于卡片的包围盒，
 * 宽度还要容得下左侧缩略图与右侧文字，位置在「盖住卡片」与「留在视口内」两个区间里取，
 * 两者冲突时偏向盖住卡片
 */
export function previewBox(card: Box, viewport: Viewport): Box {
    const cover = boundingBox(poppedPlacement(card, 1));
    const limitWidth = Math.max(
        cover.width,
        Math.min(MAX_SIZE.width, viewport.width - VIEWPORT_MARGIN * 2),
    );
    const limitHeight = Math.max(
        cover.height,
        Math.min(MAX_SIZE.height, viewport.height - VIEWPORT_MARGIN * 2),
    );
    const height = clamp(
        Math.max(cover.height * GROW.height, MIN_SIZE.height),
        cover.height,
        limitHeight,
    );
    const width = clamp(
        Math.max(cover.width * GROW.width, MIN_SIZE.width, contentMinWidth(height)),
        cover.width,
        limitWidth,
    );
    // 可用的横向区间：左边界不超过卡片左边缘，右边界不超过视口留边，同时必须仍能盖住卡片
    const leftLow = Math.max(VIEWPORT_MARGIN, cover.left + cover.width - width);
    const leftHigh = Math.min(cover.left, viewport.width - VIEWPORT_MARGIN - width);
    const topLow = Math.max(VIEWPORT_MARGIN, cover.top + cover.height - height);
    const topHigh = Math.min(cover.top, viewport.height - VIEWPORT_MARGIN - height);
    return {
        left: clamp(cover.left + cover.width / 2 - width / 2, leftLow, leftHigh),
        top: clamp(cover.top + cover.height / 2 - height / 2, topLow, topHigh),
        width,
        height,
    };
}

/** 从卡片几何到预览区几何的起点差值。预览区按该值变换后，t=0 时正好与卡片重合 */
export interface Handoff {
    readonly dx: number;
    readonly dy: number;
    readonly scaleX: number;
    readonly scaleY: number;
    readonly rotate: number;
}

export function handoff(card: Placement, target: Box): Handoff {
    return {
        dx: card.centreX - (target.left + target.width / 2),
        dy: card.centreY - (target.top + target.height / 2),
        scaleX: card.width / target.width,
        scaleY: card.height / target.height,
        rotate: card.rotate,
    };
}

/**
 * 展开进度 t（0～1）对应的 transform。
 * 位移、旋转、缩放同时线性收敛：三者共用一条缓动曲线，因此 t=0 时与卡片重合、t=1 时归位。
 */
export function morphTransform(from: Handoff, t: number): string {
    const rest = 1 - t;
    const scaleX = from.scaleX + (1 - from.scaleX) * t;
    const scaleY = from.scaleY + (1 - from.scaleY) * t;
    return (
        `translate(${from.dx * rest}px, ${from.dy * rest}px) ` +
        `rotate(${from.rotate * rest}deg) ` +
        `scale(${scaleX}, ${scaleY})`
    );
}

/** 展开进度对应的内容不透明度。收回到一定程度时内容先消失，随后再收起盒子 */
export function contentAlpha(t: number): number {
    return clamp((t - CONTENT_FROM) / (1 - CONTENT_FROM), 0, 1);
}
