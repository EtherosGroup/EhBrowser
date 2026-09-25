<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import type { PathsInfo, SystemHealth } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { loadLogs, logDirectory, logEnabled, logEntries, logFileName, logTime } from "../logs.ts";
import { messenger } from "../messenger.ts";
import { events, refreshStatus } from "../status.ts";
import Dialog from "./Dialog.vue";

const health = ref<SystemHealth | null>(null);
/** 日志按「时间 级别 来源 消息」逐行显示，与文件里的写法一致 */
const logText = computed(() =>
    logEntries.value.length === 0
        ? "（暂无）"
        : logEntries.value
              .map((entry) => {
                  const tag = entry.tag === "" ? "" : `[${entry.tag}] `;
                  return `${logTime(entry.at)} [${entry.level}] ${tag}${entry.message}`;
              })
              .join("\n"),
);
const paths = ref<PathsInfo | null>(null);
/** 关闭服务器的二次确认 */
const askShutdown = ref(false);
const closing = ref(false);

/** 关闭服务：响应先返回，进程随后自行退出，界面只需提示结果 */
async function shutdown(): Promise<void> {
    closing.value = true;
    try {
        await request("system.shutdown");
        askShutdown.value = false;
        messenger.info("服务器已关闭。下次使用 EhBrowser 需要先启动服务器");
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        closing.value = false;
    }
}

async function load(): Promise<void> {
    try {
        health.value = await request("system.health");
        paths.value = await request("config.paths");
        await refreshStatus();
        await loadLogs();
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

onMounted(() => {
    void load();
});
</script>

<template>
    <section class="box">
        <div class="card">
            <h2>服务</h2>
            <dl v-if="health">
                <dt>状态</dt>
                <dd>{{ health.status }}</dd>
                <dt>版本</dt>
                <dd>{{ health.version }}</dd>
                <dt>Node</dt>
                <dd>{{ health.nodeVersion }}</dd>
                <dt>平台</dt>
                <dd>{{ health.platform }}</dd>
                <dt>已运行</dt>
                <dd>{{ health.uptimeSeconds }} 秒</dd>
            </dl>
        </div>

        <div class="card">
            <h2>数据目录</h2>
            <dl v-if="paths">
                <dt>config</dt>
                <dd>
                    {{ paths.configDir }} <span class="muted">({{ paths.sources.configDir }})</span>
                </dd>
                <dt>data</dt>
                <dd>
                    {{ paths.dataDir }} <span class="muted">({{ paths.sources.dataDir }})</span>
                </dd>
                <dt>cache</dt>
                <dd>
                    {{ paths.cacheDir }} <span class="muted">({{ paths.sources.cacheDir }})</span>
                </dd>
            </dl>
        </div>

        <div class="card">
            <h2>日志</h2>
            <dl>
                <dt>目录</dt>
                <dd>{{ logDirectory === "" ? "读取中…" : logDirectory }}</dd>
                <dt>文件</dt>
                <dd>{{ logFileName === "" ? "读取中…" : logFileName }}</dd>
                <dt>写入</dt>
                <dd>
                    {{ logEnabled ? "已开启（按天一个文件）" : "已关闭，只在控制台与这里显示" }}
                    <span class="muted">· 可在设置 &gt; 日志里改目录</span>
                </dd>
            </dl>
            <pre class="logs">{{ logText }}</pre>
        </div>

        <div class="card">
            <h2>事件流</h2>
            <pre>{{ events.length === 0 ? "（暂无）" : events.join("\n") }}</pre>
        </div>

        <div class="actions">
            <button @click="load">重新读取</button>
            <button class="danger" @click="askShutdown = true">关闭服务器</button>
        </div>

        <Dialog v-model="askShutdown" title="关闭服务器">
            <p>要关闭服务器吗？下次使用 EhBrowser 时需要先启动服务器。</p>
            <template #buttons>
                <button :disabled="closing" @click="askShutdown = false">取消</button>
                <button :disabled="closing" @click="shutdown">
                    {{ closing ? "关闭中…" : "确定" }}
                </button>
            </template>
        </Dialog>
    </section>
</template>

<style scoped lang="scss">
/* 页面：各区域各成一块 */
.box {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 14px 16px;
}

h2 {
    margin: 0 0 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
    font-size: var(--font-size-base);
    color: var(--accent);
}

dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 14px;
    margin: 0;
    font-size: var(--font-size-md);
}

dt {
    color: var(--muted);
}

dd {
    margin: 0;
    word-break: break-all;
}

pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    font-size: var(--font-size-md);
    color: var(--muted);
    white-space: pre-wrap;
    word-break: break-all;
}

/* 日志比事件流长，多留一点高度 */
pre.logs {
    max-height: 320px;
    margin-top: 8px;
    padding: 8px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.actions .danger:hover:not(:disabled) {
    border-color: var(--danger);
    color: var(--danger);
}
</style>
