#!/usr/bin/env node
'use strict'
// build-site.js — 把 site/ 组装成可发布的静态站 _site/（GitHub Pages 发布的就是这一份）
//
//   node tools/build-site.js            只组装（产物在 _site/）
//   node tools/build-site.js --serve    组装 + 起本地静态服务器（默认 http://127.0.0.1:4600）
//
// 为什么需要"组装"这一步：
//   1) 官网首屏演示要**真跑扩展自己的渲染器** —— 只保留一个源（vscode-extension/media/pet.js），
//      构建时复制进产物，避免官网与扩展两份代码漂移；
//   2) 主页要展示真实的怪物/武器数据与像素图 —— 由 plugins/nibble/hooks/nibble.js（扩展用的同一份逻辑）
//      在构建期导出成 _site/demo-data.js；
//   3) site/index.html 里的 {{占位符}} 由本脚本用真实数据填充（怪物名单、Bug 纪要原文、统计数字、版本号），
//      文案永远跟着仓库走，不会各写一份。
//
// 产物完全可再生：_site/ 已在 .gitignore；CI 只跑本脚本，不依赖 legacy-mods/ 与任何本机路径。

const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = path.resolve(__dirname, '..')
const SITE_DIR = path.join(ROOT, 'site')
const MEDIA_DIR = path.join(ROOT, 'vscode-extension', 'media')
const OUT_DIR = path.join(ROOT, '_site')

// 官网直接复用的扩展素材（真源都在 vscode-extension/media/，这里只复制、不改写）
const COPIES = [
  'pet.js', // 面板渲染器：官网首屏演示跑的就是它
  'panel-preview.png', // 战斗面板截图
  'bestiary-preview.png', // 怪物库截图
  'player-pixel.png', // 拾玖的 24x24 像素图
  'dog-shijiu.jpg', // 拾玖的照片
  'wechat-qr.png', // 微信赞赏码
]

// 首屏演示里"已经玩了一阵"的假存档规模（只影响演示观感，与真存档无关）
const DEMO = { level: 12, exp: 96, pity: 13 }

// —— 记忆点「把你今天遇到的 Bug 丢给它」的内容侧（构建期注入 demo-data.js）——
// 键 = nibble.js 里的**真怪 id**（40 只），值 = 命中它的关键词。
// 匹配规则在 site/site.js：命中词越长越具体、得分越高；一个都不中则按输入哈希从 FALLBACK 里挑。
// 加词条时注意：中文词会进字体子集，英文词不会（ASCII 本来就在）。
const BUG_WORDS = {
  // ── 小怪 ──
  null_pointer: ['null', '空指针', 'cannot read', 'of null', '空值', 'npe'],
  infinite_loop: ['死循环', '无限循环', '循环停不下来', '卡死', '一直在跑', 'while true', 'hang'],
  off_by_one: ['差一', 'off by one', '少一个', '索引不对', '少算', 'i <= len'],
  type_coercion: ['类型', 'typeerror', 'typescript', 'as any', '隐式转换', '泛型', '类型不匹配'],
  undefined_var: ['undefined', '未定义', 'is not defined', 'not a function', '属性不存在', '变量没声明'],
  index_bounds: ['越界', 'out of bounds', 'index out of range', '数组下标', '下标越界'],
  mojibake: ['乱码', '锟斤拷', 'gbk', '问号方块', '中文全变问号'],
  uncaught_exception: ['未捕获', 'uncaught', '异常', 'exception', '崩溃日志', '报错堆栈'],
  float_drift: ['浮点', '精度', '0.1', 'tofixed', '四舍五入', '小数不对'],
  shadow_var: ['遮蔽', 'shadow', '同名变量', '作用域', '变量被覆盖'],
  callback_hell: ['回调地狱', 'callback', '嵌套太深', 'then 套 then', '回调'],
  copy_paste: ['复制粘贴', '复读', '抄错', '重复代码', '一样的代码', '粘贴错了'],
  magic_number: ['魔数', 'magic number', '硬编码的数字', '这个数字是啥', '没注释的数字'],
  todo_zombie: ['todo', 'fixme', '待办', '以后再说', '先这样', '临时方案', '遗留注释'],
  hardcode_golem: ['硬编码', '写死', 'localhost', '绝对路径', '写死地址'],
  global_pollution: ['全局变量', '全局污染', '挂到 window', '污染全局', 'global'],
  typo_imp: ['拼写', '打错字', 'typo', '变量名写错', '大小写', '拼错'],
  asi_ambusher: ['分号', 'asi', 'semicolon', '少个分号', '换行陷阱'],
  timezone_shift: ['时区', 'utc', '时间差八小时', '日期不对', '服务器时间', '昨天'],
  bom_worm: ['bom', '零宽', '不可见字符', '隐藏字符', '复制来的空格', '文件头'],
  // ── 精英 ──
  memory_leak: ['内存泄漏', 'memory leak', '内存一直涨', 'oom', '吃内存', '越来越慢'],
  race_condition: ['竞态', 'race', '偶现', '偶尔复现', '时好时坏', '并发', '线程'],
  deadlock_spider: ['死锁', 'deadlock', '互相等待', '锁住', '卡住不动'],
  stack_overflow: ['栈溢出', 'stack overflow', '递归太深', '爆栈', 'maximum call stack'],
  n_plus_one: ['n+1', '慢查询', '循环里查数据库', 'sql 太多', '查询太多'],
  phantom_dependency: ['幽灵依赖', '依赖没装', '本地能跑', '找不到模块', 'node_modules', '依赖缺失'],
  flaky_test: ['flaky', '不稳定测试', '测试偶尔失败', 'ci 挂了', '重跑就好', '随机失败'],
  circular_dependency: ['循环依赖', '循环引用', '环形依赖', '相互引用', 'circular'],
  cache_invalidation: ['缓存', 'cache', '清了缓存就好', '老数据', '缓存不更新', 'cdn'],
  dangling_pointer: ['悬空指针', '野指针', 'use after free', '已释放'],
  handle_leak: ['句柄', '文件没关', '连接池', 'socket 没关', '连接泄漏'],
  encoding_nightmare: ['字符集', '转码', 'emoji 报错', 'utf8', '编码报错'],
  clock_drift: ['时钟', '超时', 'timeout', '定时器不准', '耗时不对'],
  silent_failure: ['静默失败', '没报错', '啥也没发生', '悄悄失败', '没有日志', '不出结果'],
  // ── 头目 ──
  segfault_titan: ['段错误', 'segfault', 'core dumped', '进程挂了', 'killed'],
  entropy_virus: ['熵增', '越改越乱', '代码越来越乱', '混乱'],
  legacy_colossus: ['祖传代码', '祖传', '老代码', '十年前', '没人敢改', '遗留系统'],
  cascade_avalanche: ['雪崩', '级联', '一个挂了全挂', '连锁反应', '全站崩'],
  bit_rot: ['位腐', '数据损坏', '数据烂了', '保存坏了', '位翻转'],
  debt_singularity: ['技术债', '重构', '先欠着', '欠的债', '债务'],
}

// 生成名的前后缀（按档位给后缀，让「假名」听起来仍属于那一档）
const BUG_PREFIX = [
  '午夜', '凌晨三点', '周五傍晚', '上线前一小时', '演示当天',
  '只在生产环境的', '归档十年的', '刚睡醒的', 'git blame 追不到的', '又冒出来的',
]
const BUG_SUFFIX = {
  common: ['幽灵', '小妖', '游魂', '小虫', '影子', '小怪'],
  elite: ['领主', '巫妖', '巨兽', '女巫', '猎手', '暴君'],
  boss: ['古神', '泰坦', '巨像', '奇点', '灾厄', '主宰'],
}
// 一个词都没命中时按输入哈希从这个池子里挑（都是"谁都可能遇到"的通用怪）
const BUG_FALLBACK = [
  'null_pointer', 'undefined_var', 'off_by_one', 'magic_number', 'copy_paste',
  'typo_imp', 'todo_zombie', 'float_drift', 'callback_hell', 'global_pollution',
]
// 输入框下方的示例（点一下就填进去）——写的是大家都认得的"真 Bug 现场"
const BUG_EXAMPLES = ['undefined is not a function', '偶现的竞态', '缓存不更新', '内存一直涨', '昨天还好好的']

function bugContent() {
  const ids = new Set(BUG_WORDS ? Object.keys(BUG_WORDS) : [])
  // 表里写了仓库不存在的 id 会在构建期直接报错（比线上默默失灵好）
  const sp = require(path.join(ROOT, 'plugins', 'nibble', 'hooks', 'nibble.js'))
  const known = new Set(sp.ENEMIES.map((e) => e.id))
  for (const id of ids) if (!known.has(id)) throw new Error('BUG_WORDS 里有不存在的怪物 id：' + id)
  for (const id of BUG_FALLBACK) if (!known.has(id)) throw new Error('BUG_FALLBACK 里有不存在的怪物 id：' + id)
  const missing = sp.ENEMIES.filter((e) => !ids.has(e.id)).map((e) => e.id)
  if (missing.length) throw new Error('还没给这些怪物写关键词：' + missing.join(', '))
  return {
    words: BUG_WORDS,
    prefix: BUG_PREFIX,
    suffix: BUG_SUFFIX,
    fallback: BUG_FALLBACK,
    examples: BUG_EXAMPLES,
  }
}

// —— 像素网格压缩：24x24 颜色网格 → { palette, rows }（36 色内用 base36 单字符索引，体积约为展开式 1/6）——
function encodeGrid(grid) {
  if (!grid) return null
  const palette = []
  const index = new Map()
  const rows = grid.map((row) =>
    row
      .map((c) => {
        if (!c) return '.'
        const key = String(c).toUpperCase()
        let i = index.get(key)
        if (i === undefined) {
          if (palette.length < 36) {
            i = palette.length
            palette.push(key)
            index.set(key, i)
          } else {
            i = nearestColor(key, palette) // 超过 36 色时归并到最接近的已有色
          }
        }
        return i.toString(36)
      })
      .join(''),
  )
  return { palette, rows }
}

function nearestColor(hex, palette) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r, g, b] = rgb(hex)
  let best = 0
  let bestD = Infinity
  palette.forEach((p, i) => {
    const [pr, pg, pb] = rgb(p)
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

// 固定的假存档：让图鉴一打开就有"已玩一阵"的层次（未遭遇 / 已遭遇未击败 / 已击败三态都能看到）
function demoProgress(ids) {
  const seen = {}
  const defeated = {}
  ids.forEach((id, i) => {
    if (i % 3 === 2) return
    seen[id] = { first: 0, count: 1 + (i % 4) }
    if (i % 4 !== 3) defeated[id] = 1 + (i % 3)
  })
  return { seen, defeated }
}

function buildDemoData() {
  // 复用扩展本体的数据与数值函数（同一份代码，所以官网演示与 IDE 里看到的必然一致）
  const sp = require(path.join(ROOT, 'plugins', 'nibble', 'hooks', 'nibble.js'))
  const en = require(path.join(ROOT, 'plugins', 'nibble', 'hooks', 'enemies.js'))
  const wp = require(path.join(ROOT, 'plugins', 'nibble', 'hooks', 'weapons.js'))

  const enemies = sp.ENEMIES.map((e) => ({
    id: e.id,
    name: e.name,
    tier: e.tier,
    tierLabel: sp.TIER_LABEL[e.tier] || '小怪',
    minLv: e.minLv,
    story: e.story || '',
    mech: e.mech || {},
    mechText: sp.mechSummary(e),
    // 图鉴与战斗都用同一份"无染色"网格；稀有度染色由前端按 RARITY 同规则叠加
    sprite: encodeGrid(sp.enemyGrid(e.id, 'common', false)),
  }))

  const weapons = sp.WEAPONS.map((w) => ({
    id: w.id,
    name: w.name,
    rarity: w.rarity,
    rarityLabel: sp.RARITY_LABEL[w.rarity],
    power: w.power || 0,
    story: w.story || '',
    color: sp.RARITY_COLOR[w.rarity],
    // 'box' = 图鉴用的统一内框（细长剑与胖锤视觉重量一致），战斗槽同用这一份
    sprite: encodeGrid(sp.weaponSpriteGrid(w.id, 'box')),
  }))

  // 演示存档：武器按 i % 3 !== 1 收集（自然覆盖四档稀有度），怪物按 demoProgress 铺开三态
  const owned = {}
  sp.WEAPONS.forEach((w, i) => {
    if (i % 3 !== 1) owned[w.id] = 1 + (i % 3)
  })
  const prog = demoProgress(sp.ENEMIES.map((e) => e.id))

  const data = {
    generatedAt: new Date().toISOString().slice(0, 10),
    version: require(path.join(ROOT, 'vscode-extension', 'package.json')).version,
    player: encodeGrid(sp.decodeGrid('player').grid),
    enemies,
    weapons,
    demo: { level: DEMO.level, exp: DEMO.exp, pity: DEMO.pity, owned, current: 'race_condition', ...prog },
    meta: {
      enemyTotal: sp.ENEMY_TOTAL,
      // 展示顺序固定"小怪 → 精英 → 头目"（与面板图鉴一致；enemies.js 里的 TIER_ORDER 是给卡片用的反序）
      tierOrder: ['common', 'elite', 'boss'],
      tierCounts: sp.TIER_COUNTS,
      tierLabel: sp.TIER_LABEL,
      tierColor: { common: '#8FA3B8', elite: '#C08BE0', boss: '#F0A04B' },
      tierMul: en.TIER_MUL,
      rarityMul: en.RARITY_MUL,
      rarityLabel: sp.RARITY_LABEL,
      rarityColor: sp.RARITY_COLOR,
      rarityCounts: sp.RARITY_COUNTS,
      weaponTotal: sp.WEAPON_TOTAL,
      weaponPower: sp.WEAPON_POWER,
      pityLimit: sp.PITY_LIMIT,
      dropOdds: wp.RARITY_DROP,
      xpNeed: sp.xpNeed(DEMO.level),
      baseHp: en.BASE_HP(DEMO.level),
      playerAtk: sp.playerAtk(DEMO.level),
    },
    // 记忆点：输入 → 40 只真怪（关键词表 + 命名模板 + 示例）；匹配与展示全在前端，不回传任何东西
    bug: bugContent(),
  }
  return data
}

// —— index.html 占位符填充：所有展示型文案都从真数据来，避免官网与仓库漂移 ——
function fill(tpl, data) {
  const m = data.meta
  const pct = (v) => Math.round(v * 100) + '%'
  const order = ['common', 'rare', 'epic', 'legendary']

  const stats = m.tierOrder
    .map((t) => `<span class="stat"><b>${m.tierCounts[t]}</b>${m.tierLabel[t]}<i>×${m.tierMul[t]}</i></span>`)
    .join('')

  const wall = m.tierOrder
    .map((t) => {
      const list = data.enemies.filter((e) => e.tier === t)
      const pills = list
        .map(
          (e) =>
            `<li><button type="button" class="pill" data-tier="${t}" title="${
              e.mechText ? e.mechText : '无特殊机制'
            }"><span class="dot" style="--c:${m.tierColor[t]}"></span>${e.name}</button></li>`,
        )
        .join('')
      return `<div class="wall-group"><h3><span class="dot" style="--c:${m.tierColor[t]}"></span>${m.tierLabel[t]} ${
        list.length
      } 只</h3><ul class="wall">${pills}</ul></div>`
    })
    .join('')

  const quotes = ['race_condition', 'todo_zombie', 'debt_singularity']
    .map((id) => data.enemies.filter((e) => e.id === id)[0])
    .filter(Boolean)
    .map(
      (e) => `<figure class="quote">
  <blockquote>${e.story}</blockquote>
  <figcaption><span class="dot" style="--c:${m.tierColor[e.tier]}"></span>${e.name}<i>${e.tierLabel}${
        e.mechText ? ' · ' + e.mechText : ''
      }</i></figcaption>
</figure>`,
    )
    .join('')

  const rarities = order
    .map(
      (r) =>
        `<li><span class="dot" style="--c:${m.rarityColor[r]}"></span><b>${m.rarityLabel[r]}</b><i>${m.rarityCounts[r]} 把 · 掉落 ${pct(
          m.dropOdds[r],
        )} · 战力 +${m.weaponPower[r]}%</i></li>`,
    )
    .join('')

  const vars = {
    '{{VERSION}}': data.version,
    '{{ENEMY_TOTAL}}': m.enemyTotal,
    '{{WEAPON_TOTAL}}': m.weaponTotal,
    '{{PITY_LIMIT}}': m.pityLimit,
    '{{BUILD_DATE}}': data.generatedAt,
    '{{ENEMY_STATS}}': stats,
    '{{ENEMY_WALL}}': wall,
    '{{BUG_QUOTES}}': quotes,
    '{{RARITY_TABLE}}': rarities,
    '{{DROP_ODDS}}': order.map((r) => `${m.rarityLabel[r]} ${pct(m.dropOdds[r])}`).join(' / '),
    '{{POWER_ODDS}}': order.map((r) => `${m.rarityLabel[r]} +${m.weaponPower[r]}%`).join(' / '),
  }
  let out = tpl
  for (const k of Object.keys(vars)) out = out.split(k).join(String(vars[k]))
  const left = out.match(/\{\{[A-Z_]+\}\}/g)
  if (left) throw new Error('index.html 里存在未填充的占位符：' + [...new Set(left)].join(', '))
  return out
}

// favicon：把玩家的 24x24 网格画成 SVG（同色横向像素合并成一条 rect，体积小、放大也不糊）
function favicon(sp) {
  const rects = []
  sp.rows.forEach((row, y) => {
    let x = 0
    while (x < 24) {
      const ch = row[x]
      if (!ch || ch === '.') {
        x++
        continue
      }
      let run = 1
      while (row[x + run] && row[x + run] === ch) run++
      rects.push(
        '<rect x="' + x + '" y="' + y + '" width="' + run + '" height="1" fill="' + sp.palette[parseInt(ch, 36)] + '"/>',
      )
      x += run
    }
  })
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">' +
    '<rect width="24" height="24" fill="#0D0F14"/>' +
    rects.join('') +
    '</svg>\n'
  )
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function build() {
  const data = buildDemoData()
  rm(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // 1) 站点自身文件（index.html 走占位符填充；连同子目录里的字体一起搬）
  //    site/fonts/src/ 是官方原始字体（3.8MB）不入库也不复制，产物只带子集化后的 woff2
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name)
      const r = rel ? rel + '/' + name : name
      if (r === 'fonts/src' || r.startsWith('fonts/src/')) continue
      if (fs.statSync(abs).isDirectory()) {
        walk(abs, r)
        continue
      }
      if (r === 'index.html') {
        fs.writeFileSync(path.join(OUT_DIR, r), fill(fs.readFileSync(abs, 'utf8'), data), 'utf8')
      } else {
        copyFile(abs, path.join(OUT_DIR, r))
      }
    }
  }
  walk(SITE_DIR, '')

  // 2) 复用扩展素材
  for (const name of COPIES) copyFile(path.join(MEDIA_DIR, name), path.join(OUT_DIR, name))

  // 3) 演示数据（构建期生成，不入库）
  fs.writeFileSync(
    path.join(OUT_DIR, 'demo-data.js'),
    '/* 由 tools/build-site.js 生成，请勿手改；数据源：plugins/nibble/hooks/nibble.js */\n' +
      'window.NIBBLE_DEMO = ' +
      JSON.stringify(data) +
      ';\n',
    'utf8',
  )

  // 3.5) 字体子集漂移检查：页面/演示数据里出现了没打包的汉字，会静默回落到系统字体
  const charsetFile = path.join(SITE_DIR, 'fonts', 'charset.txt')
  if (fs.existsSync(charsetFile)) {
    const have = new Set(fs.readFileSync(charsetFile, 'utf8'))
    const missing = new Set()
    for (const f of ['index.html', 'demo-data.js', 'site.js', 'site.css']) {
      const p = path.join(OUT_DIR, f)
      if (!fs.existsSync(p)) continue
      for (const ch of fs.readFileSync(p, 'utf8')) {
        const cp = ch.codePointAt(0)
        if (cp >= 0x2000) { // 标点/符号/emoji 不进这个检查（字体本来就不含 emoji）
          if (!have.has(ch)) missing.add(ch)
        }
      }
    }
    if (missing.size) {
      console.warn(
        '⚠ ' + missing.size + ' 个字符不在字体子集里（会回落系统字体）：' +
          [...missing].slice(0, 40).join('') + '  → 重跑 npm run font 即可补齐',
      )
    }
  }

  // 4) favicon：用拾玖自己的像素数据现画（不额外维护图标文件）
  fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), favicon(data.player), 'utf8')

  // 5) 关掉 Pages 的 Jekyll（Actions 部署其实用不到，留着以防切回分支部署）
  fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '', 'utf8')

  // 递归算总字节：原来的写法只读顶层，site/fonts/ 这种子目录会被漏掉（少报 ~80KB）
  const dirSize = (dir) =>
    fs.readdirSync(dir).reduce((sum, n) => {
      const abs = path.join(dir, n)
      return sum + (fs.statSync(abs).isDirectory() ? dirSize(abs) : fs.statSync(abs).size)
    }, 0)
  const size = dirSize(OUT_DIR)
  console.log(
    '✓ 已组装 _site/（' +
      data.meta.enemyTotal +
      ' 只怪物 · ' +
      data.meta.weaponTotal +
      ' 把武器 · v' +
      data.version +
      ' · ' +
      Math.round(size / 1024) +
      ' KB）',
  )
  return OUT_DIR
}

// —— 本地预览服务器（和 Pages 上看到的是同一份产物）——
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

function serve(dir, port) {
  http
    .createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
      const file = path.join(dir, rel)
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found: ' + rel)
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    })
    .listen(port, '127.0.0.1', () => console.log('▶ 官网预览：http://127.0.0.1:' + port + '/'))
}

if (require.main === module) {
  const out = build()
  const i = process.argv.indexOf('--serve')
  if (i >= 0) serve(out, Number(process.argv[i + 1]) || 4600)
}

module.exports = { build }
