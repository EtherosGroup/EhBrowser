<script setup lang="ts">
/**
 * 调试页。只在地址栏直接访问 /debug 时打开（不在顶部标签里），用来把状态图标逐个摆出来看。
 *
 * 两条路子：
 *   真的触发：客户端繁忙（多开几条 SSE 连接）、与 EhBrowser 的连接变慢（往本地往返采样里喂一个慢值）
 *   强制点亮：磁盘、内存、上游、文件系统、内部错误这几项在真机上不好复现，
 *             走 POST /api/debug/status 绕过阈值先把图标摆出来，按钮再点一下就恢复真实判定
 *
 * 页面底部同时显示服务端报回来的 active 与采样值：图标是渲染结果，这里是原始数据。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";

import {
    buildQueryString,
    routePath,
    STATUS_FLAGS,
    type DebugStatusResult,
    type SystemStatusFlag,
    type SystemStatusState,
} from "../../../src/api/index.ts";
import { boot, describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";
import { noteLocalLatency, serverStatus, STATUS_ICONS } from "../diagnostics.ts";

/** 与服务端保持一致的说法，页面里直接显示这份说明 */
const MEANING: Readonly<Record<SystemStatusFlag, string>> = {
    "internal-error": "未捕获异常 / 未处理的拒绝 / 连续 500",
    "fs-anomaly": "读写报错（探测失败，或接口与下载任务里的 errno）",
    "low-memory": "系统可用内存 < 6%，或堆已用 > 上限的 90%",
    "disk-busy": "磁盘探测（写 4KB + 读回）≥ 400ms",
    "upstream-slow": "最近 5 次上游请求平均 ≥ 8 秒",
    latency: "浏览器与本机服务的往返中位数 ≥ 800ms（只由浏览器测）",
    congestion: "SSE 连接 ≥ 6 或在途请求 ≥ 24",
};

/** 哪些项是「真的触发」，哪些是注入 */
const REAL: readonly SystemStatusFlag[] = ["congestion", "latency"];

const state = ref<SystemStatusState | null>(null);
const forced = ref<readonly SystemStatusFlag[]>([]);
const extraStreams = ref(0);
const error = ref("");

/** 由本页额外开着的 SSE 连接。用来真触发「客户端繁忙」 */
const streams: EventSource[] = [];

const active = computed(() => new Set(state.value?.active ?? []));

/** 拉一次当前状态与被强制的那几项。注入项也算在状态里，因此图标与列表都能看到 */
async function refresh(): Promise<void> {
    try {
        const current = await request("debug.status", { body: { flag: null, forced: false } });
        apply(current);
    } catch (caught) {
        error.value = describeApiError(caught);
    }
}

function apply(result: DebugStatusResult): void {
    state.value = result.state;
    forced.value = result.forced;
    serverStatus.value = result.state;
}

/** 强制点亮 / 熄灭某一项 */
async function toggle(flag: SystemStatusFlag): Promise<void> {
    try {
        apply(
            await request("debug.status", {
                body: { flag, forced: !forced.value.includes(flag) },
            }),
        );
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 清掉全部强制项，回到真实判定 */
async function clearForced(): Promise<void> {
    try {
        apply(await request("debug.status", { body: { flag: "all", forced: false } }));
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

/** 真触发「客户端繁忙」：多开几条 SSE，服务端按连接数判定 */
function addStream(): void {
    const source = new EventSource(
        `${routePath("system.events")}${buildQueryString({ _token: boot().token })}`,
    );
    streams.push(source);
    extraStreams.value = streams.length;
}

function closeStreams(): void {
    for (const source of streams) {
        source.close();
    }
    streams.length = 0;
    extraStreams.value = 0;
}

/** 真触发「与 EhBrowser 的连接变慢」：喂几个慢值给本地往返采样 */
function feedSlowLatency(): void {
    for (let i = 0; i < 4; i += 1) {
        noteLocalLatency(1_500);
    }
}

function feedFastLatency(): void {
    for (let i = 0; i < 4; i += 1) {
        noteLocalLatency(20);
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
    await refresh();
    // 每 3 秒把真实状态拉回来一次（注入项也会跟着显示）
    timer = setInterval(() => void refresh(), 3_000);
});

onUnmounted(() => {
    if (timer !== null) {
        clearInterval(timer);
    }
    closeStreams();
});
</script>

<template>
    <section class="panel">
        <header class="head">
            <h2>状态图标调试</h2>
            <p class="muted">
                这一页不在顶部标签里，从地址栏打开即可。左边是图标，右边写清它代表什么、怎么判定。
                「真的触发」两个按钮会让服务端按真实条件点亮；其余几项在真机上不好复现，
                用注入的方式先把图标摆出来看一眼，再点一次恢复。
            </p>
        </header>

        <p v-if="error" class="err">{{ error }}</p>

        <div class="actions">
            <button type="button" @click="addStream">
                多开一条 SSE 连接（{{ extraStreams }}）
            </button>
            <button type="button" :disabled="extraStreams === 0" @click="closeStreams">
                关掉这些连接
            </button>
            <button type="button" @click="feedSlowLatency">喂一个慢往返（1500ms）</button>
            <button type="button" @click="feedFastLatency">喂一个快往返（20ms）</button>
            <button type="button" class="danger" @click="clearForced">清掉全部注入</button>
            <button type="button" class="danger" @click="$router.push('/')">
                回搜索页看实际效果
            </button>
        </div>

        <ul class="list">
            <li v-for="flag in STATUS_FLAGS" :key="flag" :class="{ on: active.has(flag) }">
                <span class="icon">
                    <img v-if="active.has(flag)" :src="STATUS_ICONS[flag].icon" alt="" />
                    <span v-else class="muted">—</span>
                </span>
                <span class="text">
                    <strong>{{ flag }}</strong>
                    <span v-if="REAL.includes(flag)" class="tag real">真的触发</span>
                    <span v-else class="tag">注入</span>
                    <span v-if="forced.includes(flag)" class="tag forced">强制中</span>
                    <span class="block">{{ STATUS_ICONS[flag].label }}</span>
                    <span class="muted block">{{ MEANING[flag] }}</span>
                </span>
                <button type="button" @click="toggle(flag)">
                    {{ forced.includes(flag) ? "恢复真实判定" : "强制点亮" }}
                </button>
            </li>
        </ul>

        <h3>服务端报回来的状态</h3>
        <pre class="raw">{{ JSON.stringify(state, null, 2) }}</pre>
    </section>
</template>

<style scoped lang="scss">
.head h2 {
    margin: 0 0 6px;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
}

.actions .danger {
    border-color: var(--danger);
    color: var(--danger);
}

.list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.list li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}

.list li.on {
    border-color: var(--danger);
}

.list .icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
}

.list .icon img {
    width: 28px;
    height: 28px;
}

.text {
    flex: 1;
}

.block {
    display: block;
}

.tag {
    margin-left: 8px;
    padding: 0 6px;
    font-size: var(--font-size-xs);
    border: 1px solid var(--line);
    border-radius: 3px;
}

.tag.real {
    border-color: var(--ok);
    color: var(--ok);
}

.tag.forced {
    border-color: var(--danger);
    color: var(--danger);
}

.raw {
    max-height: 260px;
    padding: 10px;
    overflow: auto;
    font-size: var(--font-size-sm);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
}
</style>
