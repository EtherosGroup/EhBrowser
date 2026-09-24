<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

import { activeCount, refreshDownloads } from "./downloads.ts";
import { TABS } from "./router.ts";
import { hintAutoSearch } from "./auto-search.ts";
import { hintEscape, isEscapeShortcut, triggerEscape } from "./safety.ts";
import { proxyLabel, refreshStatus, startEventStream, version } from "./status.ts";
import { openWelcomeIfFirstRun } from "./welcome.ts";
import StatusIcons from "./components/StatusIcons.vue";
import WelcomeDialog from "./components/WelcomeDialog.vue";
import { startLocalLatencyProbe } from "./diagnostics.ts";

const route = useRoute();
let unsubscribe: (() => void) | null = null;
let stopLatencyProbe: (() => void) | null = null;

/** Ctrl + 空格 紧急避险。全局生效，因此挂在应用外壳上 */
function onKeydown(event: KeyboardEvent): void {
    if (!isEscapeShortcut(event)) {
        return;
    }
    event.preventDefault();
    triggerEscape();
}

onMounted(async () => {
    window.addEventListener("keydown", onKeydown);
    // 第一次打开先说明「这是免费软件」，读过一次就不再出现
    openWelcomeIfFirstRun();
    await refreshStatus();
    unsubscribe = startEventStream();
    // 「与 EhBrowser 的连接速度」只有浏览器测得了，服务端推来的状态里不含这一项
    stopLatencyProbe = startLocalLatencyProbe();
    // 徽标要有初值：事件只在任务变化时来
    void refreshDownloads();
    // 两条提示的文案都要读配置（避险地点、自动搜索开关），因此等配置读完再提示
    hintEscape();
    hintAutoSearch();
});

// 回到 EhBrowser 页面（搜索页）时也提示一次
watch(
    () => route.path,
    (path) => {
        if (path === "/") {
            hintEscape();
        }
    },
);

onUnmounted(() => {
    window.removeEventListener("keydown", onKeydown);
    unsubscribe?.();
    stopLatencyProbe?.();
});
</script>

<template>
    <header>
        <div class="brand">
            <strong>EhBrowser</strong>
            <span class="muted">v{{ version || "…" }}</span>
        </div>
        <nav>
            <RouterLink
                v-for="item in TABS"
                :key="item.path"
                :to="item.path"
                active-class="active"
                exact-active-class="active"
            >
                {{ item.label }}
            </RouterLink>
        </nav>
        <div class="status muted">代理：{{ proxyLabel }}</div>

        <!-- 下载入口。没有未结束的任务时不显示角标 -->
        <RouterLink class="downloads" to="/downloads" title="下载任务" aria-label="下载任务">
            <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 3v9" />
                <path d="M6 8.5 10 12.5l4-4" />
                <path d="M4 16h12" />
            </svg>
            <span v-if="activeCount > 0" class="badge">{{ activeCount }}</span>
        </RouterLink>
    </header>

    <main>
        <RouterView v-slot="{ Component, route }">
            <Transition name="page" mode="out-in">
                <!-- 按路径而不是完整地址作 key：查询串变化（分页、搜索条件）不该重建面板 -->
                <component :is="Component" :key="route.path" />
            </Transition>
        </RouterView>
    </main>

    <!-- 首次打开的提醒。挂在应用外壳上，因此哪个页面都会先看到 -->
    <StatusIcons />
    <WelcomeDialog />
</template>

<style scoped lang="scss">
header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
}

.brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
}

nav {
    display: flex;
    gap: 6px;
}

nav a {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 6px 12px;
    text-decoration: none;
}

nav a:hover {
    border-color: var(--accent);
    color: var(--accent);
}

nav a.active {
    border-color: var(--accent);
    color: var(--accent);
}

/* 下载入口：图标 + 右上角红色数量角标 */
.downloads {
    position: relative;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 4px;
}

.downloads:hover {
    border-color: var(--accent);
    color: var(--accent);
}

.downloads svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.downloads .badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 17px;
    padding: 0 4px;
    color: #fff;
    font-size: var(--font-size-xs);
    line-height: 17px;
    text-align: center;
    background: var(--danger);
    border-radius: 9px;
    box-shadow: 0 0 0 2px var(--panel);
}

.status {
    margin-left: auto;
}

main {
    padding: 20px;
}
</style>
