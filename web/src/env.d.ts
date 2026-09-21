/*
 * 前端类型补充。Vue 单文件组件由 Vite 处理，这里只给 TypeScript 一个声明。
 */

declare module "*.vue" {
    import type { DefineComponent } from "vue";

    const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
    export default component;
}

interface EhBrowserBoot {
    readonly token: string;
    readonly port: number;
}

interface Window {
    /** 由服务端注入。 */
    readonly __EHBROWSER__?: EhBrowserBoot;
}
