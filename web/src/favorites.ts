/*
 * 收藏的界面侧状态。模块级单例：收藏页与详情页的收藏按钮共用。
 * 本地收藏夹来自服务端 SQLite；云端分类只读自上游，取不到时给出原因。
 */

import { computed, ref } from "vue";

import type {
    FavoriteItem,
    FavoriteState,
    GallerySummary,
    CloudFavoriteFolder,
} from "../../src/api/index.ts";
import { describeApiError, request } from "./api.ts";
import { messenger } from "./messenger.ts";

export const favoriteFolders = ref<FavoriteState["folders"]>([]);
export const cloudFolders = ref<readonly CloudFavoriteFolder[]>([]);
export const cloudError = ref<string | null>(null);
/** 当前选中的收藏夹：`本地` 时为夹 id，`云端` 时为 `cloud:槽位` */
export const activeFolder = ref("");
export const favoriteItems = ref<readonly FavoriteItem[]>([]);

/** 顶层收藏夹的条目数，标题上显示用 */
export const favoriteCount = computed(() => favoriteItems.value.length);

function applyState(state: FavoriteState): void {
    favoriteFolders.value = state.folders;
    cloudFolders.value = state.cloud;
    cloudError.value = state.cloudError;
    if (activeFolder.value === "" && state.folders[0] !== undefined) {
        activeFolder.value = state.folders[0].id;
    }
}

/** 读收藏夹列表与云端分类 */
export async function loadFavorites(): Promise<void> {
    try {
        applyState(await request("favorites.state"));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 读当前收藏夹里的条目。云端夹走另一条路由，返回的是画廊摘要 */
export async function loadFavoriteItems(): Promise<void> {
    const folder = activeFolder.value;
    if (folder === "") {
        favoriteItems.value = [];
        return;
    }
    try {
        if (folder.startsWith("cloud:")) {
            const slot = Number(folder.slice("cloud:".length));
            const list = await request("favorites.cloud", { query: { slot } });
            favoriteItems.value = list.map(fromSummary);
            return;
        }
        favoriteItems.value = await request("favorites.items", { params: { folderId: folder } });
    } catch (caught) {
        favoriteItems.value = [];
        messenger.error(describeApiError(caught));
    }
}

/** 云端夹的画廊摘要转成本地条目结构，界面统一按一种结构处理 */
function fromSummary(item: GallerySummary): FavoriteItem {
    return {
        gid: item.gid,
        token: item.token,
        title: item.title,
        thumbUrl: item.thumbUrl,
        pageCount: item.pageCount,
        slot: -1,
        addedAt: item.postedAt,
    };
}

export async function createFavoriteFolder(name: string): Promise<void> {
    try {
        applyState(await request("favorites.folder.create", { body: { name } }));
        const created = favoriteFolders.value.at(-1);
        if (created !== undefined) {
            activeFolder.value = created.id;
        }
        await loadFavoriteItems();
        messenger.success("已新建收藏夹");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

export async function removeFavoriteFolder(folderId: string): Promise<void> {
    try {
        applyState(await request("favorites.folder.remove", { params: { folderId } }));
        activeFolder.value = favoriteFolders.value[0]?.id ?? "";
        await loadFavoriteItems();
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 收藏一个画廊到指定夹（默认当前夹） */
export async function addFavorite(
    input: {
        gid: number;
        token: string;
        title: string;
        thumbUrl: string;
        pageCount: number;
        slot?: number;
    },
    folderId?: string,
): Promise<boolean> {
    const target = folderId ?? (activeFolder.value.startsWith("cloud:") ? "" : activeFolder.value);
    if (target === "") {
        messenger.warning("请先选中一个本地收藏夹");
        return false;
    }
    try {
        favoriteItems.value = await request("favorites.items.add", {
            body: { folderId: target, ...input },
        });
        return true;
    } catch (caught) {
        messenger.error(describeApiError(caught));
        return false;
    }
}

export async function removeFavorite(folderId: string, gid: number): Promise<void> {
    try {
        favoriteItems.value = await request("favorites.items.remove", {
            params: { folderId, gid },
        });
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 改标记号（云端槽位）。-1 表示取消云端收藏 */
export async function setFavoriteSlot(folderId: string, gid: number, slot: number): Promise<void> {
    try {
        favoriteItems.value = await request("favorites.items.slot", {
            params: { folderId, gid },
            body: { slot },
        });
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}
