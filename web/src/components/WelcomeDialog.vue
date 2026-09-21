<script setup lang="ts">
/*
 * 首次打开的提醒。内容固定，用于说明本软件免费，并给出可以提问的渠道（仓库 Issues / QQ 群）
 * 开关只在组件自身这一层管理：是否首次打开由 welcome.ts 记录，打开与关闭都经过这里
 */

import { dismissWelcome, welcomeOpen } from "../welcome.ts";
import Dialog from "./Dialog.vue";

const REPO = "https://github.com/EtherosGroup/EhBrowser";
/** QQ 群号，可在群里询问安装与使用问题 */
const QQ_GROUP = "597399171";
</script>

<template>
    <Dialog
        :model-value="welcomeOpen"
        title="这是免费软件"
        width="620px"
        @update:model-value="dismissWelcome"
    >
        <p>这是一个免费软件，如果是购买的那么你被骗啦哈哈哈！</p>
        <p>
            如果商家给你的安装包里没有 LICENSE 文件，请到
            <a :href="REPO" target="_blank" rel="noreferrer">{{ REPO }}</a>
            提交 Issues，或者到 QQ 群
            {{ QQ_GROUP }} 提交帮助请求，别嫌麻烦，你就不想当一把爽文男主狠狠制裁导狗吗？
        </p>
        <p>
            如果确实有 LICENSE 文件，那么你应该意识到这个软件可以免费下载（
            <a :href="REPO" target="_blank" rel="noreferrer">{{ REPO }}</a>
            这里还有详细的安装说明），赶紧退货吧！
        </p>
        <p>最后祝愿各位机长愉快起飞～</p>

        <template #buttons>
            <button @click="dismissWelcome">知道了</button>
        </template>
    </Dialog>
</template>

<style scoped lang="scss">
p {
    margin: 0;
}

p + p {
    margin-top: 10px;
}

/* 长链接需要折行，否则会把弹窗撑宽 */
a {
    word-break: break-all;
}
</style>
