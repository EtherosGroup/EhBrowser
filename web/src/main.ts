/*
 * 前端入口。令牌与端口由服务端注入页面，客户端从 window.__EHBROWSER__ 读取
 * 弹出消息按界面配色固定为深色，位置固定右下，避免遮挡顶部状态栏
 */

import { createApp } from "vue";
import Vue3Toastify, { toast } from "vue3-toastify";
import "vue3-toastify/dist/index.css";

import App from "./App.vue";
import { router } from "./router.ts";
import "./style.scss";
import "./icons.scss";

createApp(App)
    .use(router)
    .use(Vue3Toastify, {
        position: toast.POSITION.BOTTOM_RIGHT,
        theme: toast.THEME.DARK,
        multiple: true,
        limit: 4,
    })
    .mount("#app");
