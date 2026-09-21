/*
 * Vite 配置。前端源码在 web/，产物直接落到 dist/web
 * 页面里的 window.__EHBROWSER__ 由服务端注入，故不做任何环境变量替换
 */

import { fileURLToPath } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
    root: fileURLToPath(new URL("./web", import.meta.url)),
    plugins: [vue()],
    build: {
        outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
        emptyOutDir: true,
        // 本地服务场景，无需考虑旧浏览器
        target: "esnext",
        sourcemap: false,
    },
    server: {
        // 仅用于 npm run dev:web 的 watch 构建，不启动开发服务器
        port: 5273,
    },
});
