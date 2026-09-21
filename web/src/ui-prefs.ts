/*
 * 界面偏好。模块级单例：搜索页、本地画廊、收藏页的网格共用同一份。
 * 只存在于本次会话中，不写入配置，因为它属于临时调整而不是长期设置。
 */

import { ref } from "vue";

/** 每行显示的列数；0 表示按最小宽度自适应 */
export const gridColumns = ref(0);

/** 可选的每行列数 */
export const GRID_COLUMN_CHOICES = [0, 2, 3, 4, 5, 6, 8] as const;

/** 界面显示的文案 */
export function columnsLabel(value: number): string {
    return value === 0 ? "自动" : `${value} 个`;
}
