# nibble-stats —— 匿名激活统计端点（Cloudflare Workers + KV）

给 `nibble.nibble` 扩展用的**最小化统计后端**：回答"现在大概有多少人在跑这个扩展"。
之所以不用现成统计服务，是因为要**自己能完全掌控**：收什么、存什么、存多久，全在这一个文件里（`src/index.js`）。

## 收集什么 / 不收集什么

| | 内容 |
|---|---|
| **只接收** | `id`：扩展在本地随机生成的匿名 ID（UUID，与账号/机器无关，用户可重置）<br>`v`：扩展版本号（如 `0.2.0`） |
| **不接收** | 代码、文件内容、文件路径、提示词、项目名、账号、邮箱、机器名、操作系统、地理位置 |
| **服务端不保存** | **IP 地址**（不写日志、不落库）、任何原始请求体 |
| **存的东西** | 只有 4 类计数键：当天上报次数、当天去重活跃数、当天各版本次数、去重标记（TTL 3 天） |
| **上报频率** | 每台机器**每天最多 1 次**（扩展当天首次启动时；版本号变化时会立即上报一次） |

> 口径说明：统计结果是 **"活跃安装数（按日去重）"**，不是某个人的行为轨迹。
> 跨天无法再去重，所以"累计"给出的单位是 **活跃安装·天**，不是"累计用户数"。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /ping` | 上报（body：`{"id":"<32位hex>","v":"0.2.0"}`；也支持 `GET /ping?id=..&v=..` 便于 curl 自测） |
| `GET /stats?key=<STATS_KEY>` | 返回统计 JSON（今日 / 昨日 / 近 7 天 / 近 30 天 / 累计 / 版本分布 / 每日明细） |
| `GET /` | 只读仪表盘（浏览器打开，输入 `STATS_KEY` 即出图表） |

## 部署（一次性，约 5 分钟，全部免费）

在仓库根目录执行：

```powershell
cd telemetry-worker
npm install                 # 装 wrangler（本目录的 devDependency）
npx wrangler login          # 浏览器授权 Cloudflare 账号，只需一次
npm run kv:create           # 输出 id = "xxxxxxxx"，把它填进 wrangler.toml 的 [[kv_namespaces]].id
npm run secret              # 提示输入 STATS_KEY：自己定一串长随机字符（看仪表盘用）
npm run deploy              # 输出 https://nibble-stats.<你的子域>.workers.dev
```

> 如果账号下有多个 Cloudflare 账号，`wrangler` 会提示选择；也可以直接把 `account_id` 写进 `wrangler.toml`。

**第 3 步的 `id` 一定要填**，否则 `/ping` 会报 KV 未绑定（扩展侧会静默失败，不会报错弹窗）。

## 部署后自测

```powershell
# ① 打一条假上报（id 用 32 位十六进制）
curl.exe -s -X POST https://nibble-stats.<子域>.workers.dev/ping `
  -H "content-type: application/json" -d '{\"id\":\"0123456789abcdef0123456789abcdef\",\"v\":\"0.2.0\"}'

# ② 查统计（换成你设的 STATS_KEY）
curl.exe -s "https://nibble-stats.<子域>.workers.dev/stats?key=<STATS_KEY>"
```

第 ② 步应看到 `today.users = 1`、`versions["0.2.0"]` 有计数。
然后浏览器打开 `https://nibble-stats.<子域>.workers.dev/`，粘贴 `STATS_KEY` 看仪表盘。

## 最后一步：把地址填进扩展

把 `deploy` 输出的 `https://.../ping` 写到 **`vscode-extension/telemetry.js` 的 `ENDPOINT` 常量**，
再按 `PUBLISHING.md` 升版本、打 tag 发版。**没填（仍是占位符）时扩展不会发任何请求**，也不会报错。

## 免费额度与上限（诚实版）

Cloudflare 免费层对本项目量级（几十~几百次上报/天）绰绰有余，但要知道边界：

| 项 | 免费额度 | 本方案每次上报的消耗 |
|---|---|---|
| Workers 请求 | 100,000 次/天 | 1 次 |
| KV 写入 | 1,000 次/天 | 3~4 次（计数 + 去重标记） |
| KV 读取 | 100,000 次/天 | 1 次 |
| 单键写入速率 | 1 次/秒/键 | 键名都带日期，避免了"所有上报写同一个键" |

也就是 **约 250~300 台/天的上报量**是免费层的天花板。真到那天有两条路（都不改扩展协议）：
把计数挪到 Durable Object / Analytics Engine，或升级 KV 付费（额度与价格以 Cloudflare 官网为准）。
另外 KV 无原子自增，同一秒内的并发上报可能少计 1，对"估算有几个人在用"这个目标没有影响。

## 关掉统计 / 删除数据

- 用户侧：设置里 `nibble.telemetry = false`（或命令 `Nibble: 关于匿名统计` 里一键关闭；IDE 全局遥测关闭时扩展也不会发送）。
- 你侧（作为发布者）：把 `ENDPOINT` 改回占位符即可让新旧版本立即停止上报；KV 里去重标记 3 天自动过期，
  想彻底清空就删 KV 命名空间（`npx wrangler kv namespace delete --namespace-id <id>`）。
