/*
 * 开发入口：一条命令同时启动前端 watch 构建与本地服务。
 *
 * 前端产物仍由本地服务托管，因此只有一个源，Origin 校验与令牌注入保持原样。
 * 服务进程带 --watch，服务端源码改动后自动重启；前端源码改动后自动重新构建，刷新页面即可生效。
 * 额外参数转交给服务进程，例如 npm run dev -- --port 9000。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** 结束子进程的宽限时间，超时后强杀 */
const KILL_GRACE_MS = 3000;

interface Task {
    readonly name: string;
    readonly child: ChildProcess;
    /** 输出按行切分，避免半行被标记 */
    pending: string;
    exited: boolean;
}

const tasks: Task[] = [];
let stopping = false;

function start(name: string, args: readonly string[]): void {
    const child = spawn(process.execPath, [...args], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const task: Task = { name, child, pending: "", exited: false };
    tasks.push(task);

    child.stdout?.on("data", (chunk: Buffer) => forward(task, chunk));
    child.stderr?.on("data", (chunk: Buffer) => forward(task, chunk));
    child.on("error", (error) => {
        write(name, `启动失败：${error.message}`);
        stop(1);
    });
    child.on("exit", (code, signal) => {
        task.exited = true;
        flush(task);
        if (stopping) {
            return;
        }
        write(name, `已退出（code=${code ?? "-"}，signal=${signal ?? "-"}）`);
        // 任何一个子进程结束时都停止全部子进程，避免另一个继续占用端口或写入文件
        stop(code ?? 1);
    });
}

function forward(task: Task, chunk: Buffer): void {
    task.pending += chunk.toString();
    const lines = task.pending.split("\n");
    task.pending = lines.pop() ?? "";
    for (const line of lines) {
        if (line.trim() !== "") {
            write(task.name, line);
        }
    }
}

function flush(task: Task): void {
    if (task.pending.trim() !== "") {
        write(task.name, task.pending);
    }
    task.pending = "";
}

function write(name: string, line: string): void {
    process.stdout.write(`[${name}] ${line}\n`);
}

function stop(code: number): void {
    if (stopping) {
        return;
    }
    stopping = true;
    process.exitCode = code;
    write("dev", "正在停止子进程");

    for (const task of tasks) {
        if (!task.exited) {
            task.child.kill("SIGTERM");
        }
    }
    const timer = setTimeout(() => {
        for (const task of tasks) {
            if (!task.exited) {
                task.child.kill("SIGKILL");
            }
        }
    }, KILL_GRACE_MS);
    timer.unref();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const require = createRequire(import.meta.url);
// 直接调 vite 的 JS 入口，不依赖 shell 与 PATH，Windows 上同样适用
const viteEntry = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");

write("dev", "前端 watch 构建 + 本地服务；改动前端后刷新页面");
start("web", [viteEntry, "build", "--watch"]);
start("server", ["--watch", join(root, "src", "main.ts"), ...process.argv.slice(2)]);
