/*
 * 收藏服务。
 * 本地部分（收藏夹与夹内条目）落在 SQLite，离线可用；云端部分（槽位 0～9 的名称、数量、
 * 夹内画廊）向 favorites.php 取，未登录或上游不可达时只给本地那份，并把原因带回去。
 * 「标记号」指条目上的 slot：修改该字段即把这条收藏挪到另一个云端分类，登录时同步到上游。
 */

import { randomUUID } from "node:crypto";

import type {
    CloudFavoriteFolder,
    FavoriteAddInput,
    FavoriteFolder,
    FavoriteItem,
    FavoriteRefreshEntry,
    FavoriteRefreshResult,
    FavoriteState,
} from "../api/index.ts";
import { activeAccount, type ConfigContext } from "../config/index.ts";
import {
    fetchFavoriteCategories,
    fetchFavoriteGalleryPairs,
    LoginRequiredError,
    setFavorite,
    type FavoriteRequestOptions,
} from "../eh/index.ts";
import { describeError } from "../platform/errors.ts";
import type { GalleryService } from "./gallery-service.ts";

/** 默认收藏夹的名字。第一次打开收藏页时自动建一个，保证界面有可选的收藏夹 */
const DEFAULT_FOLDER_NAME = "本地收藏1";

interface FolderRow {
    id: string;
    name: string;
    position: number;
    created_at: number;
}

interface ItemRow {
    folder_id: string;
    gid: number;
    token: string;
    title: string;
    thumb_url: string;
    page_count: number;
    slot: number;
    added_at: number;
}

export interface FavoriteService {
    state(): Promise<FavoriteState>;
    /** 云端某个分类里的画廊，与本地条目无关 */
    cloudItems(slot: number): Promise<Awaited<ReturnType<GalleryService["summariesOf"]>>>;
    createFolder(name: string): FavoriteState;
    removeFolder(id: string): FavoriteState;
    items(folderId: string): readonly FavoriteItem[];
    add(input: FavoriteAddInput): Promise<readonly FavoriteItem[]>;
    removeItem(folderId: string, gid: number): readonly FavoriteItem[];
    /** 改标记号：写本地，登录时同步到上游 */
    setSlot(folderId: string, gid: number, slot: number): Promise<readonly FavoriteItem[]>;
    /**
     * 更新标记号：把收藏从当前版本挪到上游的最新版本
     * 不传 gids 就是整夹都查一遍。每条都要向上游请求一次画廊详情，耗时较长，
     * 因此批次大小由调用方决定
     */
    refresh(folderId: string, gids?: readonly number[]): Promise<FavoriteRefreshResult>;
}

function toItem(row: ItemRow): FavoriteItem {
    return {
        gid: row.gid,
        token: row.token,
        title: row.title,
        thumbUrl: row.thumb_url,
        pageCount: row.page_count,
        slot: row.slot,
        addedAt: row.added_at,
    };
}

export function createFavoriteService(
    ctx: ConfigContext,
    gallery: GalleryService,
    options: { logger?: (level: "info" | "warn", message: string) => void } = {},
): FavoriteService {
    const log = options.logger ?? (() => undefined);
    const db = ctx.db.raw;

    /** 上游请求参数：登录后用当前账号的 Cookie */
    function requestOptions(signal?: AbortSignal): FavoriteRequestOptions | null {
        const account = activeAccount(ctx.auth.get());
        const site = account?.site ?? ctx.user.get().preferredSite;
        if (account === null) {
            return null;
        }
        const cookies: Record<string, string> = {
            ipb_member_id: account.cookies.ipbMemberId,
            ipb_pass_hash: account.cookies.ipbPassHash,
        };
        if (account.cookies.igneous !== "") {
            cookies["igneous"] = account.cookies.igneous;
        }
        return {
            site,
            cookies,
            ...(signal === undefined ? {} : { signal }),
        };
    }

    function folders(): FavoriteFolder[] {
        const rows = db
            .prepare("select * from favorite_folders order by position asc, created_at asc")
            .all() as unknown as FolderRow[];
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            count: (
                db
                    .prepare("select count(*) as n from favorite_items where folder_id = ?")
                    .get(row.id) as { n: number }
            ).n,
            createdAt: row.created_at,
        }));
    }

    /** 一个夹都没有时建一个默认夹，保证界面始终有可选的收藏夹 */
    function ensureDefaultFolder(): void {
        const row = db.prepare("select count(*) as n from favorite_folders").get() as { n: number };
        if (row.n > 0) {
            return;
        }
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
            "insert into favorite_folders (id, name, position, created_at) values (?, ?, ?, ?)",
        ).run(randomUUID(), DEFAULT_FOLDER_NAME, 1, now);
    }

    function items(folderId: string): readonly FavoriteItem[] {
        const rows = db
            .prepare("select * from favorite_items where folder_id = ? order by added_at desc")
            .all(folderId) as unknown as ItemRow[];
        return rows.map(toItem);
    }

    async function cloudFolders(): Promise<{ cloud: CloudFavoriteFolder[]; error: string | null }> {
        const request = requestOptions();
        if (request === null) {
            return { cloud: [], error: "未登录，云端收藏夹不可见" };
        }
        try {
            const list = await fetchFavoriteCategories(request);
            return { cloud: [...list], error: null };
        } catch (error) {
            const reason =
                error instanceof LoginRequiredError ? "登录已失效" : describeError(error);
            log("warn", `云端收藏夹读取失败：${reason}`);
            return { cloud: [], error: reason };
        }
    }

    return {
        async state() {
            ensureDefaultFolder();
            const { cloud, error } = await cloudFolders();
            return { folders: folders(), cloud, cloudError: error };
        },

        async cloudItems(slot) {
            const request = requestOptions();
            if (request === null) {
                return [];
            }
            const pairs = await fetchFavoriteGalleryPairs(slot, request);
            if (pairs.length === 0) {
                return [];
            }
            return gallery.summariesOf(pairs);
        },

        createFolder(name) {
            const now = Math.floor(Date.now() / 1000);
            const next = db
                .prepare("select coalesce(max(position), 0) + 1 as position from favorite_folders")
                .get() as { position: number };
            db.prepare(
                "insert into favorite_folders (id, name, position, created_at) values (?, ?, ?, ?)",
            ).run(randomUUID(), name.trim() === "" ? "新收藏夹" : name.trim(), next.position, now);
            return { folders: folders(), cloud: [], cloudError: null };
        },

        removeFolder(id) {
            db.prepare("delete from favorite_items where folder_id = ?").run(id);
            db.prepare("delete from favorite_folders where id = ?").run(id);
            ensureDefaultFolder();
            return { folders: folders(), cloud: [], cloudError: null };
        },

        items,

        async add(input) {
            const now = Math.floor(Date.now() / 1000);
            db.prepare(
                `insert into favorite_items
                 (folder_id, gid, token, title, thumb_url, page_count, slot, added_at)
                 values (?, ?, ?, ?, ?, ?, ?, ?)
                 on conflict(folder_id, gid) do update set
                 title = excluded.title, thumb_url = excluded.thumb_url,
                 page_count = excluded.page_count, token = excluded.token`,
            ).run(
                input.folderId,
                input.gid,
                input.token,
                input.title,
                input.thumbUrl,
                input.pageCount,
                input.slot ?? -1,
                now,
            );
            // 指定了槽位时同步到上游；失败只记日志，本地记录保留
            if (input.slot !== undefined && input.slot >= 0) {
                await syncSlot(input.gid, input.token, input.slot);
            }
            return items(input.folderId);
        },

        removeItem(folderId, gid) {
            db.prepare("delete from favorite_items where folder_id = ? and gid = ?").run(
                folderId,
                gid,
            );
            return items(folderId);
        },

        async setSlot(folderId, gid, slot) {
            db.prepare("update favorite_items set slot = ? where folder_id = ? and gid = ?").run(
                slot,
                folderId,
                gid,
            );
            const row = db
                .prepare("select token from favorite_items where folder_id = ? and gid = ?")
                .get(folderId, gid) as { token: string } | undefined;
            if (row !== undefined) {
                await syncSlot(gid, row.token, slot);
            }
            return items(folderId);
        },

        async refresh(folderId, gids) {
            const all = items(folderId);
            const wanted =
                gids === undefined || gids.length === 0
                    ? all
                    : all.filter((item) => gids.includes(item.gid));
            const results: FavoriteRefreshEntry[] = [];
            for (const item of wanted) {
                results.push(await moveToLatest(folderId, item));
            }
            return {
                entries: results,
                moved: results.filter((entry) => entry.moved).length,
                items: items(folderId),
            };
        },
    };

    /**
     * 把一条收藏挪到它所属画廊的最新版本
     * 上游的处理是「先取消旧版本的收藏，再把新版本放进同一个槽位」；
     * 本地则是把这一行连同 added_at 一起改成新版本（新版本若已在夹里，两行合成一行）
     */
    async function moveToLatest(
        folderId: string,
        item: FavoriteItem,
    ): Promise<FavoriteRefreshEntry> {
        const skip = (reason: string, latestGid: number | null = null): FavoriteRefreshEntry => ({
            gid: item.gid,
            latestGid,
            moved: false,
            reason,
        });

        let latestGid: number;
        let latestToken: string;
        let latestTitle: string;
        let latestThumb: string;
        let latestPages: number;
        try {
            // 更新标记号同样需要新数据：current 关系变化时需要迁移
            const detail = await gallery.detail(item.gid, item.token, { fresh: true });
            // current 指回来的就是自己时同样视为没有新版本，否则会多一轮无用的上游写入
            if (detail.current === null || detail.current.gid === item.gid) {
                return skip("已是最新版本");
            }
            latestGid = detail.current.gid;
            latestToken = detail.current.token;
            // 新版本的标题与封面一并取回：收藏页显示的内容应与新版本一致
            const summary = await gallery.summaryOf(latestGid, latestToken);
            latestTitle = summary.title;
            latestThumb = summary.thumbUrl;
            latestPages = summary.pageCount;
        } catch (error) {
            return skip(`读取画廊信息失败：${describeError(error)}`);
        }

        // 上游侧：仅在条目本就在云端收藏中时才操作，两次调用都成功才算同步成功
        let reason: string | null = null;
        if (item.slot >= 0) {
            const removed = await syncSlot(item.gid, item.token, -1);
            const added = await syncSlot(latestGid, latestToken, item.slot);
            if (!removed || !added) {
                reason = "上游标记号同步失败，只改了本地";
            }
        }

        const targetSlot = item.slot >= 0 ? item.slot : -1;
        db.prepare("delete from favorite_items where folder_id = ? and gid = ?").run(
            folderId,
            item.gid,
        );
        db.prepare(
            `insert into favorite_items
             (folder_id, gid, token, title, thumb_url, page_count, slot, added_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict(folder_id, gid) do update set
             title = excluded.title, thumb_url = excluded.thumb_url,
             page_count = excluded.page_count, token = excluded.token, slot = excluded.slot`,
        ).run(
            folderId,
            latestGid,
            latestToken,
            latestTitle === "" ? item.title : latestTitle,
            latestThumb === "" ? item.thumbUrl : latestThumb,
            latestPages,
            targetSlot,
            item.addedAt,
        );
        log(
            "info",
            `更新标记号：#${item.gid} → #${latestGid}${reason === null ? "" : `（${reason}）`}`,
        );
        return { gid: item.gid, latestGid, moved: true, reason };
    }

    /** 把标记号同步到上游。未登录或上游不可达都只记日志：本地标记号仍然有效 */
    async function syncSlot(gid: number, token: string, slot: number): Promise<boolean> {
        const request = requestOptions();
        if (request === null) {
            log("info", `未登录，标记号只改本地：#${gid} → ${slot}`);
            return false;
        }
        try {
            await setFavorite(gid, token, slot, request);
            return true;
        } catch (error) {
            log("warn", `标记号同步失败：#${gid} ${describeError(error)}`);
            return false;
        }
    }
}
