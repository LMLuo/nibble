# nibble-cb —— Nibble 风格陪伴小生物（CodeBuddy 原生插件）

这是 **CodeBuddy 经典插件体系**版本（`.codebuddy-plugin/plugin.json` + `hooks/hooks.json` + `commands/`），
可以在**当前这台 CodeBuddy IDE** 里真正加载运行。

> **已废弃的实现**：早期另有一份 `nibble-mod/`（Claude Code **Mods 运行时**版：`register.ts` +
> `on('prompt.submit')` + `Raster` 真彩渲染），那是 Claude Code 2.1.290+ 的能力，本机 CodeBuddy
> 不支持（`~/.codebuddy` 下搜 `prompt.submit`/`ui.render`/`AbovePrompt` 命中 0），从未在本机跑起来过。
> 该目录已于 **2026-10-09 明确废弃并删除**；其中**不可再生**的素材源图与转换工具归档在
> [`legacy-mods/`](legacy-mods/)（含归档说明与素材重建命令）。

一只彩色像素小生物常驻**状态栏**（逐帧浮动动画）；你每次向 CodeBuddy 提问（`UserPromptSubmit` 节拍）就攻击一次野生敌人，
并弹出一行战斗日志；打空血击败/捕获后刷新更强的下一只。等级/经验/战绩与当前敌人**跨会话存档**。

## 能力一览

| 能力 | 实现方式 |
|---|---|
| 运行环境 | ✅ 本机 CodeBuddy IDE（VS Code 内核） |
| 像素小生物位置 | 底部**状态栏**小头像 + **底部面板** Webview（真彩 24×24） |
| 完整 24×24 战场 | 底部面板 / 编辑器标签页（真彩，逐帧动画） |
| 每问一行战斗日志 | `UserPromptSubmit` hook → `systemMessage`（仅用户可见、不进上下文、**不耗 token**） |
| 待机动画 | 状态栏按时间取帧；面板逐帧刷新 |
| 跨会话存档 | `~/.codebuddy/plugins/data/nibble/save.json` |

## 目录结构

```
nibble-cb/                          # 本地市场根目录（/plugin marketplace add 指向这里）
├── .codebuddy-plugin/
│   └── marketplace.json               # 市场清单（name/owner/plugins）
└── plugins/
    └── nibble/                     # 插件根目录
        ├── .codebuddy-plugin/plugin.json
        ├── hooks/
        │   ├── hooks.json             # SessionStart / UserPromptSubmit / SessionEnd
        │   ├── cli.js                 # hook 与命令的统一入口
        │   ├── statusline.js          # 状态栏渲染（像素小生物 + HP 条 + 等级）
        │   ├── setup.js               # 把 statusLine 写进 ~/.codebuddy/settings.json
        │   ├── nibble.js           # 战斗核心 + 存档 + 渲染
        │   └── pixels.js              # 24×24 像素素材（AI 生成原创，CC0）
        └── commands/
            ├── nibble.md            # /nibble:nibble [attack|reset]
            └── nibble-setup.md      # /nibble:nibble-setup
```

## 安装（4 步）

```text
# 1. 添加本地市场（指向 nibble-cb 目录）
/plugin marketplace add "f:/A投标/天津轻工业技术职业学院远程实训平台/nibble-cb"

# 2. 安装插件
/plugin install nibble@nibble-cb

# 3. 让插件生效（无需重启）
/reload-plugins

# 4. 把像素小生物写进状态栏
/nibble:nibble-setup
```

第 4 步会向 `~/.codebuddy/settings.json` 写入：

```json
{ "statusLine": { "type": "command", "command": "node \"<插件目录>/hooks/statusline.js\"" } }
```

若状态栏没立刻出现：重启 CodeBuddy，或运行 `/statusline` 检查配置。也可以手动添加上面这段。

## 使用

| 操作 | 说明 |
|---|---|
| 向 CodeBuddy 提问 | 触发一次攻击，弹出一行战斗日志（如 `⚔ Nibble 攻击！野生 蝙蝠 -9 HP`）|
| `/nibble:nibble` | 显示完整战场卡片（24×24 灰度像素 + HP 条 + 等级/经验/战绩）|
| `/nibble:nibble attack` | 手动补一刀，并显示卡片 |
| `/nibble:nibble reset` | 清空等级/经验/战绩与存档，重新开始 |

## 成长与存档（Roguelite）

| 项 | 规则 |
|---|---|
| 玩家攻击力 | `4 + 等级 × 2` |
| 敌人 HP | `30 + (等级-1) × 8 + rand(16)` |
| 稀有度 | 随等级小幅提升出金概率（每级 +1%，上限 +12%）|
| 经验 | 击败获得 `8 + 敌人最大 HP`；升级所需经验 `20 + (等级-1) × 15`，可连续升级 |
| 存档 | `${CODEBUDDY_PLUGIN_DATA}/save.json`（默认 `~/.codebuddy/plugins/data/nibble/save.json`）|
| 落盘时机 | 每次攻击后、`SessionStart`、`SessionEnd` |

## 隐私

- `UserPromptSubmit` hook **只把 stdin 排空**，**从不解析** `prompt` / 文件 / 路径 / 代码内容，只按节拍推进战斗。
- 战斗日志走顶层 `systemMessage`（CodeBuddy 官方定义：**只显示给用户，不传给 Agent**）+ `suppressOutput: true`，
  因此**不会进入模型上下文、不消耗 token**。
- 不挂 MCP、不发网络请求、不读你的项目文件。

## 前置条件

- **Node.js ≥ 16**（本机为 `C:\nvm4w\nodejs\node.exe` v16.20.2，已实测通过）。
- **Windows 需安装 Git for Windows**：CodeBuddy 的 hook 在 Windows 上**强制用 Git Bash 执行**（不支持 cmd/PowerShell）。
  本机已安装（`C:\Program Files\Git`）。

## IDE 扩展（常驻 UI，推荐）

`vscode-extension/` 是一个**标准 VS Code 扩展**，把像素小生物做成**常驻 UI**（底部面板 + 状态栏），
在 CodeBuddy / VS Code 里都可用。扩展只负责**显示**，战斗推进由本仓库的 CodeBuddy 插件（hooks）驱动。

| 命令 | 说明 |
|---|---|
| `Nibble: 显示像素小生物（底部面板）` | 展开底部停靠视图 |
| `Nibble: 攻击一次` | 手动推进一次 |
| `Nibble: 在编辑器标签页中打开` | 放大查看完整 24×24 |
| `Nibble: 重置等级/经验/战绩` | 清空进度 |
| `Nibble: 显示/隐藏状态栏小生物` | 切换状态栏 |

| 设置 | 默认 | 说明 |
|---|---|---|
| `nibble.triggerMode` | `hook` | `hook`（配套 hooks 提问即攻击）/ `onSave`（保存文件即攻击）/ `manual` |
| `nibble.statusBar` | `true` | 状态栏显示小生物 |
| `nibble.autoOpenPanel` | `true` | 启动时自动展开底部面板 |
| `nibble.tickMs` | `400` | 刷新间隔（毫秒） |

只装扩展、不装插件时，把 `triggerMode` 设为 `onSave` 即可独立使用。

## 仓库结构

```
nibble-cb/                          ← 本仓库根目录（同时是 CodeBuddy 本地市场根目录）
├── .codebuddy-plugin/marketplace.json # CodeBuddy 本地市场清单
├── plugins/nibble/                 # CodeBuddy 插件：hooks 驱动战斗 / 命令 / 素材源
├── mcp/server.js                      # MCP 服务器（可选通道，在对话里看战场卡片）
├── vscode-extension/                  # VS Code / CodeBuddy 扩展（常驻 UI）
│   ├── lib/                           # 构建产物：素材 + 渲染副本（不入库，npm run sync 生成）
│   └── icon.png                       # 128×128 图标
├── tools/                             # 构建脚本（同步 / 打包 / 图标 / 自检 / 本地安装 / 预览）
├── dist/                              # 打包产物 nibble-<version>.vsix
└── .github/workflows/release.yml      # 打 tag 自动打包并发布
```

## 打包与发布

> 📘 **完整流程（改功能 → 升版本 → 打 tag → 自动上架）见 [`PUBLISHING.md`](PUBLISHING.md)**，下面是速查。

```bash
npm test                  # 扩展自检（stub 跑 activate / tick / webview）
npm run sync              # 把 hooks 源文件同步进扩展 lib/（改了那两个 JS 才需要）
npm run package:official  # 官方 vsce 打包（需 Node ≥ 20）→ dist/nibble-<version>.vsix ← 发布用这个
npm run package           # 离线兜底打包（Node 16 可用）→ dist/nibble-<version>-offline.vsix
npm run install-local     # 装进本机 IDE 扩展目录（开发中预览，会自动清扫描缓存）
```

> ⚠️ **发布必须用 `npm run package:official`**。自写的离线打包器（`tools/make-vsix.js`）体积小、不联网，
> 但它早期版本生成的 `extension.vsixmanifest` 缺了 Open VSX 必需的 `Assets`（`Icons.Default` /
> `Content.Details` / `Content.License`）与 `<Icon>`/`<Categories>`，服务端会直接以 **406 Not Acceptable** 拒绝发布。
> 现已补全，但正式发布仍建议走官方 vsce。
>
> 若本机默认 Node < 20，可指定 Node 22 对应的可执行文件：
> ```bash
> VSCE_NODE="C:/Users/<you>/.workbuddy/binaries/node/versions/22.22.2-3/npx.cmd" npm run package:official
> ```

**本地安装**：`npm run install-local`（推荐，全自动：解析真实扩展目录 + 登记 + 清扫描缓存），
或 `Ctrl+Shift+P` → `Extensions: Install from VSIX...`。

**发布到 Open VSX**（CodeBuddy 的扩展市场就是 open-vsx.org，发完在 IDE 里搜 "Nibble" 即可安装）：

```bash
# 一次性准备（本项目已完成）：
#   1. open-vsx.org 用 GitHub 登录
#   2. 注册 accounts.eclipse.org（表单里的 GitHub Username 必须与上面那个 GitHub 账号一致）
#   3. open-vsx.org → Settings → Log in with Eclipse → 签署 Publisher Agreement
#   4. open-vsx.org → Settings → Access Tokens → 生成 token（关掉就看不到，立刻保存）
# 命名空间 nibble 已创建，无需再 create-namespace
node tools/set-repository.js LMLuo/nibble                     # CI 会自动做，手动发需自己注入
npx --yes ovsx@1 publish dist/nibble-<version>.vsix -p <token>
```

> ⚠️ **ovsx 1.x 要求 Node ≥ 22**。若本机默认 Node 较低（如 16），`npx` 会去装旧版 ovsx，
> 而旧版依赖需要编译的原生模块 `keytar`（要 Visual Studio C++ 工具链）→ 报 `gyp ERR! find VS`。
> 解决：切到 Node 22，或显式指定该 Node 的 npx；并清掉坏缓存 `npm cache clean --force`。
> `ovsx` 报 **406 Not Acceptable** 通常意味着 VSIX 缺少 Open VSX 必需资源，用 `npm run package:official` 重打即可。

**自动发布（推荐）**：仓库 Secrets 里**已配好** `OVSX_PAT`（可选再加 `VSCE_PAT` 以同时发微软市场），只需打 tag：

```bash
git tag v0.1.2 && git push origin v0.1.2
```

工作流会依次：校验 tag 与 `vscode-extension/package.json` 版本一致 → 注入 `repository` → 扩展自检 → 插件冒烟测试 →
同步 `lib/` → 官方 vsce 打包 → **发布 Open VSX** → 创建带 vsix 附件的 GitHub Release。

## 已知限制

- 底部面板高度有限：拖大分隔条，或用 `在编辑器标签页中打开` 看完整 24×24 大图。
- `triggerMode: hook` 需要配套的 CodeBuddy 插件（本仓库 `plugins/nibble`）才能"提问即攻击"；只装扩展请用 `onSave`。
- 扩展**不读取**你的代码、提示词或文件内容，只读自己那份游戏存档。

## 素材与版权

像素素材为 **AI 生成的原创像素画（CC0）**，源图见 `legacy-mods/assets/`，由 `legacy-mods/tools/png2grid.mjs`
转成 24×24 网格后内联到 `plugins/nibble/hooks/pixels.js`。**未复制任何第三方素材**，详见 `legacy-mods/CREDITS.md`。

### 设计灵感来源

本项目的设计灵感来自 [Spinlings](https://spinlings.dev/)（[416rehman/spinlings](https://github.com/416rehman/spinlings)，
一个跑在 Claude Code 里的生物卡牌游戏）：我们参照了它的视觉语言（深色底、青色玩家、橙色野生、红色攻击状态色）
以及"随 AI 工作节奏推进"的交互思路。

但本项目**名称、代码与像素素材全部独立**，未使用其任何素材或代码。这也是改名为 **Nibble** 的原因——
避免与上游项目重名。
