<script setup lang="ts">
import { onMounted, ref } from "vue";

import type { AccountSummary, AuthStatus } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { messenger } from "../messenger.ts";

const status = ref<AuthStatus | null>(null);
const accounts = ref<AccountSummary[]>([]);
const busy = ref(false);

const username = ref("");
const password = ref("");
const site = ref<"e-hentai" | "exhentai">("e-hentai");

const manualLabel = ref("");
const manualMemberId = ref("");
const manualPassHash = ref("");
const manualIgneous = ref("");

async function load(): Promise<void> {
    try {
        status.value = await request("auth.status");
        accounts.value = [...(await request("auth.accounts.list"))];
    } catch (caught) {
        messenger.error(describeApiError(caught));
    }
}

async function run(action: () => Promise<void>, done: string): Promise<void> {
    busy.value = true;
    try {
        await action();
        await load();
        messenger.success(done);
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
}

function login(): void {
    void run(async () => {
        status.value = await request("auth.login", {
            body: { username: username.value, password: password.value, site: site.value },
        });
        password.value = "";
    }, "登录完成");
}

function importCookies(): void {
    void run(async () => {
        await request("auth.accounts.create", {
            body: {
                label: manualLabel.value === "" ? "导入的账号" : manualLabel.value,
                site: site.value,
                cookies: {
                    ipbMemberId: manualMemberId.value,
                    ipbPassHash: manualPassHash.value,
                    igneous: manualIgneous.value,
                },
            },
        });
        manualMemberId.value = "";
        manualPassHash.value = "";
        manualIgneous.value = "";
    }, "账号已导入");
}

function logout(): void {
    void run(async () => {
        status.value = await request("auth.logout");
    }, "已清除登录态");
}

function activate(id: string): void {
    void run(async () => {
        status.value = await request("auth.accounts.activate", { params: { accountId: id } });
    }, "已切换账号");
}

function remove(id: string): void {
    void run(async () => {
        await request("auth.accounts.remove", { params: { accountId: id } });
    }, "账号已删除");
}

onMounted(() => {
    void load();
});
</script>

<template>
    <section class="box">
        <h2>登录状态</h2>
        <dl v-if="status">
            <dt>已登录</dt>
            <dd>{{ status.loggedIn ? "是" : "否" }}</dd>
            <dt>当前账号</dt>
            <dd>{{ status.activeAccount?.label ?? "—" }}</dd>
            <dt>账号数</dt>
            <dd>{{ status.accountCount }}</dd>
            <dt>igneous</dt>
            <dd>
                <template v-if="status.igneousAgeDays === null">未知</template>
                <template v-else>
                    已 {{ status.igneousAgeDays }} 天
                    <span v-if="status.igneousStale" class="err">（临近过期，建议重新登录）</span>
                </template>
            </dd>
            <dt>里站可达</dt>
            <dd>
                {{ status.exAccessible === null ? "未探测" : status.exAccessible ? "是" : "否" }}
            </dd>
        </dl>

        <h2>账号密码登录</h2>
        <p class="muted">
            登录在论坛域完成，Cookie 保存在服务端。取不到 igneous 时通常需要更换出口节点。
        </p>
        <div class="grid">
            <div>
                <label>用户名</label>
                <input v-model="username" autocomplete="username" />
            </div>
            <div>
                <label>密码</label>
                <input v-model="password" type="password" autocomplete="current-password" />
            </div>
            <div>
                <label>站点</label>
                <select v-model="site">
                    <option value="e-hentai">外站</option>
                    <option value="exhentai">里站</option>
                </select>
            </div>
        </div>
        <div class="actions">
            <button :disabled="busy || username === '' || password === ''" @click="login">
                登录
            </button>
            <button :disabled="busy" @click="logout">清除登录态</button>
        </div>

        <h2>已有账号</h2>
        <table v-if="accounts.length > 0">
            <thead>
                <tr>
                    <th>备注</th>
                    <th>站点</th>
                    <th>当前</th>
                    <th>igneous</th>
                    <th>api key</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="account in accounts" :key="account.id">
                    <td>{{ account.label }}</td>
                    <td>{{ account.site === "exhentai" ? "里站" : "外站" }}</td>
                    <td>{{ account.active ? "✓" : "" }}</td>
                    <td>
                        {{
                            account.igneousUpdatedAt === null
                                ? "—"
                                : new Date(account.igneousUpdatedAt * 1000).toLocaleDateString()
                        }}
                    </td>
                    <td>{{ account.hasApiKey ? "有" : "无" }}</td>
                    <td class="ops">
                        <button :disabled="busy || account.active" @click="activate(account.id)">
                            切换
                        </button>
                        <button :disabled="busy" @click="remove(account.id)">删除</button>
                    </td>
                </tr>
            </tbody>
        </table>
        <p v-else class="muted">暂无账号。</p>

        <h2>导入 Cookie</h2>
        <p class="muted">从别处已有的登录态导入，三项均为必填。</p>
        <div class="grid">
            <div>
                <label>备注</label>
                <input v-model="manualLabel" />
            </div>
            <div>
                <label>ipb_member_id</label>
                <input v-model="manualMemberId" />
            </div>
            <div>
                <label>ipb_pass_hash</label>
                <input v-model="manualPassHash" />
            </div>
            <div>
                <label>igneous</label>
                <input v-model="manualIgneous" />
            </div>
        </div>
        <div class="actions">
            <button
                :disabled="
                    busy || manualMemberId === '' || manualPassHash === '' || manualIgneous === ''
                "
                @click="importCookies"
            >
                导入
            </button>
        </div>
    </section>
</template>

<style scoped lang="scss">
.box {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 16px;
}

h2 {
    margin: 0 0 8px;
    font-size: var(--font-size-base);
    color: var(--accent);
}

h2:not(:first-child) {
    margin-top: 22px;
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
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
}

table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-md);
}

th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    padding: 4px 8px 4px 0;
}

td {
    padding: 4px 8px 4px 0;
    border-top: 1px solid var(--line);
}

.ops {
    display: flex;
    gap: 6px;
}

.ops button {
    padding: 2px 8px;
    font-size: var(--font-size-sm);
}

.actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 14px;
}
</style>
