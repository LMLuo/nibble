// nibble 匿名激活统计端点（Cloudflare Workers + KV）
//
// 设计原则（与扩展侧 CHANGELOG / README 中的承诺一一对应）：
//   1. 只接收两个字段：`id`（扩展本地生成的随机匿名 ID）+ `v`（扩展版本号）。
//      **不接收**也无法接收代码、文件、路径、提示词、账号、机器名 —— 扩展根本不发。
//   2. 服务端**不保存 IP**：不写日志、不落库，IP 只在一次请求的生命周期内存在。
//   3. 不生成任何个人画像：`id` 是随机 UUID，与账号/机器无关，用户可随时重置或关闭上报。
//   4. 记录的是**按日去重的活跃安装数**，不是某个人的使用行为。
//
// KV 键位（都带日期，避免"所有上报写同一个键"触发 KV 的 1 写/秒/键 限制）：
//   d:<YYYY-MM-DD>              当天上报次数
//   u:<YYYY-MM-DD>:<匿名ID>      当天该 ID 已上报的标记（TTL 3 天，仅用于去重）
//   du:<YYYY-MM-DD>             当天去重后的活跃安装数（DAU）
//   dv:<YYYY-MM-DD>:<版本号>     当天各版本的上报次数
//
// 端点：
//   POST /ping            上报（也支持 GET /ping?id=..&v=.. 便于 curl 自测）
//   GET  /stats?key=..    读取统计 JSON（key 必须等于 secret STATS_KEY）
//   GET  /                只读仪表盘（浏览器里输入 key 后查 /stats，同源请求）
//
// 部署方式见同目录 README.md。

const DAY_TTL = 60 * 60 * 24 * 3 // 去重标记保留 3 天，够覆盖跨天/时区误差
const MAX_LIST_PAGES = 10 // 单次 /stats 最多翻 10 页（每页 1000 键），防跑飞

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

const utcDay = (d) => new Date(d || Date.now()).toISOString().slice(0, 10)

const prevDay = (day, back) => {
  const t = Date.parse(day + 'T00:00:00Z') - back * 86400000
  return utcDay(t)
}

// 读-改-写自增。KV 无原子自增，高并发下可能少计；本项目量级（几十次/天）可忽略。
async function bump(env, key, delta = 1) {
  const cur = parseInt((await env.NIBBLE_KV.get(key)) || '0', 10) || 0
  const next = cur + delta
  await env.NIBBLE_KV.put(key, String(next))
  return next
}

// 取某个前缀下的全部键值（分页）
async function listAll(env, prefix) {
  const out = new Map()
  let cursor = null
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await env.NIBBLE_KV.list({ prefix, limit: 1000, cursor })
    const names = res.keys.map((k) => k.name)
    const values = await Promise.all(names.map((n) => env.NIBBLE_KV.get(n)))
    names.forEach((n, i) => out.set(n, parseInt(values[i] || '0', 10) || 0))
    if (res.list_complete) break
    cursor = res.cursor
  }
  return out
}

// 只接受"看起来像"的匿名 ID 与版本号，其余一律拒收（避免有人往 KV 里灌垃圾）
const ID_RE = /^[0-9a-f]{8,64}$/
const VER_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,23}$/

async function handlePing(request, env, url) {
  let id = url.searchParams.get('id') || ''
  let v = url.searchParams.get('v') || ''
  if (request.method === 'POST') {
    try {
      const body = await request.json()
      id = String(body.id || '')
      v = String(body.v || '')
    } catch {
      return json({ ok: false, error: 'bad json' }, 400)
    }
  }
  id = String(id).trim().toLowerCase()
  v = String(v).trim()
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad id' }, 400)
  if (!VER_RE.test(v)) v = 'unknown'

  const day = utcDay()
  await bump(env, `d:${day}`)
  await bump(env, `dv:${day}:${v}`)

  const ukey = `u:${day}:${id}`
  const seen = await env.NIBBLE_KV.get(ukey)
  if (!seen) {
    await env.NIBBLE_KV.put(ukey, '1', { expirationTtl: DAY_TTL })
    await bump(env, `du:${day}`)
  }
  return json({ ok: true })
}

async function handleStats(env, url) {
  const key = url.searchParams.get('key') || ''
  if (!env.STATS_KEY || key !== env.STATS_KEY) return json({ ok: false, error: 'unauthorized' }, 403)

  const [days, uniques, versions] = await Promise.all([
    listAll(env, 'd:'),
    listAll(env, 'du:'),
    listAll(env, 'dv:'),
  ])

  const dayRows = [...days.entries()]
    .map(([k, pings]) => {
      const day = k.slice(2)
      return { day, pings, users: uniques.get('du:' + day) || 0 }
    })
    .sort((a, b) => (a.day < b.day ? 1 : -1)) // 新 → 旧

  const pick = (d) => dayRows.find((r) => r.day === d) || { day: d, pings: 0, users: 0 }
  const sum = (rows) => ({
    pings: rows.reduce((n, r) => n + r.pings, 0),
    userDays: rows.reduce((n, r) => n + r.users, 0),
  })

  const today = utcDay()
  const last7Rows = dayRows.filter((r) => r.day > prevDay(today, 7) && r.day <= today)
  const last30Rows = dayRows.filter((r) => r.day > prevDay(today, 30) && r.day <= today)

  const versionTotals = {}
  for (const [k, n] of versions) {
    const ver = k.split(':').slice(2).join(':')
    versionTotals[ver] = (versionTotals[ver] || 0) + n
  }

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    timezone: 'UTC（自然日按 UTC 切分）',
    today: pick(today),
    yesterday: pick(prevDay(today, 1)),
    last7: { from: prevDay(today, 6), to: today, ...sum(last7Rows) },
    last30: { from: prevDay(today, 29), to: today, ...sum(last30Rows) },
    // 累计值说明：日活是"按日去重"，跨天无法再去重，故累计给出的是**活跃安装·天**
    total: { from: dayRows.length ? dayRows[dayRows.length - 1].day : null, ...sum(dayRows) },
    daily: dayRows.slice(0, 30),
    versions: versionTotals,
    note: '活跃口径：扩展当天首次启动时上报一次（每台机器每天最多 1 次）。userDays 为按日去重后的活跃安装数之和。',
  })
}

function handleDashboard() {
  return new Response(DASHBOARD_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nibble 匿名统计</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #14171c; color: #e6edf3;
         font: 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  .bar { display: flex; gap: 8px; margin-bottom: 20px; }
  input { flex: 1; max-width: 420px; padding: 8px 10px; border-radius: 6px; border: 1px solid #30363d;
          background: #0d1117; color: inherit; }
  button { padding: 8px 14px; border-radius: 6px; border: 1px solid #2ea04380; background: #238636;
           color: #fff; cursor: pointer; }
  button:hover { background: #2ea043; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .card { background: #171b21; border: 1px solid #262c36; border-radius: 10px; padding: 14px 16px; }
  .card .k { color: #8b949e; font-size: 12px; }
  .card .v { font-size: 26px; font-weight: 600; color: #7ee7d0; }
  .card .s { color: #6e7681; font-size: 12px; }
  section { margin-top: 26px; }
  h2 { font-size: 14px; color: #8b949e; font-weight: 500; margin: 0 0 10px; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
  .row .lbl { width: 92px; color: #8b949e; }
  .row .fill { height: 14px; background: linear-gradient(90deg, #2ea043, #7ee7d0); border-radius: 3px; min-width: 2px; }
  .row .num { color: #c9d1d9; }
  .err { color: #f85149; }
</style>
</head>
<body>
  <h1>Nibble 匿名统计</h1>
  <div class="hint">数据来源：扩展启动时的匿名上报（仅随机 ID + 版本号）。自然日按 UTC 切分。</div>
  <div class="bar">
    <input id="key" type="password" placeholder="STATS_KEY（部署时 wrangler secret put STATS_KEY 设置的那个）" />
    <button id="go">查询</button>
  </div>
  <div id="out"></div>
<script>
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  var card = function (k, v, s) {
    var c = el('div', 'card');
    c.appendChild(el('div', 'k', k));
    c.appendChild(el('div', 'v', v));
    if (s) c.appendChild(el('div', 's', s));
    return c;
  };
  var bars = function (title, rows) {
    var sec = el('section');
    sec.appendChild(el('h2', null, title));
    var max = Math.max.apply(null, rows.map(function (r) { return r.n; }).concat([1]));
    rows.forEach(function (r) {
      var row = el('div', 'row');
      row.appendChild(el('div', 'lbl', r.label));
      var fill = el('div', 'fill');
      fill.style.width = Math.max(2, Math.round((r.n / max) * 320)) + 'px';
      row.appendChild(fill);
      row.appendChild(el('div', 'num', String(r.n) + (r.extra ? '  ' + r.extra : '')));
      sec.appendChild(row);
    });
    return sec;
  };
  var run = function () {
    var key = document.getElementById('key').value.trim();
    if (!key) return;
    try { localStorage.setItem('nibbleStatsKey', key); } catch (e) {}
    var out = document.getElementById('out');
    out.textContent = '查询中…';
    fetch('/stats?key=' + encodeURIComponent(key))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        out.textContent = '';
        if (!d.ok) { out.appendChild(el('div', 'err', '查询失败：' + (d.error || '未知错误'))); return; }
        var cards = el('div', 'cards');
        cards.appendChild(card('今日活跃', d.today.users, d.today.day + '　上报 ' + d.today.pings + ' 次'));
        cards.appendChild(card('昨日活跃', d.yesterday.users, d.yesterday.day));
        cards.appendChild(card('近 7 天', d.last7.userDays, '活跃安装·天　上报 ' + d.last7.pings));
        cards.appendChild(card('近 30 天', d.last30.userDays, '活跃安装·天'));
        cards.appendChild(card('累计', d.total.userDays, '活跃安装·天（起始 ' + (d.total.from || '—') + '）'));
        out.appendChild(cards);
        var vrows = Object.keys(d.versions).sort(function (a, b) { return d.versions[b] - d.versions[a]; })
          .map(function (v) { return { label: 'v' + v, n: d.versions[v] }; });
        if (vrows.length) out.appendChild(bars('版本分布（累计上报）', vrows));
        out.appendChild(bars('近 30 天每日活跃', d.daily.map(function (r) {
          return { label: r.day.slice(5), n: r.users, extra: '上报 ' + r.pings };
        })));
        out.appendChild(el('div', 'hint', d.note));
      })
      .catch(function (e) { out.textContent = ''; out.appendChild(el('div', 'err', '请求失败：' + e)); });
  };
  document.getElementById('go').addEventListener('click', run);
  document.getElementById('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  try {
    var saved = localStorage.getItem('nibbleStatsKey');
    if (saved) { document.getElementById('key').value = saved; run(); }
  } catch (e) {}
</script>
</body>
</html>`

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/ping') return await handlePing(request, env, url)
      if (url.pathname === '/stats') return await handleStats(env, url)
      if (url.pathname === '/') return await handleDashboard()
      return json({ ok: false, error: 'not found' }, 404)
    } catch (err) {
      // 统计失败绝不能影响任何东西，静默返回 200，避免扩展侧重试放大流量
      return json({ ok: false, error: String((err && err.message) || err) }, 200)
    }
  },
}
