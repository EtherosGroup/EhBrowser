/*
 * 机器写数据库：程序标记、画廊缓存、下载任务、每画廊读到第几页。
 * 每次开库设置三个 pragma：WAL、busy_timeout、foreign_keys（默认关闭）。
 * 表结构版本由 PRAGMA user_version 记录。
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_FILENAME = "ehbrowser.db";
export const DB_VERSION = 4;

export function databaseFile(dataDir: string): string {
    return join(dataDir, DB_FILENAME);
}

export interface DbHandle {
    readonly file: string;
    /** 直接执行 SQL 的入口；常规操作使用下列方法 */
    readonly raw: DatabaseSync;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    deleteMeta(key: string): void;
    allMeta(): Record<string, string>;
    /** 关闭前合并 WAL，使备份与复制只涉及单个文件 */
    close(): void;
}

// 每版一段，新版本追加，历史段落不变
const MIGRATIONS: readonly string[] = [
    `
    create table if not exists meta (
        key text primary key,
        value text not null
    );

    create table if not exists galleries (
        gid integer primary key,
        token text not null,
        title text not null default '',
        title_jpn text not null default '',
        category text not null default '',
        thumb_url text not null default '',
        uploader text not null default '',
        posted_at integer,
        page_count integer,
        size_bytes integer,
        rating real,
        torrent_count integer,
        expunged integer not null default 0,
        language text,
        tags_json text not null default '[]',
        fetched_at integer not null
    );

    create table if not exists downloads (
        id text primary key,
        gid integer not null,
        token text not null,
        title text not null default '',
        resolution text not null default 'org',
        status text not null default 'queued',
        bytes_done integer not null default 0,
        bytes_total integer,
        output_path text,
        error text,
        created_at integer not null,
        updated_at integer not null
    );

    -- 每画廊读到第几页
    create table if not exists reading_progress (
        gid integer primary key,
        page integer not null default 1,
        updated_at integer not null
    );

    create index if not exists idx_downloads_status on downloads (status, created_at);
    create index if not exists idx_galleries_fetched on galleries (fetched_at);
    `,
    // v2：用户播放列表。需要持久化，因此存放在数据库中，而不是内存或配置文件里
    `
    create table if not exists playlist_items (
        key text primary key,
        position integer not null,
        gid integer not null,
        token text not null,
        title text not null default '',
        thumb_url text not null default '',
        page_count integer not null default 0,
        resolution text,
        page integer not null default 1,
        bytes_per_page integer not null default 0,
        added_at integer not null,
        updated_at integer not null
    );

    create index if not exists idx_playlist_position on playlist_items (position);
    `,
    // v3：本地收藏夹与收藏项。云端分类只是槽位号，条目本身保存在本地
    `
    create table if not exists favorite_folders (
        id text primary key,
        name text not null,
        position integer not null default 0,
        created_at integer not null
    );

    create table if not exists favorite_items (
        folder_id text not null,
        gid integer not null,
        token text not null,
        title text not null default '',
        thumb_url text not null default '',
        page_count integer not null default 0,
        -- 云端分类槽位；-1 表示只在本地、没有对应的云端收藏
        slot integer not null default -1,
        added_at integer not null,
        primary key (folder_id, gid)
    );

    create index if not exists idx_favorite_items_folder on favorite_items (folder_id, added_at);
    `,
    // v4：逐页下载（游客也可下载）需要记录「第几页 / 共几页」，归档任务这两列为空
    `
    alter table downloads add column pages_done integer not null default 0;
    alter table downloads add column page_count integer;
    `,
];

export function openDatabase(file: string): DbHandle {
    const db = new DatabaseSync(file);

    db.exec("pragma journal_mode = WAL");
    db.exec("pragma busy_timeout = 5000");
    db.exec("pragma foreign_keys = ON");
    migrate(db);

    return {
        file,
        raw: db,

        getMeta(key) {
            const row = db.prepare("select value from meta where key = ?").get(key) as
                | { value: string }
                | undefined;
            return row?.value ?? null;
        },

        setMeta(key, value) {
            db.prepare(
                "insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
            ).run(key, value);
        },

        deleteMeta(key) {
            db.prepare("delete from meta where key = ?").run(key);
        },

        allMeta() {
            const rows = db.prepare("select key, value from meta").all() as Array<{
                key: string;
                value: string;
            }>;
            const out: Record<string, string> = {};
            for (const row of rows) {
                out[row.key] = row.value;
            }
            return out;
        },

        close() {
            try {
                db.exec("pragma wal_checkpoint(truncate)");
            } catch {
                // 合并失败时忽略，下次开库会再次合并
            }
            db.close();
        },
    };
}

function migrate(db: DatabaseSync): void {
    const row = db.prepare("pragma user_version").get() as { user_version: number } | undefined;
    let version = row?.user_version ?? 0;

    if (version > MIGRATIONS.length) {
        // 数据库版本高于程序支持的版本：读操作正常，写操作存在风险
        throw new Error(`数据库版本 v${version} 高于程序支持的 v${MIGRATIONS.length}`);
    }

    while (version < MIGRATIONS.length) {
        const sql = MIGRATIONS[version];
        if (sql === undefined) {
            break;
        }
        db.exec(sql);
        version += 1;
        db.exec(`pragma user_version = ${version}`);
    }
}
