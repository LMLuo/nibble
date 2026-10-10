# 升级与发布指南（PUBLISHING）

> 面向场景：**「我改好了功能，怎么把新版发出去」**。
> 所有命令都在仓库根目录 `nibble-cb/` 下执行。
>
> **一句话总览：你只推 GitHub，上架插件市场由 CI 自动完成。**

---

## 0. 先分清三个"仓库"（最容易混）

| 名称 | 地址 | 谁在写 | 你要手动操作吗 |
|---|---|---|---|
| **本地工作区** | 你本机克隆下来的 `nibble-cb/` 目录 | 你（编辑器） | —— |
| **Git 仓库**（源码托管） | `github.com/LMLuo/nibble` | **你**（`git push`） | ✅ 要，但不需任何人审核 |
| **插件市场**（用户下载的地方） | `open-vsx.org/extension/nibble/nibble` | **CI**（打 tag 后自动） | ❌ 不用你管 |

> 所以"推到插件仓库"这个说法要拆开：**代码推 GitHub** → **打 tag** → CI 自动 `ovsx publish` 到 Open VSX。
> 你**不需要**手动上传 vsix（除非走第 5 节的手动兜底）。

---

## 1. 版本号在哪（关键）

| 位置 | 字段 | 说明 |
|---|---|---|
| `vscode-extension/package.json` | `version` | ★ **唯一被 CI 校验的**，tag 必须与它一致 |
| `package.json`（仓库根） | `version` | 仅供参考，建议同步改（CI 不校验） |
| `vscode-extension/package.json` | `publisher` | 必须是 `nibble`（= Open VSX 命名空间，不能随意改） |

**铁律**：打 `git tag v0.1.2` 时，`vscode-extension/package.json` 的 `version` 必须是 `0.1.2`。
不一致时 CI 会直接失败退出（这是有意设的守卫）。

---

## 2. 快速版（最常用，照抄即可）

```powershell
# ① 改版本号：编辑 vscode-extension/package.json → "version": "0.1.2"
#    （建议同时改根 package.json 的 version）
#    同时更新 vscode-extension/CHANGELOG.md：把「未发布」改成实际版本号并写上本次改动
#    （CHANGELOG 会展示在扩展市场页；涉及匿名统计等隐私相关改动必须写清楚）

# ② 本地验证
npm run test                 # 扩展自检（必须过；其中已覆盖匿名统计的跳过/静默失败路径）
npm run package:official     # 打包 → dist/nibble-0.1.2.vsix（可跳过，CI 也会打）

# ③ 提交并推送
git add -A
git commit -m "feat: 你这次改了什么"
git push origin main

# ④ 打 tag 触发自动发布（关键一步）
git tag v0.1.2
git push origin v0.1.2
```

之后去 GitHub → **Actions** → `Release VSIX` 看是否全绿。绿了就上架完成。

---

## 3. 完整流程（首次或大改动时逐条走）

### 步骤 1 —— 改代码：先确认改哪个文件

| 你想改的东西 | 改这里 |
|---|---|
| 宠物外观 / 动画 / 面板 UI | `vscode-extension/extension.js`、`vscode-extension/media/panel.html`、`media/pet.js` |
| 战斗数值 / 等级 / 稀有度 / 伤害 | `plugins/nibble/hooks/nibble.js` ★ |
| 像素形象（24×24 网格数据） | `plugins/nibble/hooks/pixels.js`（见第 7 节） |
| "提问即攻击"的触发与 hook | `plugins/nibble/hooks/cli.js` |
| 命令 / 菜单项 | `vscode-extension/package.json` 的 `contributes` |
| **匿名统计：上报什么 / 发到哪** | `vscode-extension/telemetry.js`（★ 改这里要同步更新 `CHANGELOG.md` 与两个 README 的「隐私」） |
| **匿名统计：接收端 / 查询界面** | `telemetry-worker/`（Cloudflare Workers + KV，独立部署，见第 10 节） |
| 更新日志（市场页展示） | `vscode-extension/CHANGELOG.md` |
| 打包 / 发布逻辑 | `tools/`、`.github/workflows/release.yml` |

> ★ **重要**：`plugins/nibble/hooks/{nibble.js,pixels.js}` 是**源文件**；
> `vscode-extension/lib/` 里的同名文件是**构建产物副本**（gitignore），
> 由 `tools/sync-lib.js` 从源文件生成。**改了源文件必须跑 `npm run sync`**，否则扩展用的还是旧副本。

### 步骤 2 —— 本地自检

```powershell
npm run sync      # 把 hooks 里的源文件同步到扩展 lib/（改了那两个文件才需要）
npm run test      # 扩展自检：stub 跑 activate / tick / webview
```

### 步骤 3 —— 本地实测（先在自己 IDE 里看效果，再决定发布）

**方式 A：装市场上已发布的版本（最省事）**

```powershell
& 'D:\CodeBuddy CN\bin\buddycn.cmd' --install-extension nibble.nibble --force
& 'D:\CodeBuddy CN\bin\buddycn.cmd' --list-extensions --show-versions | Select-String nibble
```

**方式 B：装你「尚未发布」的本地改动**（开发中预览）

```powershell
npm run install-local        # = node tools/install-extension.js
```

它会自动完成这些事（都是踩坑后写进去的）：
- 从扫描缓存里解析**真实的扩展目录**（`%USERPROFILE%\.codebuddycn\extensions`，**不是** `~/.codebuddy/extensions`）
- 同步 `lib/` → 拷贝扩展 → 登记 `extensions.json`
- **清掉 `extensions.user.cache`**，强制下次启动重扫（否则改了不生效）
- 顺手清掉改名前的 `spinlings.*` 残留

然后 `Ctrl+Shift+P` → **Developer: Reload Window** 看效果。

> 看日志：`%APPDATA%\CodeBuddy CN\logs\<最新会话>\window1\renderer.log`（扩展校验/激活报错都在这）。

### 步骤 4 —— 升版本号

改这两处（**扩展那个必须改**）：

```jsonc
// vscode-extension/package.json
"version": "0.1.2",

// package.json（仓库根，建议同步）
"version": "0.1.2",
```

### 步骤 5 —— 打包（可跳过，CI 会替你做；本地做能提前发现问题）

```powershell
npm run package:official        # → dist/nibble-0.1.2.vsix
```

- 该脚本用的是**官方 vsce**，必需（自写的离线打包器产物在 Open VSX 会被 **406** 拒绝）。
- 要求 **Node ≥ 20**。本机 PowerShell 里 `node` 是 v22，直接可用；若你的 shell 里 node < 20：

```powershell
$env:VSCE_NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/npx.cmd"
npm run package:official
```

### 步骤 6 —— 提交并推送

```powershell
git add -A
git commit -m "feat: 你这次改了什么"
git push origin main
```

> **GitHub 不会审核你的推送**：你是仓库 owner，有写权限就直接生效，没有"等待批准"环节。
> （本仓库确认无分支保护、无 ruleset：`GET /repos/LMLuo/nibble/rulesets` 返回 `[]`。）

### 步骤 7 —— 打 tag 触发自动发布 ★

```powershell
git tag v0.1.2
git push origin v0.1.2
```

**打了这个 tag，CI 才会发布。**

### 步骤 8 —— 确认发布结果

**看 Actions**：GitHub → Actions → `Release VSIX` → 最新一次运行，应全绿，日志里出现：

```
🚀  Published nibble.nibble v0.1.2
```

**或命令行核对 Open VSX**（权威）：

```powershell
curl.exe -s "https://open-vsx.org/api/nibble/nibble/versions"
curl.exe -s "https://open-vsx.org/api/nibble/nibble/0.1.2"
```

出现在 `versions` 列表里、且 `versionAlias` 含 `latest`，就是上架成功。
GitHub → Releases 里也会有 `v0.1.2` 和 `.vsix` 附件。

### 步骤 9 —— 把本机 IDE 升级到新版

```powershell
& 'D:\CodeBuddy CN\bin\buddycn.cmd' --install-extension nibble.nibble --force
& 'D:\CodeBuddy CN\bin\buddycn.cmd' --list-extensions --show-versions | Select-String nibble
```

然后 Reload Window。

---

## 4. CI 到底做了什么（`.github/workflows/release.yml`）

触发条件：**推送 `v*` 形状的 tag**，或在 Actions 页面手动 `Run workflow`（可勾选是否真发布）。

| 步骤 | 作用 | 常见失败原因 |
|---|---|---|
| 校验 tag 与版本一致 | 防"tag 写了新版本但 package.json 没改" | 版本不一致 → 先改 package.json 再重打 tag |
| `node tools/set-repository.js` | 把 `repository` 注入为当前仓库（市场页显示源码链接） | 无 |
| `node tools/test-extension.js` | 扩展自检 | 代码跑不起来 |
| `node plugins/nibble/hooks/cli.js do` | 插件冒烟测试（渲染 + 存档读写） | hook 代码报错 |
| `node tools/sync-lib.js` | 同步自包含 `lib/` | 源文件缺失 |
| `vsce package` | 官方打包（含 Open VSX 必需的 Assets/Icon） | 打包错误 |
| `ovsx publish` | **发布到 Open VSX** | 缺 `OVSX_PAT` → 会**响亮报错**（有意设计）；版本已存在 → 服务端拒绝 |
| 发布到微软市场 | 仅当配了 `VSCE_PAT` 才执行，否则跳过 | —— |
| 建 GitHub Release | 附上 `.vsix` 附件 | —— |

**已有的配置**（一次性，无需重复）：
- Secrets 里有 `OVSX_PAT`（已配置好）
- 仓库变量：无特殊要求
- 发布目标：Open VSX（CodeBuddy 的扩展市场就是它）

---

## 5. 手动兜底发布（CI 不可用时）

```powershell
# 1) 打包
npm run package:official

# 2) 注入 repository（CI 会自动做，手动发就得自己来）
node tools/set-repository.js LMLuo/nibble

# 3) 发布（需要 Node ≥ 22 与 Open VSX access token）
npx --yes ovsx@1 publish dist/nibble-0.1.2.vsix -p <你的token>
```

> ⚠️ 手动发布**不会**注入 `homepage` / `bugs`，市场页会少"源码/问题反馈"链接。
> 对比：`0.1.0` 是手动发的（这三项为空），`0.1.1` 走 CI（三项齐全）——可用这个区别判断版本来源。

---

## 6. 常见坑（都是真踩过的）

| 现象 | 原因 | 解决 |
|---|---|---|
| CI 报"版本不一致" | tag 与 `vscode-extension/package.json` 的 version 不同 | 改 package.json → 重新打 tag |
| CI 报 `未读到 secrets.OVSX_PAT` | 没配 secret（名字必须严格 `OVSX_PAT`） | 到 Settings → Secrets and variables → **Actions → Secrets** 添加 |
| 发布报 `406 Not Acceptable` | 用了自写离线打包器（vsixmanifest 缺字段） | 改用 `npm run package:official` |
| 扩展"装了但没反应" | ①`engines.vscode` 写 `"*"` 会被**静默拒绝**；②命中扫描缓存不重扫 | ①写具体版本如 `^1.70.0`；②删 `extensions.user.cache`（`install-local` 会自动做） |
| 打包报 `ENOENT ... dist/` | 全新克隆里没有 `dist/`（gitignore 了） | 脚本已自动 `mkdir`，如仍报错手动建一个 |
| `ovsx` 报 `gyp ERR! find VS` | 用的旧版 ovsx（需编译 keytar） | 切 **Node ≥ 22**；`npm cache clean --force` |
| 改了 hooks 的 JS 但扩展行为没变 | 没同步到 `vscode-extension/lib/` | `npm run sync` |
| hooks 里用了新语法导致提问时无反应 | Windows 下 hooks 走 **Git Bash**，其中 node 是 **v16.20.2** | hook 代码保持 Node 16 兼容（别用可选链等） |
| push 时报 `Connection was reset` / `443 timed out` | 到 GitHub 的网络被重置（国内常见） | 挂代理重试；提交已在本地，不会丢 |

---

## 7. 换像素素材（宠物形象）

素材源图与转换工具已归档在 `legacy-mods/`，完整命令见
**[`legacy-mods/README.md`](legacy-mods/README.md)**。简要版（在仓库根执行）：

```powershell
npm i -D pngjs          # 构建期依赖（已装过可跳过）

node legacy-mods/tools/png2grid.mjs legacy-mods/pixels/_pixels.gen.txt legacy-mods/preview `
  player=legacy-mods/assets/player.png `
  bat=legacy-mods/assets/bat.png `
  slime=legacy-mods/assets/slime.png `
  mimic=legacy-mods/assets/mimic.png
```

1. 打开 `legacy-mods/preview/*.png` 人工核验（24×24 放大 12 倍）
2. 把新生成的 `palette` / `rows` 更新进 `plugins/nibble/hooks/pixels.js`
3. `npm run sync`，然后按第 2 节的流程发版

---

## 8. 撤销与回滚

| 情况 | 做法 |
|---|---|
| 代码改错了、还没推 | `git checkout -- <file>` / `git reset --hard`（谨慎） |
| 已经推了但还没发版 | 直接再提交一个修复 commit 推上去（**不要**改已推送历史） |
| **已经发版了，发现有问题** | 已上架的版本**无法下架**，只能发一个更高的修订版（如 `0.1.2` → `0.1.3`）修掉 |
| tag 打错了（想重打同一个版本号） | `git tag -d v0.1.2` → `git push origin :refs/tags/v0.1.2` → 重打重推（**仅在该版本还没成功上架时**适用） |
| 本机想退回旧版 | GitHub → Releases → 下载旧的 `.vsix` → 命令面板 `Extensions: Install from VSIX...` |

---

## 9. 匿名统计（接收端部署 / 上报地址变更）

> 面向场景：**「匿名统计要重新部署、换地址，或临时停掉」**。

扩展侧只有 `vscode-extension/telemetry.js` 一个文件，`ENDPOINT` 常量决定发到哪；接收端是
`telemetry-worker/`（Cloudflare Workers + KV），**独立于扩展发布流程——改它不用发新版**。

### 首次部署（一次性，约 5 分钟）

详见 [`telemetry-worker/README.md`](telemetry-worker/README.md)，要点：

```powershell
cd telemetry-worker
npm install                       # 装 wrangler
npx wrangler login                # 浏览器授权，只需一次
npm run kv:create                 # 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]].id
npm run secret                    # 自定一个 STATS_KEY（看仪表盘用）
npm run deploy                    # → https://nibble-stats.<子域>.workers.dev
```

然后把该地址 + `/ping` 填进 `vscode-extension/telemetry.js` 的 `ENDPOINT`，再 `npm run test`（**必须仍通过**，
自检会跳过上报、不会真联网）。

> ⚠️ `ENDPOINT` 仍是占位符（含 `REPLACE_ME`）时，扩展**不会发出任何请求**，也不会报错。
> 所以"先合并代码、后端稍后再部署"是安全的；但要真出数据，必须填上地址并**发一次新版**（旧版不会开始上报）。

### 看数据

浏览器打开 `https://nibble-stats.<子域>.workers.dev/`，粘贴 `STATS_KEY`：今日 / 昨日 / 近 7 天 / 近 30 天活跃安装数、
版本分布、近 30 天每日明细。命令行等价：`curl.exe -s ".../stats?key=<STATS_KEY>"`。

### 口径与边界（别误读）

- 数字是**活跃安装数（按日去重）**，不是用户总数；市场页"下载量"是累计下载——两者永远不相等，也不必相等。
- 自然日按 **UTC** 切分（与国内时区差 8 小时，看"今天"时留意）。
- KV 免费层 1000 次写/天，本方案每次上报约 3~4 次写 → 约 **250~300 台/天** 的天花板。
- KV 无原子自增，同一秒并发可能少计 1，对"估算规模"没有影响。

### 临时停掉 / 换地址

- **停掉**：把 `ENDPOINT` 改回占位符发新版；但旧版用户仍会打到旧地址 —— 更省事的是直接
  `npx wrangler delete` 删掉 Worker（旧版上报失败会静默忽略，用户无感）。
- **换地址**：改 `ENDPOINT` 发新版即可；旧版继续打到旧地址（留着或删掉都行）。

### 隐私红线（改统计时不可越线）

只允许发送 **匿名随机 ID + 版本号** 这两个字段；不接收、不存储 IP / 代码 / 路径 / 项目名 / 账号 / 机器名。
任何相关改动都必须同步更新 `vscode-extension/CHANGELOG.md` 与两个 README 的「隐私」一节——**这是对用户的承诺**。

---

## 10. 附：本项目当前的发布状态

| 项 | 值 |
|---|---|
| 扩展 ID | `nibble.nibble` |
| 已发布版本 | `0.1.0`（手动）、**`0.1.1`（CI）** |
| 源仓库 | `https://github.com/LMLuo/nibble`（public，默认分支 `main`） |
| 市场页 | `https://open-vsx.org/extension/nibble/nibble` |
| 命名空间认领 | ⏳ **进行中**（issue `EclipseFdn/open-vsx.org#13951`）—— 授予前市场页显示"未验证发布者 ⚠️"，**不影响安装使用** |
| 匿名统计接收端 | `telemetry-worker/`（Cloudflare Workers + KV）；扩展侧地址在 `vscode-extension/telemetry.js` 的 `ENDPOINT`（**部署前为占位符 = 不上报**） |
| 更新日志 | `vscode-extension/CHANGELOG.md`（`0.1.x` 的历史见 GitHub Releases） |
| 已知风险 | `vscode-extension/icon-src/` 的 AI 图标源图被 gitignore 排除，**不在版本控制里** |
