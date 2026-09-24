/*
 * 内置翻译表与词库的查询。纯逻辑：不依赖 vue，也不发请求，便于单独验证。
 * 查询顺序：词库 -> 内置表 -> 原文。词库未装载时全部回落到内置表。
 * 装载时另外建一份反查索引，供搜索框按输入内容找标签（searchTags）。
 */

import type { TranslateDatabase } from "../../src/api/index.ts";

/** 类别全量翻译，键与 GALLERY_CATEGORIES 一致 */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
    Doujinshi: "同人志",
    Manga: "漫画",
    "Artist CG": "画师 CG",
    "Game CG": "游戏 CG",
    Western: "欧美",
    "Image Set": "图集",
    "Non-H": "无色情内容",
    Cosplay: "角色扮演",
    "Asian Porn": "亚洲成人",
    Misc: "其他",
    Private: "私有",
};

/** 命名空间全量翻译 */
export const NAMESPACE_LABELS: Readonly<Record<string, string>> = {
    language: "语言",
    parody: "原作",
    character: "角色",
    group: "社团",
    artist: "画师",
    cosplayer: "扮演者",
    male: "男性",
    female: "女性",
    mixed: "混合",
    other: "其他",
    reclass: "重分类",
    temp: "临时",
    rows: "行",
};

/** 高频标签名翻译。键为不带命名空间的标签名 */
export const TAG_LABELS: Readonly<Record<string, string>> = {
    // 语言 / 来源
    chinese: "中文",
    english: "英语",
    japanese: "日语",
    korean: "韩语",
    spanish: "西班牙语",
    french: "法语",
    german: "德语",
    italian: "意大利语",
    portuguese: "葡萄牙语",
    russian: "俄语",
    thai: "泰语",
    vietnamese: "越南语",
    dutch: "荷兰语",
    hungarian: "匈牙利语",
    polish: "波兰语",
    translated: "已翻译",
    rewrite: "重写",
    "rough translation": "粗翻",
    "ai generated": "AI 生成",
    "ai translated": "AI 翻译",

    // 审查 / 画面
    uncensored: "无修正",
    "mosaic censorship": "马赛克",
    "full censorship": "全遮罩",
    "no censorship": "无审查",
    "no mosaic": "无马赛克",
    "no text": "无文字",
    webtoon: "条漫",
    fullcolor: "全彩",
    "full color": "全彩",
    sample: "样张",
    animated: "动图",
    "3d": "3D",
    "3d imageset": "3D 图集",
    "non-h": "无色情内容",
    "story arc": "篇章",

    // 篇幅 / 分卷
    tankoubon: "单行本",
    compilation: "合集",
    "multi-work series": "多篇系列",
    "multi-work": "多篇系列",
    soushuuhen: "总集篇",
    oneshot: "短篇",
    webcomic: "网络漫画",
    artbook: "画集",
    anthology: "选集",
    novel: "小说",
    game: "游戏",

    // 女性向身体特征
    "big breasts": "巨乳",
    "small breasts": "贫乳",
    "huge breasts": "爆乳",
    "flat chest": "平胸",
    oppai: "巨乳",
    "inverted nipples": "凹陷乳头",
    "big nipples": "大乳头",
    "puffy nipples": "凸乳首",
    hairy: "有毛",
    "pubic hair": "阴毛",
    thick: "粗壮",
    muscle: "肌肉",
    tanlines: "晒痕",
    "dark skin": "深肤色",
    gyaru: "辣妹",
    pregnant: "怀孕",
    lactation: "泌乳",
    squirting: "潮吹",
    sweating: "出汗",
    smell: "气味",
    kemonomimi: "兽耳",
    "animal ears": "兽耳",
    tail: "尾巴",
    "monster girl": "魔物娘",
    giantess: "巨大娘",

    // 服装 / 场景
    stockings: "丝袜",
    pantyhose: "连裤袜",
    "thigh highs": "过膝袜",
    "schoolgirl uniform": "女学生制服",
    "school uniform": "校服",
    maid: "女仆",
    "bunny girl": "兔女郎",
    nurse: "护士",
    kimono: "和服",
    yukata: "浴衣",
    miko: "巫女",
    swimsuit: "泳装",
    bikini: "比基尼",
    "school swimsuit": "学校泳装",
    latex: "乳胶",
    leotard: "紧身衣",
    bodysuit: "连体衣",
    "high heels": "高跟鞋",
    glasses: "眼镜",
    bondage: "捆绑",
    blindfold: "眼罩",
    collar: "项圈",
    leash: "牵引绳",
    gag: "口塞",
    crotchless: "开裆",
    "no panties": "无内裤",
    underwear: "内衣",
    lingerie: "情趣内衣",
    cosplay: "角色扮演",
    pool: "泳池",
    onsen: "温泉",
    "public use": "公共场合",

    // 行为
    "sole female": "单一女性",
    "sole male": "单一男性",
    "sole dickgirl": "单一扶她",
    "sole futa": "单一扶她",
    "males only": "仅男性",
    "females only": "仅女性",
    yaoi: "男同",
    yuri: "女同",
    futanari: "扶她",
    "dickgirl on male": "扶她×男",
    "dickgirl on dickgirl": "扶她×扶她",
    tomgirl: "伪娘",
    crossdressing: "变装",
    femboy: "男娘",
    "gender bender": "性别转换",
    netorare: "NTR",
    cheating: "出轨",
    netorase: "绿帽",
    group: "群交",
    threesome: "3P",
    "mmm threesome": "男男男 3P",
    "ffm threesome": "女女男 3P",
    "fft threesome": "女女扶她 3P",
    nakadashi: "内射",
    creampie: "内射",
    anal: "肛门",
    "anal intercourse": "肛交",
    "double anal": "双插肛",
    "double penetration": "双插",
    "vaginal sex": "性交",
    oral: "口交",
    blowjob: "口交",
    deepthroat: "深喉",
    handjob: "手交",
    footjob: "足交",
    titjob: "乳交",
    paizuri: "乳交",
    masturbation: "自慰",
    exhibitionism: "露出",
    humiliation: "羞辱",
    rape: "强暴",
    forniphilia: "家具化",
    femdom: "女性主导",
    maledom: "男性主导",
    bdsm: "BDSM",
    tickling: "挠痒",
    scat: "粪便",
    enema: "灌肠",
    urination: "放尿",
    bestiality: "兽交",
    insect: "昆虫",
    tentacles: "触手",
    monster: "怪物",
    "unusual insertions": "异物插入",
    "sex toys": "性玩具",
    "nipple stimulation": "乳头刺激",
    cunnilingus: "舔阴",
    facesitting: "坐脸",
    "x-ray": "透视",
    "hidden sex": "隐奸",
    "big penis": "巨根",
    "small penis": "小阴茎",
    "huge penis": "巨根",
    mosaic: "马赛克",
    "breast feeding": "哺乳",
    ahegao: "潮红脸",
    incest: "近亲",
    impregnation: "播种",
    lolicon: "萝莉",
    shotacon: "正太",
    furry: "兽人",
    vore: "吞食",
    amputee: "截肢",
    farts: "放屁",
    vtuber: "虚拟主播",
    ffm: "女女男",
};

/** 已装入的词库：命名空间 -> { 命名空间名，标签表 } */
let namespaces: TranslateDatabase["namespaces"] | null = null;
/** 无法确定命名空间时的兜底索引。同名标签在不同命名空间里译法不同的极少，这里取其一 */
let flatTags: Readonly<Record<string, string>> = {};

/** 搜索用的一条标签 */
export interface TagSuggestion {
    /** 命名空间原文（如 male）；内置表里的条目没有命名空间，为空串 */
    readonly namespace: string;
    /** 标签原文，一律小写 */
    readonly raw: string;
    /** 中文名 */
    readonly label: string;
}

/** 一次最多给多少条建议。多了要滚动，太多也看不过来 */
export const SUGGEST_LIMIT = 12;

interface IndexedTag extends TagSuggestion {
    /** 小写后的中文名，供匹配用。原本没有大写字母时与 label 是同一个字符串 */
    readonly folded: string;
}

/** 反查索引：词库的全部标签加内置表里词库没有的那些 */
let index: readonly IndexedTag[] = [];

/** 大写字母。中文名基本没有大写，有才需要另存一份小写副本 */
const UPPERCASE = /[A-Z]/;

/** 汉字。用来判断用户是在写译名还是在写原文 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 替换词库。传入 null 表示回到内置表 */
export function setDatabase(database: TranslateDatabase | null): void {
    namespaces = database?.namespaces ?? null;
    const flat: Record<string, string> = {};
    const entries: IndexedTag[] = [];
    const named = new Set<string>();
    for (const [namespace, item] of Object.entries(database?.namespaces ?? {})) {
        for (const [raw, label] of Object.entries(item.tags)) {
            flat[raw] ??= label;
            named.add(raw);
            entries.push({
                namespace,
                raw,
                label,
                folded: UPPERCASE.test(label) ? label.toLowerCase() : label,
            });
        }
    }
    // 内置表补齐词库里没有的条目（词库没装时整份索引就只有它），命名空间留空
    for (const [raw, label] of Object.entries(TAG_LABELS)) {
        if (named.has(raw)) {
            continue;
        }
        entries.push({
            namespace: "",
            raw,
            label,
            folded: UPPERCASE.test(label) ? label.toLowerCase() : label,
        });
    }
    flatTags = flat;
    index = entries;
}

/** 类别。类别不在词库中，只有内置表 */
export function categoryText(name: string): string {
    return CATEGORY_LABELS[name] ?? name;
}

/** 命名空间名 */
export function namespaceText(name: string): string {
    return namespaces?.[name]?.label ?? NAMESPACE_LABELS[name] ?? name;
}

/** 标签名。给出命名空间时按命名空间查词库，更准确；未给出时查兜底索引 */
export function tagText(name: string, namespace = ""): string {
    const key = name.toLowerCase();
    const fromDatabase = namespace === "" ? flatTags[key] : namespaces?.[namespace]?.tags[key];
    return fromDatabase ?? TAG_LABELS[key] ?? TAG_LABELS[name] ?? name;
}

/**
 * 按输入内容找标签。中文名与原文都比一遍，因此「男」与「fem」都能找到东西。
 * 输入的写法决定谁优先：写中文时是在找译名（先比中文名），写拉丁字母时是在写原文
 * （先比原文），这样 fem 不会先给出一堆中文名里带 fem 的条目。
 * 同档按译名长短与原文长短排，短的在前（「男娘」排在「男爵領」之前）。
 * 输入里带冒号时（如 male:fem 或 male:）按命名空间缩小范围，与上游的检索写法一致。
 */
export function searchTags(query: string, limit = SUGGEST_LIMIT): readonly TagSuggestion[] {
    const needle = query.trim().toLowerCase();
    if (needle === "" || limit <= 0) {
        return [];
    }
    const at = needle.indexOf(":");
    const scope = at === -1 ? "" : needle.slice(0, at);
    // 只输到冒号（male:）时列出该命名空间下的标签
    const name = at === -1 ? needle : needle.slice(at + 1);
    const byLabel = CJK.test(needle);

    const hits: { entry: IndexedTag; rank: number }[] = [];
    for (const entry of index) {
        if (scope !== "" && !entry.namespace.startsWith(scope)) {
            continue;
        }
        const inLabel = entry.folded.indexOf(name);
        const inRaw = entry.raw.indexOf(name);
        if (inLabel === -1 && inRaw === -1) {
            continue;
        }
        // 0/1 开头命中，2/3 中间命中；两种写法各自的优先级见上面的注释
        const first = byLabel ? [inLabel, inRaw] : [inRaw, inLabel];
        const rank = first[0] === 0 ? 0 : first[0] !== -1 ? 1 : first[1] === 0 ? 2 : 3;
        hits.push({ entry, rank });
    }
    hits.sort(
        (a, b) =>
            a.rank - b.rank ||
            a.entry.label.length - b.entry.label.length ||
            a.entry.raw.length - b.entry.raw.length ||
            (a.entry.raw < b.entry.raw ? -1 : a.entry.raw > b.entry.raw ? 1 : 0),
    );
    return hits.slice(0, limit).map(({ entry }) => ({
        namespace: entry.namespace,
        raw: entry.raw,
        label: entry.label,
    }));
}

/** 建议项的展示文本：译名（命名空间: 原文） */
export function suggestionText(item: TagSuggestion): string {
    return `${item.label}（${item.namespace === "" ? item.raw : `${item.namespace}: ${item.raw}`}）`;
}

/** 建议项点进输入框时写入的检索词：空格加引号，尾部 $ 表示精确匹配这个标签 */
export function suggestionQuery(item: TagSuggestion): string {
    const name = item.raw.includes(" ") ? `"${item.raw}"` : item.raw;
    return `${item.namespace === "" ? name : `${item.namespace}:${name}`}$`;
}
