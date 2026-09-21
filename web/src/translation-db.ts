/*
 * 内置翻译表与词库的查询。纯逻辑：不依赖 vue，也不发请求，便于单独验证。
 * 查询顺序：词库 -> 内置表 -> 原文。词库未装载时全部回落到内置表。
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

/** 替换词库。传入 null 表示回到内置表 */
export function setDatabase(database: TranslateDatabase | null): void {
    namespaces = database?.namespaces ?? null;
    const flat: Record<string, string> = {};
    for (const item of Object.values(database?.namespaces ?? {})) {
        for (const [raw, name] of Object.entries(item.tags)) {
            flat[raw] ??= name;
        }
    }
    flatTags = flat;
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
