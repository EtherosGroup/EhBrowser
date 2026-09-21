/*
 * 详情页多选的标签 -> 搜索框里的一行关键词
 * 上游的标签搜索语法，与官方搜索规则一致：
 *   - `namespace:tag` 只搜标签；不带命名空间则在标题与标签里都找
 *   - 空格分隔的多个词条是「同时满足」；`-` 前缀表示排除
 *   - 标签里有空格必须用双引号包起来，否则会被当成两个词条
 *     （f:big breasts 表示「f:big 且 breasts」，与 f:"big breasts" 不同）
 *   - 词条末尾的 `$` 表示必须是这个标签本身，不做前缀匹配
 *     （c:sakura$ 不会命中 c:sakura kinomoto）
 * 因此每个选中的标签都写成 `namespace:"多词标签"$`，只匹配这一个标签
 */

/** 上游一次最多识别这么多词条，超出的词条会被忽略（官方搜索规则） */
export const TAG_TERM_LIMIT = 8;

/** 单个标签 -> 一个词条。空标签返回空串，由调用方过滤 */
export function tagTerm(tag: string): string {
    const text = tag.trim();
    if (text === "") {
        return "";
    }
    const at = text.indexOf(":");
    const namespace = at === -1 ? "" : text.slice(0, at).trim();
    const name = (at === -1 ? text : text.slice(at + 1)).trim();
    if (name === "") {
        return "";
    }
    // 标签本身含引号时将其去掉：保留会破坏整个查询，上游也不支持转义
    const quoted = /[\s"]/.test(name) ? `"${name.replaceAll('"', "")}"` : name;
    return `${namespace === "" ? "" : `${namespace}:`}${quoted}$`;
}

/** 多个标签 -> 搜索框里的一行。顺序按用户点选的顺序，便于对照 */
export function tagQuery(tags: readonly string[]): string {
    return tags
        .map(tagTerm)
        .filter((term) => term !== "")
        .join(" ");
}
