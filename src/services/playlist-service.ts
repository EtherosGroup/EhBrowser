/*
 * 用户播放列表：加入、排序、进度与当前项，全部落在 SQLite 里，重启不丢。
 * 这一份与「画廊播放列表」不同：它装的是画廊，手动加入，可以跨画廊连续播。
 */

import type { PlaylistAddInput, PlaylistItem, PlaylistSnapshot } from "../api/index.ts";
import { playlistKeyOf } from "../api/index.ts";
import type { ConfigContext } from "../config/index.ts";

/** meta 表里记当前播放项用哪把键 */
const CURRENT_KEY_META = "playlist.current";

interface Row {
    key: string;
    position: number;
    gid: number;
    token: string;
    title: string;
    thumb_url: string;
    page_count: number;
    resolution: string | null;
    page: number;
    bytes_per_page: number;
    added_at: number;
    updated_at: number;
}

export interface PlaylistService {
    snapshot(): PlaylistSnapshot;
    /** 加入。已存在则只刷新快照字段，不动位置与进度。 */
    add(input: PlaylistAddInput): PlaylistSnapshot;
    /** 设为当前播放项。 */
    play(key: string): PlaylistSnapshot;
    /** 写回某个画廊的播放进度。 */
    progress(key: string, page: number): PlaylistSnapshot;
    remove(key: string): PlaylistSnapshot;
    clear(): PlaylistSnapshot;
}

function toItem(row: Row): PlaylistItem {
    return {
        key: row.key,
        gid: row.gid,
        token: row.token,
        title: row.title,
        thumbUrl: row.thumb_url,
        pageCount: row.page_count,
        resolution: row.resolution === null || row.resolution === "" ? null : row.resolution,
        page: row.page,
        bytesPerPage: row.bytes_per_page,
        addedAt: row.added_at,
    };
}

export function createPlaylistService(ctx: ConfigContext): PlaylistService {
    const db = ctx.db.raw;

    function rows(): Row[] {
        return db
            .prepare("select * from playlist_items order by position asc")
            .all() as unknown as Row[];
    }

    function snapshot(): PlaylistSnapshot {
        return {
            items: rows().map(toItem),
            currentKey: ctx.db.getMeta(CURRENT_KEY_META),
        };
    }

    function touch(key: string): void {
        db.prepare("update playlist_items set updated_at = ? where key = ?").run(
            Math.floor(Date.now() / 1000),
            key,
        );
    }

    return {
        snapshot,

        add(input) {
            const key = playlistKeyOf(input.gid, input.resolution);
            const now = Math.floor(Date.now() / 1000);
            const existing = db.prepare("select key from playlist_items where key = ?").get(key) as
                | { key: string }
                | undefined;
            if (existing === undefined) {
                const next = db
                    .prepare(
                        "select coalesce(max(position), 0) + 1 as position from playlist_items",
                    )
                    .get() as { position: number };
                db.prepare(
                    `insert into playlist_items
                     (key, position, gid, token, title, thumb_url, page_count, resolution, page,
                      bytes_per_page, added_at, updated_at)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).run(
                    key,
                    next.position,
                    input.gid,
                    input.token,
                    input.title,
                    input.thumbUrl,
                    input.pageCount,
                    input.resolution ?? null,
                    Math.max(1, input.page ?? 1),
                    Math.max(0, input.bytesPerPage ?? 0),
                    now,
                    now,
                );
            } else {
                // 已在列表里：只更新快照字段，保留既有进度与顺序
                db.prepare(
                    `update playlist_items set title = ?, thumb_url = ?, page_count = ?,
                     resolution = ?, token = ?, updated_at = ? where key = ?`,
                ).run(
                    input.title,
                    input.thumbUrl,
                    input.pageCount,
                    input.resolution ?? null,
                    input.token,
                    now,
                    key,
                );
            }
            return snapshot();
        },

        play(key) {
            const found = db.prepare("select key from playlist_items where key = ?").get(key) as
                | { key: string }
                | undefined;
            if (found !== undefined) {
                ctx.db.setMeta(CURRENT_KEY_META, key);
                touch(key);
            }
            return snapshot();
        },

        progress(key, page) {
            db.prepare("update playlist_items set page = ?, updated_at = ? where key = ?").run(
                Math.max(1, Math.floor(page)),
                Math.floor(Date.now() / 1000),
                key,
            );
            return snapshot();
        },

        remove(key) {
            db.prepare("delete from playlist_items where key = ?").run(key);
            if (ctx.db.getMeta(CURRENT_KEY_META) === key) {
                ctx.db.deleteMeta(CURRENT_KEY_META);
            }
            return snapshot();
        },

        clear() {
            db.prepare("delete from playlist_items").run();
            ctx.db.deleteMeta(CURRENT_KEY_META);
            return snapshot();
        },
    };
}
