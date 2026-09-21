/*
 * 便携包：将构建产物、生产依赖与启动脚本打包为一个 zip，解压即用。
 * 包内不含 Node 运行时，目标机器需安装 node ≥ 22.18.0。
 *
 * 与 npm 安装的区别仅在数据位置：启动脚本把 EHBROWSER_HOME 指向包内目录，
 * 配置、数据库、下载与缓存均保存在包内（便携版）；删除该两行即恢复按用户目录存放。
 *
 * zip 由本脚本自行生成。项目不引入第三方依赖，Node 亦无内置的 zip 写入能力（仅 zlib），
 * 因此按 PKZIP 格式手工拼接文件头与中央目录，文件名标记为 UTF-8（启动脚本名为中文）。
 *
 * 用法：npm run release:portable（含构建），产物位于 release/。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const releaseDir = join(root, "release");

/** ./dist 与 package.json 里的生产依赖是包的内容 */
async function collectInputs() {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const shell = "启动.sh";
    const batch = "启动.bat";
    const readme = "使用说明.txt";
    return { pkg, shell, batch, readme };
}

/** 递归列目录，返回相对路径（字典序，产物因此可复现） */
async function walk(dir, base = dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...(await walk(full, base)));
            continue;
        }
        if (entry.isFile()) {
            out.push(relative(base, full));
        }
    }
    return out.sort();
}

async function copyFile(from, to) {
    await mkdir(join(to, ".."), { recursive: true });
    await writeFile(to, await readFile(from));
}

/** 把 srcDir 目录树复制到 destDir 下 */
async function copyTree(srcDir, destDir) {
    for (const rel of await walk(srcDir)) {
        await copyFile(join(srcDir, rel), join(destDir, rel));
    }
}

// ── 最小 zip 写入 ──────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let bit = 0; bit < 8; bit += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

/** DOS 时间，zip 使用的旧格式。固定为构建时刻即可 */
function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

/**
 * 把一个目录写成 zip
 * 条目统一带上 prefix（即包名目录），解压后得到的是一个文件夹，而不是散落在当前目录的文件
 * 压缩方式只用「存 / deflate」两种，版本号固定为 20，不使用 zip64（包体积远小于 4GB）
 */
async function zipDirectory(sourceDir, zipPath, prefix) {
    const files = await walk(sourceDir);
    const now = new Date();
    const { time, day } = dosDateTime(now);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const rel of files) {
        const name = prefix + rel.split(sep).join("/");
        const nameBytes = Buffer.from(name, "utf8");
        const data = await readFile(join(sourceDir, rel));
        const mode = (await stat(join(sourceDir, rel))).mode & 0o777;
        const deflated = data.length > 0 ? deflateRawSync(data) : Buffer.alloc(0);
        // 压缩后体积未减小，按原样存储
        const stored = deflated.length >= data.length;
        const payload = stored ? data : deflated;
        const method = stored ? 0 : 8;
        const checksum = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // 解压所需版本
        local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x031e, 4); // 由 unix 生成，版本 3.0
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // 起始磁盘
        central.writeUInt16LE(0, 36); // 内部属性
        central.writeUInt32LE((mode << 16) >>> 0, 38); // 外部属性：保留可执行位
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    const zip = Buffer.concat([...locals, ...centrals, end]);
    await mkdir(join(zipPath, ".."), { recursive: true });
    await writeFile(zipPath, zip);
    return { bytes: zip.length, files: files.length };
}

// ── 组装 ──────────────────────────────────────────────────────

const { pkg, shell, batch, readme } = await collectInputs();
const appName = `${pkg.name === "ehbrowser" ? "EhBrowser" : pkg.name}-${pkg.version}`;
const stage = join(releaseDir, appName);

try {
    await stat(join(root, "dist", "main.js"));
    await stat(join(root, "dist", "web", "index.html"));
} catch {
    console.error("没找到 dist/ 构建产物：先跑 npm run build（或用 npm run release:portable）");
    process.exit(1);
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

await copyTree(join(root, "dist"), join(stage, "dist"));
for (const file of ["LICENSE", "README.md", "package.json"]) {
    await copyFile(join(root, file), join(stage, file));
}

/** 生产依赖：只带 package.json 中 dependencies 列出的包（undici 自身没有依赖） */
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
for (const name of runtimeDeps) {
    const from = join(root, "node_modules", name);
    try {
        await stat(from);
    } catch {
        console.error(`缺少生产依赖 node_modules/${name}：先跑 npm ci`);
        process.exit(1);
    }
    await copyTree(from, join(stage, "node_modules", name));
}

/*
 * POSIX 启动脚本，负责三件事：
 *   1. 解析脚本自身的真实位置。软链接同样处理：dirname "$0" 在软链接下指向链接所在目录，
 *      node 会到该侧查找 dist/main.js，实测报 Cannot find module。
 *   2. 未安装 node 时给出提示，而不是直接输出 command not found。
 *   3. 将 EHBROWSER_HOME 指向包内目录，构成便携版。
 */
await writeFile(
    join(stage, shell),
    [
        "#!/bin/sh",
        "# EhBrowser 便携启动脚本",
        "# 数据（配置、数据库、缓存、下载）保存于本目录。",
        "# 如需按用户目录存放，删除下面 EHBROWSER_HOME 两行。",
        "",
        "# 解析脚本自身的真实位置，软链接链同样处理。",
        'target="$0"',
        'while [ -L "$target" ]; do',
        '    link="$(readlink "$target")"',
        '    case "$link" in',
        '        /*) target="$link" ;;',
        '        *) target="$(dirname "$target")/$link" ;;',
        "    esac",
        "done",
        'cd "$(dirname "$target")" || exit 1',
        "",
        "if ! command -v node >/dev/null 2>&1; then",
        '    echo "找不到 node：请先安装 Node.js 22.18.0 或更高版本（https://nodejs.org/）" >&2',
        "    exit 1",
        "fi",
        "",
        'EHBROWSER_HOME="$(pwd)"',
        "export EHBROWSER_HOME",
        'echo "数据目录：$EHBROWSER_HOME"',
        'exec node dist/main.js "$@"',
        "",
    ].join("\n"),
);
await chmod(join(stage, shell), 0o755);

/*
 * Windows 启动脚本。正文一律使用 ASCII。
 * cmd 按当前代码页读取批处理，UTF-8 中文在 GBK 环境下会显示为乱码。
 * 路径统一加引号：Windows 路径常含空格与括号，不加引号会被 cmd 拆开。
 */
await writeFile(
    join(stage, batch),
    [
        "@echo off",
        "rem EhBrowser portable launcher",
        "rem Portable mode: configuration, database, cache and downloads are kept in this folder.",
        "rem Removing the EHBROWSER_HOME line below switches to the per-user directories.",
        "setlocal",
        'cd /d "%~dp0"',
        'set "EHBROWSER_HOME=%~dp0"',
        "where node >nul 2>nul",
        "if errorlevel 1 (",
        "    echo Node.js not found. Install Node.js 22.18.0 or newer: https://nodejs.org/",
        "    pause",
        "    exit /b 1",
        ")",
        "echo Data folder: %EHBROWSER_HOME%",
        'node "%~dp0dist\\main.js" %*',
        "pause",
        "",
    ].join("\r\n"),
);

await writeFile(
    join(stage, readme),
    [
        `EhBrowser ${pkg.version} 便携包`,
        "",
        "怎么用：",
        "  1. 机器上要有 Node.js 22.18.0 或更高版本（node -v 可查）。",
        "  2. Linux / macOS：双击或执行 ./启动.sh；Windows：双击 启动.bat。",
        "     若提示没有执行权限，先 chmod +x 启动.sh，或者直接 sh 启动.sh。",
        "  3. 浏览器打开终端里打印的地址（默认 http://localhost:7727/）。",
        "  4. 进去后先在设置页填代理、在账号页登录，否则上游连不上。",
        "",
        "数据放在这个目录里（config/ data/ 子目录），整个文件夹可以随意搬动或删掉。",
        "想用系统统一的数据目录，编辑启动脚本去掉 EHBROWSER_HOME 那一行。",
        "",
        "这是免费软件，采用 Apache License 2.0（见 LICENSE）。",
        "任何人向你收费出售本软件，请到 https://github.com/EtherosGroup/EhBrowser 免费获取。",
        "",
    ].join("\n"),
);

const zipPath = join(releaseDir, `${appName}-portable.zip`);
const { bytes, files } = await zipDirectory(stage, zipPath, `${appName}/`);
const digest = createHash("sha256")
    .update(await readFile(zipPath))
    .digest("hex");

console.log(`便携包已生成：${relative(root, zipPath)}`);
console.log(`  目录：${relative(root, stage)}`);
console.log(`  文件：${files} 个，压缩后 ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  SHA-256：${digest}`);
