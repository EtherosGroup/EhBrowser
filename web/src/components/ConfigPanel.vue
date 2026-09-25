<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";

import type { SettingOrigin, UserSetting } from "../../../src/api/index.ts";
import { ApiCallError, describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import Dialog from "./Dialog.vue";
import { refreshStatus } from "../status.ts";
import { logDefaultDirectory, logDirectory, loadLogs } from "../logs.ts";
import { missingPaths, prunePaths } from "../settings-patch.ts";
import {
    loadTagDatabase,
    refreshTranslateStatus,
    removeTagDatabase,
    translateStatus,
    updateTagDatabase,
} from "../translation.ts";

/** 可折叠的配置模块。与界面上的细节分组一一对应 */
type ModuleKey =
    | "network"
    | "browse"
    | "player"
    | "translate"
    | "safety"
    | "search"
    | "download"
    | "log"
    | "storage";

const setting = ref<UserSetting | null>(null);
const origins = ref<Record<string, SettingOrigin>>({});
const issues = ref<{ path: string; message: string }[]>([]);
const busy = ref(false);
/** 词库操作与保存配置互不相干，单独一个忙标记。 */
const dictionaryBusy = ref(false);
/*
 * 服务端不认识的设置项。
 * 界面是新的、服务端还在跑旧代码时会出现：这种字段回传会被判「未声明字段」，
 * 于是整个保存都失败。发现后就在页面上说明并提示重启，保存时跳过这些项。
 */
const unknownPaths = ref<readonly string[]>([]);

/** 详情缓存的现状。设置页用它把「最多缓存 N 个」换算成体积。 */
const detailCache = ref<{ entries: number; max: number; bytes: number; perGallery: number } | null>(
    null,
);

/** 「最多缓存 N 个画廊，约 X MB」里的体积估算 */
const cacheSizeText = computed(() => {
    const per = detailCache.value?.perGallery ?? 24 * 1024;
    const count = setting.value?.ui.cachedGalleries ?? 0;
    if (count <= 0) {
        return "不缓存";
    }
    return `约 ${sizeText(per * count)}`;
});

/** 字节数转为可读的容量文本。 */
function sizeText(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit <= 1 ? 0 : 1)} ${units[unit]}`;
}

/** 清空详情缓存。缓存里的信息陈旧，或需要立刻释放内存时使用。 */
async function clearDetailCache(): Promise<void> {
    dictionaryBusy.value = true;
    try {
        detailCache.value = await request("galleries.detailCache.clear");
        messenger.info("详情缓存已清空");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        dictionaryBusy.value = false;
    }
}

async function loadDetailCache(): Promise<void> {
    try {
        detailCache.value = await request("galleries.detailCache");
    } catch {
        // 读取失败时不显示体积，不影响修改设置
    }
}

/** 储存空间：本地画廊与缓存的占用统计，以及缓存清理 */
const storage = ref<StorageStats | null>(null);
/** 清理缓存的确认弹窗与自定义天数 */
const askCleanup = ref(false);
const customDays = ref(30);

async function loadStorage(): Promise<void> {
    try {
        storage.value = await request("storage.stats");
    } catch {
        // 读不到就不显示体积，不影响修改设置
    }
}

/*
 * 清理画廊缓存，只保留最近 days 天内用过的条目，本地画廊文件不受影响。
 * 服务端同时返回清理后的统计，界面据此刷新，无需再次请求。
 */
async function cleanupCache(days: number): Promise<void> {
    if (!Number.isFinite(days) || days < 0) {
        messenger.error("天数要是 0 或正整数");
        return;
    }
    dictionaryBusy.value = true;
    try {
        const result = await request("storage.cleanup", { body: { days } });
        storage.value = result.stats;
        askCleanup.value = false;
        messenger.success(
            result.removed === 0
                ? `没有超过 ${days} 天没用过的缓存`
                : `已清理 ${result.removed} 条缓存，腾出 ${sizeText(result.bytes)}`,
        );
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        dictionaryBusy.value = false;
    }
}

/** 展开状态。默认全部折叠，刷新页面后回到折叠状态。 */
const open = ref<Record<ModuleKey, boolean>>({
    network: false,
    browse: false,
    player: false,
    translate: false,
    safety: false,
    search: false,
    download: false,
    log: false,
    storage: false,
});
const route = useRoute();

/** 切换某个模块。事件来自 details 自身的 toggle。 */
function onToggle(key: ModuleKey, event: Event): void {
    open.value[key] = (event.target as HTMLDetailsElement | null)?.open ?? false;
}

/** 字段路径归到哪个模块。用于校验失败时展开出错的模块 */
function moduleOfPath(path: string): ModuleKey {
    if (path.startsWith("network.")) {
        return "network";
    }
    if (path.startsWith("download.")) {
        return "download";
    }
    if (path.startsWith("viewer.")) {
        return "player";
    }
    if (path.startsWith("translate.")) {
        return "translate";
    }
    if (path.startsWith("safety.")) {
        return "safety";
    }
    if (path.startsWith("search.")) {
        return "search";
    }
    if (path.startsWith("log.")) {
        return "log";
    }
    return "browse";
}

/** 展开含校验问题的模块，否则问题藏在折叠中不可见。 */
function revealIssues(): void {
    const next = { ...open.value };
    for (const issue of issues.value) {
        next[moduleOfPath(issue.path)] = true;
    }
    open.value = next;
}

async function load(): Promise<void> {
    try {
        const snapshot = await request("config.get");
        setting.value = JSON.parse(JSON.stringify(snapshot.setting)) as UserSetting;
        origins.value = { ...snapshot.origins };
        // 服务端快照里没有的字段，多半是服务端还在跑重启前的进程。
        unknownPaths.value = missingPaths(snapshot.setting);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

function issueOf(path: string): string {
    return issues.value.find((issue) => issue.path === path)?.message ?? "";
}

async function save(): Promise<void> {
    if (setting.value === null) {
        return;
    }
    busy.value = true;
    issues.value = [];
    try {
        const value = setting.value;
        const body: Record<string, unknown> = {
            locale: value.locale,
            preferredSite: value.preferredSite,
            network: value.network,
            viewer: value.viewer,
            translate: value.translate,
            safety: value.safety,
            search: value.search,
            download: value.download,
            log: value.log,
            ui: value.ui,
        };
        // 服务端不认识的项剔掉，否则一个字段就能把整次保存顶回去。
        const snapshot = await request("config.patch", {
            body: prunePaths(body, unknownPaths.value),
        });
        setting.value = JSON.parse(JSON.stringify(snapshot.setting)) as UserSetting;
        origins.value = { ...snapshot.origins };
        unknownPaths.value = missingPaths(snapshot.setting);
        messenger.success("配置已保存");
        await refreshStatus();
    } catch (caught) {
        // 字段级问题就地显示在对应输入框旁，整体提示只在不指向具体字段时给出
        if (caught instanceof ApiCallError) {
            issues.value = [...caught.issues];
            revealIssues();
            if (caught.issues.length === 0) {
                messenger.error(describeApiError(caught));
            }
        } else {
            messenger.error(describeApiError(caught));
        }
    } finally {
        busy.value = false;
    }
}

/** 词库状态里的字段：是否安装、版本号、下载时间 */
function dictionaryDate(seconds: number | null): string {
    if (seconds === null || seconds <= 0) {
        return "—";
    }
    const value = new Date(seconds * 1000);
    return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

async function updateDictionary(): Promise<void> {
    dictionaryBusy.value = true;
    try {
        await updateTagDatabase();
    } finally {
        dictionaryBusy.value = false;
    }
}

async function removeDictionary(): Promise<void> {
    dictionaryBusy.value = true;
    try {
        await removeTagDatabase();
    } finally {
        dictionaryBusy.value = false;
    }
}

/** 支持 /config?module=download 这样的深链：下载页左下角的设置按钮会用到。 */
function openFromQuery(): void {
    const asked = route.query["module"];
    if (typeof asked !== "string") {
        return;
    }
    if (asked in open.value) {
        open.value = { ...open.value, [asked as ModuleKey]: true };
    }
}

onMounted(async () => {
    await load();
    openFromQuery();
    await refreshTranslateStatus();
    // 日志目录由服务端解析（相对路径、~、默认值都在那边定），这里只显示生效值。
    await loadLogs();
    await loadStorage();
    await loadDetailCache();
});
</script>

<template>
    <section v-if="setting" class="box">
        <details class="module" :open="open.network" @toggle="onToggle('network', $event)">
            <summary><h2>网络</h2></summary>
            <div class="grid">
                <div>
                    <label>请求间隔（毫秒）</label>
                    <input
                        v-model.number="setting.network.requestIntervalMs"
                        type="number"
                        min="1000"
                        max="60000"
                    />
                    <p class="hint muted">
                        {{ origins["network.requestIntervalMs"] ?? "default" }}
                    </p>
                    <p v-if="issueOf('network.requestIntervalMs')" class="err">
                        {{ issueOf("network.requestIntervalMs") }}
                    </p>
                </div>
                <div>
                    <label>单次最多连续请求</label>
                    <input
                        v-model.number="setting.network.maxSequentialRequests"
                        type="number"
                        min="1"
                        max="25"
                    />
                    <p class="hint muted">
                        一批最多连发几次，发满之后等「请求间隔」再发下一批（上游建议 4～5 次）
                    </p>
                </div>
                <div>
                    <label>超时（毫秒）</label>
                    <input
                        v-model.number="setting.network.requestTimeoutMs"
                        type="number"
                        min="1000"
                        max="300000"
                    />
                </div>

                <div>
                    <label>直连解析（绕开 DNS 污染）</label>
                    <select v-model="setting.network.direct.enabled">
                        <option :value="true">开启</option>
                        <option :value="false">关闭</option>
                    </select>
                    <p class="muted hint">
                        只换「域名解析成哪个 IP」，TLS 的 SNI 与 Host 仍是原域名（证书照常校验）。
                        因此它治的是 DNS 污染；如果所在网络是 SNI 阻断（TCP
                        通、握手一露域名就被重置），
                        它也无能为力，那种情况需要代理。配了代理时这项不生效（解析由代理那头做）
                    </p>
                </div>
                <div>
                    <label>内置 IP 表</label>
                    <select v-model="setting.network.direct.builtIn">
                        <option :value="true">使用</option>
                        <option :value="false">不使用</option>
                    </select>
                    <p class="muted hint">
                        程序自带的一张种子表（E 站、图床、GitHub 等）；过期不要紧，下面还有 DoH 兜底
                    </p>
                </div>
                <div>
                    <label>DoH 解析</label>
                    <select v-model="setting.network.direct.doh">
                        <option :value="true">开启</option>
                        <option :value="false">关闭</option>
                    </select>
                    <p class="muted hint">
                        表里没有的域名（例如各 H@H 图床）走 DoH 问公共解析器，端点写死 IP、
                        因此这一步自己不依赖 DNS；结果按 TTL 缓存
                    </p>
                </div>
                <div class="wide">
                    <label>自定义 hosts（每行 <code>域名 = ip1, ip2</code>，# 开头为注释）</label>
                    <textarea v-model="setting.network.direct.hosts" rows="4" spellcheck="false" />
                    <p class="muted hint">
                        优先级最高。表里没有可用 IP 时可以自己填社区里流传的地址
                    </p>
                    <p v-if="issueOf('network.direct.hosts')" class="err">
                        {{ issueOf("network.direct.hosts") }}
                    </p>
                </div>
            </div>

            <h3>代理</h3>
            <p class="muted">未配置代理时上游不可达。SOCKS5 暂不支持。</p>
            <div class="grid">
                <div>
                    <label>启用</label>
                    <select v-model="setting.network.proxy.enabled">
                        <option :value="false">否</option>
                        <option :value="true">是</option>
                    </select>
                </div>
                <div>
                    <label>协议</label>
                    <select v-model="setting.network.proxy.protocol">
                        <option value="http">http</option>
                        <option value="socks5">socks5</option>
                    </select>
                </div>
                <div>
                    <label>主机</label>
                    <input v-model="setting.network.proxy.host" />
                    <p v-if="issueOf('network.proxy.host')" class="err">
                        {{ issueOf("network.proxy.host") }}
                    </p>
                </div>
                <div>
                    <label>端口</label>
                    <input
                        v-model.number="setting.network.proxy.port"
                        type="number"
                        min="1"
                        max="65535"
                    />
                    <p v-if="issueOf('network.proxy.port')" class="err">
                        {{ issueOf("network.proxy.port") }}
                    </p>
                </div>
            </div>
        </details>

        <details class="module" :open="open.browse" @toggle="onToggle('browse', $event)">
            <summary><h2>浏览</h2></summary>
            <div class="grid">
                <div>
                    <label>默认站点</label>
                    <select v-model="setting.preferredSite">
                        <option value="e-hentai">外站</option>
                        <option value="exhentai">里站</option>
                    </select>
                </div>
                <div>
                    <label>缩略图尺寸</label>
                    <input
                        v-model.number="setting.ui.thumbnailSize"
                        type="number"
                        min="100"
                        max="1000"
                    />
                </div>
                <div>
                    <label>每页条目数</label>
                    <input v-model.number="setting.ui.pageSize" type="number" min="5" max="100" />
                </div>
                <div>
                    <label>语言标签</label>
                    <input v-model="setting.locale" />
                </div>
                <div>
                    <label>最多缓存画廊</label>
                    <input
                        v-model.number="setting.ui.cachedGalleries"
                        type="number"
                        min="0"
                        max="500"
                    />
                    <p class="muted hint">
                        详情页的信息、封面与缩略图缓存在内存里，再次进入同一画廊就不再请求上游。当前：
                        {{ cacheSizeText }}（按每个画廊
                        {{ sizeText(detailCache?.perGallery ?? 24 * 1024) }} 估算），填 0
                        表示不缓存。
                    </p>
                    <p v-if="issueOf('ui.cachedGalleries')" class="err">
                        {{ issueOf("ui.cachedGalleries") }}
                    </p>
                    <div class="row">
                        <button :disabled="dictionaryBusy" @click="clearDetailCache">
                            清空详情缓存（当前 {{ detailCache?.entries ?? 0 }} 个）
                        </button>
                    </div>
                </div>
            </div>
        </details>

        <details class="module" :open="open.storage" @toggle="onToggle('storage', $event)">
            <summary><h2>储存空间</h2></summary>
            <div class="rows">
                <div class="row-line">
                    <span class="muted">本地画廊</span>
                    <strong>{{ sizeText(storage?.libraryBytes ?? 0) }}</strong>
                    <span class="muted">{{ storage?.libraryGalleries ?? 0 }} 个</span>
                </div>
                <div class="row-line">
                    <span class="muted">画廊缓存</span>
                    <strong>{{ sizeText(storage?.cacheBytes ?? 0) }}</strong>
                    <span class="muted">{{ storage?.cacheEntries ?? 0 }} 条</span>
                    <button :disabled="dictionaryBusy" @click="askCleanup = true">清理缓存</button>
                </div>
            </div>
            <p class="muted hint">
                画廊缓存是详情页那份（标签、评分、预览图），落盘后重启不丢，进过的画廊不再问上游；
                本地的画廊文件不在这里清理。最近使用：{{
                    storage?.cacheNewestAt == null
                        ? "—"
                        : new Date(storage.cacheNewestAt * 1000).toLocaleString()
                }}
            </p>
        </details>

        <details class="module" :open="open.player" @toggle="onToggle('player', $event)">
            <summary><h2>播放器</h2></summary>
            <div class="grid">
                <div>
                    <label>查看模式</label>
                    <select v-model="setting.viewer.mode">
                        <option value="mpv">连续</option>
                        <option value="single">单页</option>
                    </select>
                </div>
                <div>
                    <label>图片质量</label>
                    <select v-model="setting.viewer.imageQuality">
                        <option value="org">原图</option>
                        <option value="res">重采样</option>
                    </select>
                </div>
                <div>
                    <label>向后预加载张数</label>
                    <input
                        v-model.number="setting.viewer.preloadCount"
                        type="number"
                        min="0"
                        max="20"
                    />
                    <p v-if="issueOf('viewer.preloadCount')" class="err">
                        {{ issueOf("viewer.preloadCount") }}
                    </p>
                </div>
                <div>
                    <label>图片缓存上限（MB）</label>
                    <input
                        v-model.number="setting.viewer.maxCacheMb"
                        type="number"
                        min="64"
                        max="8192"
                    />
                    <p class="muted hint">超出后按最早使用淘汰</p>
                    <p v-if="issueOf('viewer.maxCacheMb')" class="err">
                        {{ issueOf("viewer.maxCacheMb") }}
                    </p>
                </div>
                <div>
                    <label>同时加载张数</label>
                    <input
                        v-model.number="setting.viewer.maxConcurrentLoads"
                        type="number"
                        min="1"
                        max="8"
                    />
                    <p v-if="issueOf('viewer.maxConcurrentLoads')" class="err">
                        {{ issueOf("viewer.maxConcurrentLoads") }}
                    </p>
                </div>
                <div>
                    <label>自动播放</label>
                    <select v-model="setting.viewer.autoplay.enabled">
                        <option :value="false">关闭</option>
                        <option :value="true">开启</option>
                    </select>
                </div>
                <div>
                    <label>自动播放间隔（秒）</label>
                    <input
                        v-model.number="setting.viewer.autoplay.intervalSeconds"
                        type="number"
                        min="1"
                        max="120"
                    />
                    <p v-if="issueOf('viewer.autoplay.intervalSeconds')" class="err">
                        {{ issueOf("viewer.autoplay.intervalSeconds") }}
                    </p>
                </div>
                <div>
                    <label>播完循环</label>
                    <select v-model="setting.viewer.autoplay.loop">
                        <option :value="false">不循环</option>
                        <option :value="true">循环</option>
                    </select>
                </div>
            </div>
        </details>

        <details class="module" :open="open.translate" @toggle="onToggle('translate', $event)">
            <summary><h2>翻译</h2></summary>
            <div class="grid">
                <div>
                    <label>开启标签翻译</label>
                    <select v-model="setting.translate.tags">
                        <option :value="false">关闭</option>
                        <option :value="true">开启</option>
                    </select>
                    <p class="muted hint">
                        把类别与标签翻成中文，例如 Non-H → 无色情内容、male:femboy → 男性：男娘
                    </p>
                </div>
                <div>
                    <label>标签翻译词库</label>
                    <p class="muted hint">
                        <template v-if="translateStatus?.installed === true">
                            已装 {{ translateStatus.version }}：{{
                                translateStatus.namespaceCount
                            }}
                            个命名空间、{{ translateStatus.tagCount }} 条标签，{{
                                dictionaryDate(translateStatus.updatedAt)
                            }}下载
                        </template>
                        <template v-else>未装，现在只用内置的常用标签表</template>
                    </p>
                    <p
                        v-if="translateStatus !== null && translateStatus.error !== null"
                        class="err"
                    >
                        {{ translateStatus.error }}
                    </p>
                    <div class="row">
                        <button :disabled="dictionaryBusy" @click="updateDictionary">
                            {{ dictionaryBusy ? "正在更新…" : "下载/更新词库" }}
                        </button>
                        <button
                            :disabled="dictionaryBusy || translateStatus?.installed !== true"
                            @click="removeDictionary"
                        >
                            删除词库
                        </button>
                    </div>
                    <p class="muted hint">
                        词库来自 EhTagTranslation/Database
                        的发布包，按需下载到本机，程序本身不分发这些数据（数据遵循 CC BY-NC-SA
                        3.0）。没装词库时画师、角色、原作名不会被翻译。
                    </p>
                </div>
            </div>
        </details>

        <details class="module" :open="open.search" @toggle="onToggle('search', $event)">
            <summary><h2>搜索</h2></summary>
            <div class="grid">
                <div>
                    <label>打开界面时自动搜索</label>
                    <select v-model="setting.search.auto">
                        <option :value="true">开启</option>
                        <option :value="false">关闭</option>
                    </select>
                    <p class="muted hint">
                        开启后：启动时预热一次检索，打开搜索页直接铺一份默认结果。
                        关闭时（默认）不主动去上游拉内容，输入关键词后回车或点「搜索」才开始；
                        从详情页选好标签点搜索仍会照常检索——那是你自己的操作
                    </p>
                </div>
                <div>
                    <label>进入页面时提示自动搜索</label>
                    <select v-model="setting.search.hintEnabled">
                        <option :value="true">开启</option>
                        <option :value="false">关闭</option>
                    </select>
                    <p class="muted hint">
                        每次打开页面时提一句自动搜索的当前状态（提示不自动消失，点一下才收起）
                    </p>
                </div>
            </div>
        </details>

        <details class="module" :open="open.safety" @toggle="onToggle('safety', $event)">
            <summary><h2>避险</h2></summary>
            <div class="grid">
                <div>
                    <label>进入页面时提示</label>
                    <select v-model="setting.safety.hintEnabled">
                        <option :value="true">开启</option>
                        <option :value="false">关闭</option>
                    </select>
                </div>
                <div>
                    <label>避险地点（网页地址或 file:// 本地地址）</label>
                    <input v-model="setting.safety.url" placeholder="about:blank" />
                    <p class="muted hint">
                        按 Ctrl + 空格 会把当前页面整个替换成这个地址，后退键回不到原页面
                    </p>
                    <p v-if="issueOf('safety.url')" class="err">{{ issueOf("safety.url") }}</p>
                </div>
            </div>
        </details>

        <details class="module" :open="open.download" @toggle="onToggle('download', $event)">
            <summary><h2>下载</h2></summary>
            <div class="grid">
                <div>
                    <label>目录（留空表示未设置，需绝对路径）</label>
                    <input v-model="setting.download.directory" />
                    <p v-if="issueOf('download.directory')" class="err">
                        {{ issueOf("download.directory") }}
                    </p>
                </div>
                <div>
                    <label>保留归档</label>
                    <select v-model="setting.download.keepArchive">
                        <option :value="true">是</option>
                        <option :value="false">否</option>
                    </select>
                </div>
                <div>
                    <label>并发数</label>
                    <input
                        v-model.number="setting.download.concurrency"
                        type="number"
                        min="1"
                        max="8"
                    />
                </div>
            </div>
        </details>

        <details class="module" :open="open.log" @toggle="onToggle('log', $event)">
            <summary><h2>日志</h2></summary>
            <div class="grid">
                <div>
                    <label>写入日志文件</label>
                    <select v-model="setting.log.enabled">
                        <option :value="true">开启</option>
                        <option :value="false">关闭（只在控制台与「服务」页显示）</option>
                    </select>
                </div>
                <div>
                    <label>日志目录（留空用默认目录）</label>
                    <input v-model="setting.log.directory" :placeholder="logDefaultDirectory" />
                    <p class="muted hint">
                        默认 {{ logDefaultDirectory }}；当前生效：{{ logDirectory }}。支持绝对路径与
                        ~ 开头，按天一个文件（ehbrowser-YYYY-MM-DD.log），改完立即生效。
                    </p>
                    <p v-if="issueOf('log.directory')" class="err">
                        {{ issueOf("log.directory") }}
                    </p>
                </div>
            </div>
        </details>

        <!-- 服务端还在跑旧代码时不认识界面上的新字段，此处说明并提示重启，而不是只提示「未声明字段」。 -->
        <p v-if="unknownPaths.length > 0" class="notice">
            服务端不认识这些设置项：{{ unknownPaths.join("、") }}。
            多半是服务端还在跑改动之前启动的那个进程（界面已经更新、配置结构还是旧的）。
            <strong>重启 EhBrowser 服务</strong>（Ctrl+C 后重新 npm
            start）即可；这次保存会自动跳过这些项，其余设置照常保存。
        </p>

        <div class="actions">
            <button :disabled="busy" @click="save">{{ busy ? "保存中…" : "保存" }}</button>
            <button :disabled="busy" @click="load">重置</button>
        </div>
        <!--
        该弹窗必须留在 section 内部，不可移到模板最外层。
        模板根一旦变成多节点，App.vue 的 <Transition mode="out-in"> 无法完成离场，
        切换页面后内容不显示。
    -->
        <Dialog v-model="askCleanup" title="清理画廊缓存">
            <p>只保留最近用过的画廊缓存，更早的删掉。本地画廊的文件不受影响。</p>
            <p class="muted">
                当前缓存 {{ sizeText(storage?.cacheBytes ?? 0) }}（{{ storage?.cacheEntries ?? 0 }}
                条）
            </p>
            <div class="row keep">
                <label for="cleanup-days">自定义天数</label>
                <input id="cleanup-days" v-model.number="customDays" type="number" min="0" />
                <button :disabled="dictionaryBusy" @click="cleanupCache(customDays)">
                    {{ customDays }} 天之前
                </button>
            </div>
            <template #buttons>
                <button :disabled="dictionaryBusy" @click="askCleanup = false">取消</button>
                <button :disabled="dictionaryBusy" @click="cleanupCache(1)">一天之前</button>
                <button :disabled="dictionaryBusy" @click="cleanupCache(7)">七天之前</button>
                <button :disabled="dictionaryBusy" @click="cleanupCache(30)">一个月之前</button>
            </template>
        </Dialog>
    </section>
    <p v-else class="muted">读取配置中…</p>
</template>

<style scoped lang="scss">
/* 储存空间的两行：名称、体积、条数与操作排成一行。 */
.rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-left: 20px;
}

.row-line {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--font-size-md);
}

.row-line strong {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
}

.row-line button {
    margin-left: auto;
}

/* 弹窗里的自定义天数输入行。 */
.row.keep {
    align-items: center;
    gap: 8px;
    margin-top: 4px;
}

.row.keep label {
    margin: 0;
}

.row.keep input {
    width: 90px;
}

/* 页面：各区域各成一块 */
.box {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.module {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;

    > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        cursor: pointer;
        list-style: none;

        &::-webkit-details-marker {
            display: none;
        }

        &::before {
            content: "▸";
            color: var(--muted);
            transition: transform 0.15s;
        }

        &:hover h2 {
            color: var(--text);
        }
    }

    &[open] {
        > summary {
            border-bottom: 1px solid var(--line);
        }

        > summary::before {
            transform: rotate(90deg);
        }

        > :last-child {
            padding-bottom: 12px;
        }
    }

    /* 内容与标题文字左对齐 */
    > .grid,
    > .rows,
    > .row,
    > h3,
    > p {
        margin-left: 36px;
        margin-right: 16px;
    }
}

h2 {
    margin: 0;
    font-size: var(--font-size-base);
    color: var(--accent);
}

h3 {
    margin: 18px 0 6px;
    font-size: var(--font-size-lg);
}

/* 需要整行宽度的字段（例如多行 hosts） */
.grid .wide {
    grid-column: 1 / -1;
}

.grid textarea {
    width: 100%;
    font-family: ui-monospace, monospace;
}

/*
 * 字段网格：一行里可能同时有 input 与 select，而原生 select 的内在高度比 input 矮（实测 39px vs 45px）。
 * 跨格子对齐不能靠 flex——flex 的 stretch 只管自己的直接子元素，够不到隔壁格子里的控件。
 * 因此这里把「标签 / 控件 / 说明 / 报错」四条横向带子交给 subgrid：格子只跨这四行，
 * 于是同一行里所有格子的标签对齐、控件顶边对齐、并被拉到同一高度（控件高度由该带里最高者决定，
 * 换字号也不用改数字）。不支持 subgrid 的浏览器走下面的普通排法，不会散。
 */
.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    grid-template-rows: repeat(4, auto);
    gap: 12px;
}

/* 回退（不支持 subgrid）：格子当普通块排，标签、控件、说明依次往下 */
.grid > div {
    display: grid;
    align-content: start;
}

@supports (grid-template-rows: subgrid) {
    /*
     * subgrid 的行距是继承父网格的 gap 的，若沿用 12px，标签和它自己的控件会被拉开 16px，
     * 比行与行之间还宽，读起来就不像一组了。所以行距收到 4px，行与行之间的距离改由格子的
     * padding-bottom 撑出来（padding 撑的是最后一条行带，正好落在两组字段之间）。
     */
    .grid {
        row-gap: 4px;
    }

    .grid > div {
        grid-row: span 4;
        display: grid;
        grid-template-rows: subgrid;
        align-content: normal;
        padding-bottom: 8px;
    }
}

.hint {
    font-size: var(--font-size-sm);
    /* 行带已经负责纵向位置，这里只留一点呼吸 */
    margin: 2px 0 0;
    align-self: start;
}

/* 服务端版本不匹配之类的提醒：显眼但不刺眼。 */
.notice {
    margin: 16px 0 0;
    padding: 10px 12px;
    font-size: var(--font-size-sm);
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--danger);
    border-left-width: 3px;
    border-radius: 4px;
}

/* 同一行里并排的按钮，如词库的「下载/更新」与「删除」 */
.row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
}

.actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 20px;
}
</style>
