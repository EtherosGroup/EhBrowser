/*
 * 关键词组：新建、改名、整份替换词条、追加词条、删除，落在 SQLite 里
 * 组内去重按 (kind, value)，同一组里不会出现两条一样的词条
 */

import type {
    KeywordGroup,
    KeywordGroupAddEntriesInput,
    KeywordGroupCreateInput,
    KeywordGroupEntry,
    KeywordGroupUpdateInput,
} from "../api/index.ts";
import type { ConfigContext } from "../config/index.ts";

const KINDS: readonly string[] = ["tag", "author", "custom"];

interface Row {
    id: string;
    title: string;
    entries_json: string;
    position: number;
    created_at: number;
    updated_at: number;
}

export interface KeywordGroupService {
    list(): readonly KeywordGroup[];
    create(input: KeywordGroupCreateInput): readonly KeywordGroup[];
    update(id: string, patch: KeywordGroupUpdateInput): readonly KeywordGroup[];
    addEntries(id: string, input: KeywordGroupAddEntriesInput): readonly KeywordGroup[];
    remove(id: string): readonly KeywordGroup[];
    removeMany(ids: readonly string[]): readonly KeywordGroup[];
}

/** 词条清洗：去掉两端空白、丢掉空值与不认识的 kind、按 (kind, value) 去重 */
function cleanEntries(input: unknown): KeywordGroupEntry[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const out: KeywordGroupEntry[] = [];
    const seen = new Set<string>();
    for (const item of input) {
        if (item === null || typeof item !== "object") {
            continue;
        }
        const kind = String((item as { kind?: unknown }).kind ?? "");
        const value = String((item as { value?: unknown }).value ?? "").trim();
        if (value === "" || !KINDS.includes(kind)) {
            continue;
        }
        const key = `${kind}\u0000${value}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ kind: kind as KeywordGroupEntry["kind"], value });
    }
    return out;
}

function parseEntries(json: string): KeywordGroupEntry[] {
    try {
        return cleanEntries(JSON.parse(json) as unknown);
    } catch {
        return [];
    }
}

function toGroup(row: Row): KeywordGroup {
    return {
        id: row.id,
        title: row.title,
        entries: parseEntries(row.entries_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function newGroupId(): string {
    return `kg_${Math.random().toString(36).slice(2, 10)}`;
}

export function createKeywordGroupService(ctx: ConfigContext): KeywordGroupService {
    const db = ctx.db.raw;

    function find(id: string): Row | undefined {
        return db.prepare("select * from keyword_groups where id = ?").get(id) as
            | Row
            | undefined;
    }

    function require(id: string): Row {
        const row = find(id);
        if (row === undefined) {
            throw new Error(`关键词组不存在：${id}`);
        }
        return row;
    }

    function write(row: Row, title: string, entries: readonly KeywordGroupEntry[]): KeywordGroup {
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
            "update keyword_groups set title = ?, entries_json = ?, updated_at = ? where id = ?",
        ).run(title, JSON.stringify(entries), now, row.id);
        return toGroup({ ...row, title, entries_json: JSON.stringify(entries), updated_at: now });
    }

    /** 每个写操作都回整份列表，界面收到后直接替换本地状态 */
    function list(): readonly KeywordGroup[] {
        const rows = db
            .prepare("select * from keyword_groups order by position asc, created_at asc")
            .all() as unknown as Row[];
        return rows.map(toGroup);
    }

    return {
        list,

        create(input) {
            const now = Math.floor(Date.now() / 1000);
            const next = db
                .prepare("select coalesce(max(position), 0) + 1 as position from keyword_groups")
                .get() as { position: number };
            const row: Row = {
                id: newGroupId(),
                title: input.title.trim(),
                entries_json: JSON.stringify(cleanEntries(input.entries)),
                position: next.position,
                created_at: now,
                updated_at: now,
            };
            db.prepare(
                `insert into keyword_groups (id, title, entries_json, position, created_at, updated_at)
                 values (?, ?, ?, ?, ?, ?)`,
            ).run(row.id, row.title, row.entries_json, row.position, row.created_at, row.updated_at);
            return list();
        },

        update(id, patch) {
            const row = require(id);
            const title = patch.title === undefined ? row.title : patch.title.trim();
            const entries =
                patch.entries === undefined
                    ? parseEntries(row.entries_json)
                    : cleanEntries(patch.entries);
            write(row, title, entries);
            return list();
        },

        addEntries(id, input) {
            const row = require(id);
            const merged = cleanEntries([
                ...parseEntries(row.entries_json),
                ...(input.entries ?? []),
            ]);
            write(row, row.title, merged);
            return list();
        },

        remove(id) {
            db.prepare("delete from keyword_groups where id = ?").run(id);
            return list();
        },

        removeMany(ids) {
            if (ids.length > 0) {
                const placeholders = ids.map(() => "?").join(", ");
                db.prepare(`delete from keyword_groups where id in (${placeholders})`).run(...ids);
            }
            return list();
        },
    };
}
