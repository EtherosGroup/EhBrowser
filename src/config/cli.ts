/* npm run config:path：打印生效的三条目录与文件状态 */

import { existsSync } from "node:fs";

import { databaseFile } from "./db.ts";
import { describePaths, initPaths } from "../platform/paths.ts";
import { authSettingFile } from "./auth-setting.ts";
import { userSettingFile } from "./user-setting.ts";

const paths = initPaths();

console.log(describePaths(paths));
console.log();

const files = [
    userSettingFile(paths.configDir),
    authSettingFile(paths.configDir),
    databaseFile(paths.dataDir),
];

for (const file of files) {
    console.log(`${existsSync(file) ? "有" : "无"}  ${file}`);
}

console.log();
console.log("优先级：EHBROWSER_CONFIG_DIR 等 > EHBROWSER_HOME > 系统默认");
