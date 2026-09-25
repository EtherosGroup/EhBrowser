<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import type { AccountSummary, AuthStatus, BrowserLoginPhase } from "../../../src/api/index.ts";
import { describeApiError, request } from "../api.ts";
import { parsePastedCookies } from "../cookie-text.ts";
import Dialog from "./Dialog.vue";
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

// 粘贴区
const pasted = ref("");
const ignoredCookies = ref<readonly string[]>([]);

// 两份凭据 cookie 必填
const credentialReady = computed(
    () => manualMemberId.value !== "" && manualPassHash.value !== "",
);

const showRecognition = computed(
    () => pasted.value.trim() !== "" || manualMemberId.value !== "" || manualPassHash.value !== "",
);

watch(pasted, (text) => {
    if (text.trim() === "") {
        ignoredCookies.value = [];
        return;
    }
    const result = parsePastedCookies(text);
    manualMemberId.value = result.cookies.ipbMemberId;
    manualPassHash.value = result.cookies.ipbPassHash;
    manualIgneous.value = result.cookies.igneous;
    ignoredCookies.value = result.ignored;
});

// ###[浏览器登录]####################################

const browserPhase = computed<BrowserLoginPhase>(() => status.value?.browserLogin.phase ?? "idle");
const browserNote = computed(() => status.value?.browserLogin.message ?? "");
const browserBusy = computed(
    () => browserPhase.value === "launching" || browserPhase.value === "waiting",
);
// 开窗前的确认弹窗
const askBrowserLogin = ref(false);

// 浏览器登录期间轮询状态
let pollTimer: number | null = null;

function stopBrowserPolling(): void {
    if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
}

async function pollBrowserLogin(): Promise<void> {
    try {
        const wasBusy = browserBusy.value;
        const next = await request("auth.status");
        status.value = next;
        if (wasBusy && !browserBusy.value) {
            stopBrowserPolling();
            accounts.value = [...(await request("auth.accounts.list"))];
            const { phase, message } = next.browserLogin;
            if (phase === "succeeded") {
                messenger.success(message);
            } else if (phase === "failed" || phase === "timeout") {
                messenger.warning(message);
            }
        }
    } catch (caught) {
        stopBrowserPolling();
        messenger.error(describeApiError(caught));
    }
}

function startBrowserLogin(): void {
    void (async () => {
        busy.value = true;
        try {
            status.value = await request("auth.browserLogin.start", {
                body: { site: site.value },
            });
            // 受理后才开始轮询
            stopBrowserPolling();
            pollTimer = window.setInterval(() => void pollBrowserLogin(), 1500);
        } catch (caught) {
            messenger.error(describeApiError(caught));
        } finally {
            busy.value = false;
        }
    })();
}

function cancelBrowserLogin(): void {
    void run(async () => {
        status.value = await request("auth.browserLogin.cancel");
    }, "已取消浏览器登录");
}

onUnmounted(stopBrowserPolling);

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

// 提示文案取决于取 igneous 的结果
async function importCookies(): Promise<void> {
    busy.value = true;
    try {
        const account = await request("auth.accounts.create", {
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
        pasted.value = "";
        ignoredCookies.value = [];
        manualLabel.value = "";
        manualMemberId.value = "";
        manualPassHash.value = "";
        manualIgneous.value = "";
        await load();
        if (account.igneousUpdatedAt === null) {
            messenger.warning(
                "账号已导入，但没取到 igneous：外站照常，里站不可用。换出口节点后重新导入即可",
            );
        } else {
            messenger.success("账号已导入，igneous 已取回");
        }
    } catch (caught) {
        messenger.error(describeApiError(caught));
    } finally {
        busy.value = false;
    }
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
    // 重载后接上轮询
    void load().then(() => {
        if (browserBusy.value) {
            pollTimer = window.setInterval(() => void pollBrowserLogin(), 1500);
        }
    });
});
</script>

<template>
    <section class="box">
        <div class="card">
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
        </div>

        <div class="card">
            <h2>账号密码登录</h2>
            <p class="muted">
                登录在论坛域完成，Cookie 保存在服务端。取不到 igneous 时通常需要更换出口节点。
                若提示「上游返回的是人机校验页」，说明当前节点过不了 Cloudflare 的人机校验，
                换密码没用 —— 请改用下面的「导入 Cookie」。
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

            <div class="browser-login">
                <button :disabled="busy || browserBusy" @click="askBrowserLogin = true">
                    用浏览器登录
                </button>
                <button v-if="browserBusy" :disabled="busy" @click="cancelBrowserLogin">取消</button>
                <span
                    v-if="browserNote !== ''"
                    class="note"
                    :class="{
                        ok: browserPhase === 'succeeded',
                        bad: browserPhase === 'failed' || browserPhase === 'timeout',
                    }"
                >
                    {{ browserNote }}
                </span>
            </div>
        </div>

        <div class="card">
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
        </div>

        <div class="card">
            <h2>导入 Cookie</h2>
            <p class="muted">
                在平时用的浏览器里登录后，把 Cookie 粘进来就行。只有 ipb_member_id 与 ipb_pass_hash
                是必填的；igneous 留空时服务端会自己去取，取不到只影响里站，外站照常。
            </p>
            <div class="paste">
                <label>粘贴 Cookie</label>
                <textarea
                    v-model="pasted"
                    rows="3"
                    spellcheck="false"
                    placeholder="ipb_member_id=123456; ipb_pass_hash=1a2b3c…; igneous=…"
                />
            </div>

            <ul v-if="showRecognition" class="recog">
                <li :class="manualMemberId === '' ? 'bad' : 'good'">
                    ipb_member_id —— {{ manualMemberId === "" ? "缺失（必填）" : "已识别" }}
                </li>
                <li :class="manualPassHash === '' ? 'bad' : 'good'">
                    ipb_pass_hash —— {{ manualPassHash === "" ? "缺失（必填）" : "已识别" }}
                </li>
                <li :class="manualIgneous === '' ? 'meh' : 'good'">
                    igneous —— {{ manualIgneous === "" ? "未提供，导入后由服务端取" : "已识别" }}
                </li>
                <li v-if="ignoredCookies.length > 0" class="meh">
                    已忽略 {{ ignoredCookies.length }} 项无关 cookie：{{ ignoredCookies.join("、") }}
                </li>
            </ul>

            <div class="grid">
                <div>
                    <label>ipb_member_id</label>
                    <input v-model="manualMemberId" spellcheck="false" />
                </div>
                <div>
                    <label>ipb_pass_hash</label>
                    <input v-model="manualPassHash" spellcheck="false" />
                </div>
                <div>
                    <label>igneous（可留空）</label>
                    <input v-model="manualIgneous" spellcheck="false" />
                </div>
                <div>
                    <label>备注</label>
                    <input v-model="manualLabel" />
                </div>
            </div>
            <div class="actions">
                <button :disabled="busy || !credentialReady" @click="importCookies">导入</button>
                <span class="muted">
                    导入为{{ site === "exhentai" ? "里站" : "外站" }}账号（与上面的「站点」共用一个选择）
                </span>
            </div>

            <details class="guide">
                <summary>从哪里拿这几个值？</summary>
                <ol>
                    <li>
                        先在自己平时用的浏览器里打开 e-hentai.org 并登录 —— 那边能过人机校验，
                        本程序的服务端不一定能。
                    </li>
                    <li>
                        按 <kbd>F12</kbd> 打开开发者工具，切到 <b>Application</b>（应用程序）→
                        <b>Storage</b> → <b>Cookies</b>。
                    </li>
                    <li>
                        选 <code>https://forums.e-hentai.org</code>（或 <code>https://e-hentai.org</code>），
                        复制 <code>ipb_member_id</code> 与 <code>ipb_pass_hash</code> 两行的值。
                    </li>
                    <li><code>igneous</code> 只在 <code>https://exhentai.org</code> 下面有；找不到就留空。</li>
                    <li>
                        嫌麻烦就用 cookie 导出插件（Cookie-Editor 之类）选「导出为 Cookie 字符串」，
                        整串粘到上面。
                    </li>
                </ol>
                <p class="muted">
                    整串直接粘，程序自己挑出这几项；其余会列出来，但不会保存、也不会发给上游。
                </p>
            </details>
        </div>

        <Dialog v-model="askBrowserLogin" title="通过浏览器登入账号">
            <p>
                接下来将会打开一个浏览器窗口，请您在这个窗口内登入您的账号，EhBrowser
                会自动查询登入状态并提取账户凭证，完成后浏览器窗口会自动关闭，请勿手动提前关闭
            </p>
            <template #buttons>
                <button
                    :disabled="busy"
                    @click="
                        askBrowserLogin = false;
                        startBrowserLogin();
                    "
                >
                    确定
                </button>
                <button @click="askBrowserLogin = false">取消</button>
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

.paste {
    margin-bottom: 12px;
}

/* 浏览器登录区 */
.browser-login {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
}

.browser-login .note {
    font-size: var(--font-size-sm);
    color: var(--muted);
}

.browser-login .note.ok {
    color: var(--ok);
}

.browser-login .note.bad {
    color: var(--danger);
}

/* 识别结果 */
.recog {
    display: grid;
    gap: 2px;
    margin: 0 0 12px;
    padding: 0;
    list-style: none;
    font-size: var(--font-size-sm);
}

.recog .good {
    color: var(--ok);
}

.recog .bad {
    color: var(--danger);
}

.recog .meh {
    color: var(--muted);
}

.guide {
    margin-top: 16px;
    font-size: var(--font-size-sm);
    color: var(--muted);
}

.guide summary {
    cursor: pointer;
    color: var(--accent);
}

.guide ol {
    display: grid;
    gap: 4px;
    margin: 8px 0;
    padding-left: 20px;
}

.guide li {
    line-height: 1.5;
}

.guide b {
    color: var(--text);
    font-weight: 500;
}

.guide kbd {
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 0 4px;
}
</style>
