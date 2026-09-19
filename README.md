# EhBrowser

PC 端的 E-Hentai 浏览器。形态是本地服务 + 浏览器界面：程序在本机启动一个只监听回环地址的服务，界面通过浏览器访问，账号 Cookie 全程留在服务端。

外站（e-hentai.org）与里站（exhentai.org）均支持。

## 环境要求

| 项      | 要求                                                                            |
| ------- | ------------------------------------------------------------------------------- |
| Node.js | >= 22.18.0（依赖原生 TypeScript 类型擦除，`node` 可直接运行 `.ts`）             |
| 网络    | 中国大陆直连 e-hentai.org 不可达，必须自备代理（HTTP / HTTPS，SOCKS5 暂不支持） |
| 账号    | E-Hentai 账号；访问里站需账号具备 ex 权限                                       |

运行时依赖 `undici`（HTTP 传输与代理）；`typescript`、`oxfmt` 仅用于开发。

## 安装

### 方式一：npm 全局安装

```bash
npm install -g ehbrowser
ehbrowser
```

安装后首次运行会创建配置目录与默认配置文件，并尝试用系统默认程序打开界面地址。

在克隆仓库前需注意：`main` 与 `bin` 指向构建产物，发布与安装均走 `dist/`。仓库源码中的 `.ts` 入口仅用于开发。

### 方式二：从源码运行

```bash
git clone https://github.com/EtherosGroup/EhBrowser.git
cd EhBrowser
npm install
npm start
```

`npm start` 直接运行 `src/main.ts`，无需构建。

## 使用

1. 启动服务，终端会输出本地地址（默认 `http://localhost:8787/`）与退出方式。
2. 浏览器打开该地址。
3. 首次使用需在界面中完成两项设置：
    - **代理**：填入可用的 HTTP 代理地址（SOCKS5 暂不支持）。未配置代理时所有上游请求都会超时。
    - **账号**：填入 E-Hentai 账号密码，或直接导入已有的 Cookie。
4. 之后正常浏览即可。配置改动即时生效，无需重启。

常用命令：

| 命令                   | 用途                             |
| ---------------------- | -------------------------------- |
| `npm start`            | 开发模式运行源码（无需构建）     |
| `npm run dev`          | 同上，附带文件监听自动重启       |
| `npm run build`        | 编译到 `dist/`，供安装与发布使用 |
| `npm run preview`      | 运行构建产物                     |
| `npm run config:path`  | 打印生效的数据目录与文件状态     |
| `npm run typecheck`    | 类型检查                         |
| `npm run format`       | Oxfmt 格式化（4 空格缩进）       |
| `npm run format:check` | 格式检查                         |

## 配置与数据目录

路径遵循各平台惯例，可用环境变量覆盖。

| 用途 | Linux                      | macOS                                     | Windows                          |
| ---- | -------------------------- | ----------------------------------------- | -------------------------------- |
| 配置 | `~/.config/ehbrowser`      | `~/Library/Application Support/ehbrowser` | `%APPDATA%\ehbrowser`            |
| 数据 | `~/.local/share/ehbrowser` | 同上                                      | `%LOCALAPPDATA%\ehbrowser`       |
| 缓存 | `~/.cache/ehbrowser`       | `~/Library/Caches/ehbrowser`              | `%LOCALAPPDATA%\ehbrowser\cache` |

目录内文件：

```
user_setting.json    用户偏好，权限 0644，可直接编辑
auth_setting.json    账号与 Cookie，权限 0600，含密钥
ehbrowser.db         SQLite：程序标记、画廊缓存、下载任务、阅读进度
```

环境变量覆盖，优先级由高到低：

```
EHBROWSER_CONFIG_DIR / EHBROWSER_DATA_DIR / EHBROWSER_CACHE_DIR   分项覆盖
EHBROWSER_HOME                                                    便携模式，三者在 <HOME>/ 下
XDG_CONFIG_HOME 等                                                系统默认
```

`EHBROWSER_HOME=<目录>` 可把全部数据收进单个目录，便于随身携带或隔离测试。

配置文件结构：

```jsonc
// user_setting.json
{
    "schemaVersion": 1,
    "locale": "zh-CN",
    "preferredSite": "e-hentai", // e-hentai | exhentai
    "network": {
        "requestIntervalMs": 5000, // 序列请求间隔，上游建议连发 4～5 次后等待约 5 秒
        "maxSequentialRequests": 5,
        "requestTimeoutMs": 30000,
        "proxy": { "enabled": false, "protocol": "http", "host": "127.0.0.1", "port": 7897 },
    },
    "viewer": { "mode": "mpv", "imageQuality": "org", "preloadCount": 2 },
    "download": {
        "directory": "",
        "keepArchive": true,
        "preferredResolution": "org",
        "concurrency": 2,
    },
    "ui": { "theme": "system", "thumbnailSize": 250, "pageSize": 25 },
}
```

配置文件损坏时会被改名为 `*.corrupt-<时间戳>` 并回退默认值，程序照常启动；迁移前会生成 `*.bak-<时间戳>`。

## 账号与 Cookie

- Cookie 仅存于服务端进程与 `auth_setting.json`，不会下发到浏览器，界面只能读到登录状态摘要。
- 所有上游请求由服务端代理转发，浏览器不直连 E-Hentai。
- `igneous` 为里站通行证，有效期约一个月。为空通常表示登录时所用出口节点不适用，需更换节点后重新登录。

## 项目结构

```
src/
├── main.ts        入口
├── server.ts      本地 HTTP 服务
├── api/           服务端与浏览器之间的接口契约（信封、路由表、DTO、SSE 事件）
├── eh/            上游客户端：代理、Cookie 注入、请求节流、重定向与访问拒绝判定
├── config/        持久化：JSON 存储管线、schema、迁移、校验、SQLite
├── platform/      平台差异：系统识别、数据目录解析、外部程序打开
└── services/      业务编排：配置修改请求的校验、串行、脱敏与广播
```

依赖方向单向：`main → api → services → config → platform`。上游客户端 `eh/` 独立于以上各层，仅由 `services/` 调用。

## 开发约定

- ESM，`"type": "module"`；相对导入必须带扩展名且写 `.ts`（如 `import { x } from "./os.ts"`），编译时由 `rewriteRelativeImportExtensions` 改写为 `.js`。
- 启用 `erasableSyntaxOnly`：不使用 `enum`、`namespace`、构造函数参数属性等无法被类型擦除的语法。
- 代码由 Oxfmt 统一格式化，缩进 4 空格。
- 源码 `src/` 不进入发布包，`files` 仅包含 `dist`。

## 当前状态

| 层                      | 状态                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `platform/`             | 已实现：平台识别、数据目录解析、外部程序打开                                                |
| `config/`               | 已实现：JSON 存储管线、schema、迁移、校验、SQLite 数据层                                    |
| `api/`                  | 已实现：契约层（26 条路由、信封、DTO、SSE 事件定义）                                        |
| `eh/`                   | 已实现：传输层（代理、Cookie 注入、节流、重定向处理）；gdata / gtoken / showpage 封装未实现 |
| `services/`             | 未实现                                                                                      |
| `server.ts` / `main.ts` | 未实现，当前为占位                                                                          |

因此当前 `npm start` 不会启动服务，界面与路由尚未接入。安装与使用流程按上述目标形态编写，待服务层完成后生效。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
