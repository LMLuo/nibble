'use strict'
// nibble.js — 战斗核心 + 状态持久化 + 像素渲染（CodeBuddy 原生版，运行时零第三方依赖）
//
// 设计要点：
//   - 只读 stdin 里的"节奏事件"，**绝不读取 prompt 内容/文件/路径/代码**（cli.js 只取 hook_event_name 等元数据）。
//   - 存档写入 ${CODEBUDDY_PLUGIN_DATA}/save.json（跨会话持久化，替代 Mods 版的 $.store）。
//   - 渲染用 ANSI 256 色 + 半方块 ▀（前景=上像素、背景=下像素），终端状态栏可直接显示。

const fs = require('fs')
const os = require('os')
const path = require('path')
const { PIXEL_DATA } = require('./pixels')
const { WEAPONS, WEAPON_INDEX, WEAPON_TOTAL, RARITY_COUNTS, PITY_LIMIT, rollWeapon, weaponSpriteGrid, WEAPON_POWER, bestOwnedWeapon } = require('./weapons')
const {
  ENEMIES, ENEMY_INDEX, ENEMY_TOTAL, TIER_COUNTS, TIER_LABEL, TIER_ORDER,
  enemyMaxHp, pickEnemy, mechSummary,
} = require('./enemies')

// 怪物素材（构建期由 tools/monsters-sprites.mjs 生成）；未构建时回落到内置素材，保证不崩
let ENEMY_PIXEL_DATA = {}
try { ENEMY_PIXEL_DATA = require('./enemies-pixels').ENEMY_PIXEL_DATA || {} } catch { /* 素材未生成 */ }

// ============================ 网格解码 / 变换 ============================
const GRID_CACHE = new Map()
const TINT_CACHE = new Map()

function decodeGrid(name) {
  if (GRID_CACHE.has(name)) return GRID_CACHE.get(name)
  // 怪物素材优先取 enemies-pixels.js，其次回落到内置素材（主角与早期敌人）
  const { palette, rows } = ENEMY_PIXEL_DATA[name] || PIXEL_DATA[name] || PIXEL_DATA.slime
  const grid = rows.map((row) =>
    [...row].map((ch) => (ch === '.' ? null : palette[parseInt(ch, 36)] || null)),
  )
  let spark = null
  for (let r = 0; r < grid.length && !spark; r++) {
    const cols = grid[r].map((c, i) => (c ? i : -1)).filter((i) => i >= 0)
    if (cols.length) spark = { r, c: cols[Math.floor(cols.length / 2)] }
  }
  const val = { grid, spark }
  GRID_CACHE.set(name, val)
  return val
}

// 平移（dx 右移 / dy 下移），越界置透空
function shiftGrid(grid, dx, dy) {
  const n = grid.length
  const out = []
  for (let r = 0; r < n; r++) {
    const src = grid[r - dy]
    if (!src) { out.push(new Array(n).fill(null)); continue }
    const row = []
    for (let c = 0; c < n; c++) {
      const sc = c - dx
      row.push(sc >= 0 && sc < n ? src[sc] : null)
    }
    out.push(row)
  }
  return out
}

const h2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase()

function tintGrid(grid, hexColor, strength) {
  const tr = parseInt(hexColor.slice(1, 3), 16)
  const tg = parseInt(hexColor.slice(3, 5), 16)
  const tb = parseInt(hexColor.slice(5, 7), 16)
  return grid.map((row) =>
    row.map((c) => {
      if (!c) return c
      const r = parseInt(c.slice(1, 3), 16) * (1 - strength) + tr * strength
      const g = parseInt(c.slice(3, 5), 16) * (1 - strength) + tg * strength
      const b = parseInt(c.slice(5, 7), 16) * (1 - strength) + tb * strength
      return '#' + h2(r) + h2(g) + h2(b)
    }),
  )
}

// 敌人网格：稀有度着色 + 隔帧闪烁亮点像素
function enemyGrid(name, rarity, blink) {
  const base = decodeGrid(name)
  let g = base.grid
  if (rarity === 'epic' || rarity === 'legendary') {
    const key = name + '|' + rarity
    if (!TINT_CACHE.has(key)) {
      TINT_CACHE.set(key, tintGrid(g, rarity === 'epic' ? '#E040E0' : '#FFD700', rarity === 'epic' ? 0.35 : 0.55))
    }
    g = TINT_CACHE.get(key)
  }
  if (blink && base.spark) {
    g = g.map((row) => row.slice())
    g[base.spark.r][base.spark.c] = '#FFFFFF'
  }
  return g
}

// 下采样：24x24 → w×h（取区块内出现最多的非空颜色），用于状态栏小头像
function miniGrid(grid, w, h) {
  const bw = grid.length / w
  const bh = grid.length / h
  const out = []
  for (let y = 0; y < h; y++) {
    const row = []
    for (let x = 0; x < w; x++) {
      const counts = new Map()
      for (let sy = Math.floor(y * bh); sy < Math.floor((y + 1) * bh); sy++) {
        for (let sx = Math.floor(x * bw); sx < Math.floor((x + 1) * bw); sx++) {
          const c = grid[sy] && grid[sy][sx]
          if (c) counts.set(c, (counts.get(c) || 0) + 1)
        }
      }
      let best = null
      let bestN = -1
      for (const [k, nn] of counts) if (nn > bestN) { bestN = nn; best = k }
      row.push(best)
    }
    out.push(row)
  }
  return out
}

// ============================ ANSI 256 色 ============================
function rgbOf(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// 24bit hex → xterm-256 索引（6x6x6 色立方 or 灰阶，取更接近者）
function ansi256(hex) {
  const [r, g, b] = rgbOf(hex)
  const step = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)))
  const ri = step(r)
  const gi = step(g)
  const bi = step(b)
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi
  const cubeRgb = [ri ? ri * 40 + 55 : 0, gi ? gi * 40 + 55 : 0, bi ? bi * 40 + 55 : 0]
  const gray = Math.round((r + g + b) / 3)
  const grayIdx = gray < 8 ? 16 : gray > 248 ? 231 : 232 + Math.round(((gray - 8) / 247) * 23)
  const grayVal = grayIdx === 16 ? 0 : grayIdx === 231 ? 255 : 8 + (grayIdx - 232) * 10
  const d = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
  const useCube = d([r, g, b], cubeRgb) <= d([r, g, b], [grayVal, grayVal, grayVal])
  return useCube ? cubeIdx : grayIdx
}

const RESET = '\x1b[0m'
const FG_DEFAULT = '\x1b[39m'
const BG_DEFAULT = '\x1b[49m'
const fg = (hex) => `\x1b[38;5;${ansi256(hex)}m`
const bg = (hex) => `\x1b[48;5;${ansi256(hex)}m`

// 半方块渲染：每 2 行像素 → 1 行文本；useColor=false 时输出纯字符剪影（用于命令卡片）
function renderHalfBlock(grid, w, h, useColor) {
  const lines = []
  for (let r = 0; r < h; r += 2) {
    let s = ''
    let lastF = null
    let lastB = null
    for (let c = 0; c < w; c++) {
      const top = (grid[r] && grid[r][c]) || null
      const bot = (grid[r + 1] && grid[r + 1][c]) || null
      if (!top && !bot) {
        if (useColor) { s += FG_DEFAULT + BG_DEFAULT }
        s += ' '
        lastF = null
        lastB = null
        continue
      }
      if (!useColor) { s += '█'; continue }
      if (top !== lastF) { s += top ? fg(top) : FG_DEFAULT; lastF = top }
      if (bot !== lastB) { s += bot ? bg(bot) : BG_DEFAULT; lastB = bot }
      s += '▀'
    }
    lines.push(useColor ? s + RESET : s)
  }
  return lines
}

// 灰度阴影渲染（无 ANSI）：每 2 行像素合成 1 个字符，按亮度映射 ░▒▓█（适合在代码块中原样展示）
function renderShaded(grid, w, h) {
  const lum = (hex) => {
    const [r, g, b] = rgbOf(hex)
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
  const lines = []
  for (let r = 0; r < h; r += 2) {
    let s = ''
    for (let c = 0; c < w; c++) {
      const top = (grid[r] && grid[r][c]) || null
      const bot = (grid[r + 1] && grid[r + 1][c]) || null
      if (!top && !bot) { s += ' '; continue }
      const l = Math.max(top ? lum(top) : 0, bot ? lum(bot) : 0)
      s += l > 170 ? '█' : l > 120 ? '▓' : l > 70 ? '▒' : '░'
    }
    lines.push(s)
  }
  return lines
}

// ============================ 战斗状态与存档 ============================
// 怪物名表由 enemies.js 派生（40 只「编程 Bug」怪物）；ENEMY_NAMES 保留为兼容出口
const ENEMY_NAMES = {}
for (const e of ENEMIES) ENEMY_NAMES[e.id] = e.name
const RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }
const RARITY_COLOR = { common: '#FFB86B', rare: '#FFE066', epic: '#E040E0', legendary: '#FFD700' }
const STARTER_ENEMY = 'null_pointer'

// 怪物条目查询（未知 id 回落到首只小怪，避免脏存档导致崩溃）
function enemyInfo(id) {
  const e = ENEMY_INDEX[id] || ENEMY_INDEX[STARTER_ENEMY] || ENEMIES[0]
  return {
    id: e.id,
    name: e.name,
    tier: e.tier,
    tierLabel: TIER_LABEL[e.tier] || '小怪',
    mech: e.mech || {},
    mechText: mechSummary(e),
    story: e.story || '',
  }
}

function dataDir() {
  const env = process.env.CODEBUDDY_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA
  const dir = env || path.join(os.homedir(), '.codebuddy', 'plugins', 'data', 'nibble')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}
const savePath = () => path.join(dataDir(), 'save.json')

let save = null

function freshSave() {
  return {
    v: 1, level: 1, exp: 0, battles: 0, defeats: 0, lastLog: null, logKind: 'idle', enemy: null,
    arsenal: { owned: {}, pity: 0 }, lastDrop: null, equipped: null,
    bestiary: { seen: {}, defeated: {} },
    streak: { count: 0, lastAt: 0 }, lastDmg: 0,
  }
}

// 解析武器库存档：只接受已知武器 id，未知 id 静默丢弃（向前兼容加/删武器）
function parseArsenal(a) {
  const out = { owned: {}, pity: 0 }
  if (a && typeof a === 'object') {
    if (a.owned && typeof a.owned === 'object') {
      for (const k of Object.keys(a.owned)) {
        if (WEAPON_INDEX[k]) out.owned[k] = Math.max(1, Number(a.owned[k]) || 1)
      }
    }
    out.pity = Math.max(0, Number(a.pity) || 0)
  }
  return out
}

// 解析怪物库存档：只接受已知怪物 id（未知 id 静默丢弃，向前兼容加/删怪物）
function parseBestiary(b) {
  const out = { seen: {}, defeated: {} }
  if (b && typeof b === 'object') {
    if (b.defeated && typeof b.defeated === 'object') {
      for (const k of Object.keys(b.defeated)) {
        if (!ENEMY_INDEX[k]) continue
        const n = Math.max(0, Number(b.defeated[k]) || 0)
        if (n > 0) out.defeated[k] = n
      }
    }
    if (b.seen && typeof b.seen === 'object') {
      for (const k of Object.keys(b.seen)) {
        if (!ENEMY_INDEX[k]) continue
        const v = b.seen[k] || {}
        out.seen[k] = { first: Number(v.first) || 0, count: Math.max(1, Number(v.count) || 1) }
      }
    }
    // 已击败但缺 seen 记录（旧档/异常档）自动补一条，保证双状态自洽
    for (const k of Object.keys(out.defeated)) {
      if (!out.seen[k]) out.seen[k] = { first: 0, count: out.defeated[k] }
    }
  }
  return out
}

function ensureBestiary(s) {
  if (!s.bestiary) s.bestiary = parseBestiary(null)
  return s.bestiary
}

// 遭遇即入库（首次记时间戳，之后累加次数）
function markSeen(s, id) {
  if (!ENEMY_INDEX[id]) return
  const b = ensureBestiary(s)
  const rec = b.seen[id]
  if (rec) rec.count += 1
  else b.seen[id] = { first: Date.now(), count: 1 }
}

function markDefeated(s, id) {
  if (!ENEMY_INDEX[id]) return
  const b = ensureBestiary(s)
  b.defeated[id] = (b.defeated[id] || 0) + 1
  if (!b.seen[id]) b.seen[id] = { first: Date.now(), count: 1 }
}

// 成长曲线
const xpNeed = (lv) => 20 + (lv - 1) * 15
// 等级攻击成长刻意压低（原 4+2lv）：强度缺口交给武器战力补，武器才"有作用"（见 07 文档「战力系统」）
const playerAtk = (lv) => Math.round(4 + lv * 1.2)
// 怪物 HP 由 enemies.js 的 tier / 稀有度 / 等级三重缩放给出（详见 08 文档「难度模型」）

// ============================ 连击（Streak）============================
// 设计文档：docs/游戏升级规划/09-连击系统设计.md
// 规则：连续提问（间隔 ≤ 10 分钟）累积连击；断连**静默归零、无任何惩罚**（只奖励连续）。
// 效果：≥10 起势（+10% 攻击，每连 +1%，封顶 +30%）；≥25 燃（掉落保底额外推进）；
//       ≥50 超载（面板一次性演出，由扩展侧比较档位跨越触发）。
// 关键：<10 连对**画面与数值**都完全隐形——玩家照常写代码，连击自己累积。
const STREAK_WINDOW = 10 * 60 * 1000
const STREAK_T1 = 10
const STREAK_T2 = 25
const STREAK_T3 = 50
const STREAK_MAX_BONUS = 30

// 当前有效连击（超窗即视为 0，展示与生效同源；旧档/异常档静默归一）
function streakState(s, now) {
  const st = s && s.streak
  const t = now || Date.now()
  if (!st || !st.count || !st.lastAt || t - st.lastAt > STREAK_WINDOW) return { count: 0, bonus: 0, tier: 0 }
  const count = Math.max(0, Number(st.count) || 0)
  const bonus = count >= STREAK_T1 ? Math.min(STREAK_T1 + (count - STREAK_T1), STREAK_MAX_BONUS) : 0
  const tier = count >= STREAK_T3 ? 3 : count >= STREAK_T2 ? 2 : count >= STREAK_T1 ? 1 : 0
  return { count, bonus, tier }
}

// 本次攻击计入连击：窗口内 +1，超窗从 1 重新开始（不提示、不惩罚）
function bumpStreak(s, now) {
  const t = now || Date.now()
  if (!s.streak || typeof s.streak !== 'object') s.streak = { count: 0, lastAt: 0 }
  const cnt = Number(s.streak.count) || 0
  s.streak.count = t - (Number(s.streak.lastAt) || 0) <= STREAK_WINDOW ? cnt + 1 : 1
  s.streak.lastAt = t
  return s.streak.count
}

// 日志尾标（<10 连返回空串：连击对文字也隐形）
function streakTag(sk) {
  if (!sk || !sk.tier) return ''
  const tail = sk.tier >= 3 ? ' · 超载' : sk.tier >= 2 ? ' · 火力全开' : ''
  return `（×${sk.count} 连击${tail}）`
}

// 玩家实际攻击力 = 等级基础 ×（1 + 武器战力% + 连击加成%）
// ⚠️ atk 刻意保留小数：先取整会在低等级直接把 +8%/+15% 抹平（见 tools/balance-sim.js）
function playerAtkWith(s) {
  const base = playerAtk(s.level)
  const w = equippedWeapon(s)
  const power = w ? w.power : 0
  const sk = streakState(s)
  return {
    base, weapon: w, power,
    streak: sk.count, streakBonus: sk.bonus, streakTier: sk.tier,
    atk: Math.max(1, base * (1 + (power + sk.bonus) / 100)),
  }
}

function rollRarity(lv) {
  const b = Math.min((lv - 1) * 0.01, 0.12)
  const r = Math.random()
  if (r < 0.7 - b * 2) return 'common'
  if (r < 0.9 - b) return 'rare'
  if (r < 0.98) return 'epic'
  return 'legendary'
}

// 抽取并登记一只新怪：tier 权重随等级浮动，遭遇即写入怪物库
function spawnEnemy(s, opts) {
  const entry = (opts && opts.entry) || pickEnemy(s.level)
  const rarity = (opts && opts.rarity) || rollRarity(s.level)
  const maxHp = (opts && opts.maxHp) || enemyMaxHp(s.level, entry, rarity)
  const mech = entry.mech || {}
  s.enemy = {
    type: entry.id,
    rarity,
    hp: maxHp,
    maxHp,
    shieldLeft: mech.shield || 0,
    splitDone: false,
  }
  markSeen(s, entry.id)
  return s.enemy
}

function loadSave() {
  if (save) return save
  save = freshSave()
  try {
    const parsed = JSON.parse(fs.readFileSync(savePath(), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.v === 1) {
      const s = freshSave()
      s.level = Number(parsed.level) || 1
      s.exp = Number(parsed.exp) || 0
      s.battles = Number(parsed.battles) || 0
      s.defeats = Number(parsed.defeats) || 0
      const e = parsed.enemy
      if (e && ENEMY_INDEX[e.type] && typeof e.hp === 'number' && typeof e.maxHp === 'number' && e.hp > 0) {
        s.enemy = {
          type: e.type,
          rarity: RARITY_LABEL[e.rarity] ? e.rarity : 'common',
          hp: e.hp,
          maxHp: e.maxHp,
          shieldLeft: Math.max(0, Number(e.shieldLeft) || 0),
          splitDone: !!e.splitDone,
        }
      }
      if (typeof parsed.lastLog === 'string') s.lastLog = parsed.lastLog
      if (typeof parsed.logKind === 'string') s.logKind = parsed.logKind
      s.arsenal = parseArsenal(parsed.arsenal)
      s.bestiary = parseBestiary(parsed.bestiary)
      // 连击（旧档没有 → 默认 0 连）；lastDmg 只用于面板飘字
      const st = parsed.streak
      if (st && typeof st === 'object') {
        s.streak = { count: Math.max(0, Number(st.count) || 0), lastAt: Math.max(0, Number(st.lastAt) || 0) }
      }
      s.lastDmg = Math.max(0, Number(parsed.lastDmg) || 0)
      if (parsed.lastDrop && typeof parsed.lastDrop === 'object' && WEAPON_INDEX[parsed.lastDrop.id]) {
        s.lastDrop = { id: parsed.lastDrop.id, at: Number(parsed.lastDrop.at) || 0 }
      }
      if (parsed.equipped && WEAPON_INDEX[parsed.equipped] && s.arsenal.owned[parsed.equipped]) {
        s.equipped = parsed.equipped
      }
      save = s
    }
  } catch { /* 无存档或损坏 → 全新开始 */ }
  if (!save.enemy) spawnEnemy(save)
  return save
}

function saveSave() {
  try { fs.writeFileSync(savePath(), JSON.stringify(save), 'utf8') } catch { /* ignore */ }
}

// 丢弃内存缓存并重新读盘（IDE 扩展需要，因为 hooks 是另一个进程在写同一份存档）
function reloadSave() {
  save = null
  return loadSave()
}

function gainExp(s, amount) {
  s.exp += amount
  let ups = 0
  while (s.exp >= xpNeed(s.level)) { s.exp -= xpNeed(s.level); s.level += 1; ups += 1 }
  return ups
}

// 一次攻击：应用怪物机制（闪避/护盾/护甲/自愈/分裂）→ 返回一行战斗日志
function attack(s) {
  const enemy = s.enemy
  const info = enemyInfo(enemy.type)
  const mech = info.mech
  // 连击：本次攻击先计入，再按新连击结算（≥10 起才有加成与文案）
  bumpStreak(s)
  const sk = streakState(s)
  const tag = streakTag(sk)
  const atk = playerAtkWith(s).atk // 等级基础 ×（1 + 武器战力% + 连击加成%）
  s.battles += 1

  // 伤害波动改为按比例（±10%）而非固定 ±2：低等级下固定抖动会淹没武器战力的差距
  let dmg = Math.max(1, Math.round(atk * (0.9 + Math.random() * 0.2)))
  const notes = []
  if (mech.dodge && Math.random() < mech.dodge) {
    dmg = 0
    notes.push('闪避')
  } else {
    if (enemy.shieldLeft > 0) {
      dmg = Math.max(1, Math.round(dmg / 2))
      enemy.shieldLeft -= 1
      notes.push('护盾格挡')
    }
    if (mech.armor) {
      const before = dmg
      dmg = Math.max(1, dmg - mech.armor)
      if (dmg < before) notes.push(`护甲 ${mech.armor}`)
    }
  }
  enemy.hp = Math.max(0, enemy.hp - dmg)
  const note = notes.length ? `（${notes.join('·')}）` : ''
  s.lastDmg = dmg // 面板伤害飘字用（0 = 未命中，飘字跳过）

  // 未死：结算自愈
  if (enemy.hp > 0) {
    let log = `Nibble 攻击！${info.name} -${dmg} HP${note}${tag}`
    if (mech.regen) {
      const healed = Math.min(mech.regen, enemy.maxHp - enemy.hp)
      if (healed > 0) {
        enemy.hp += healed
        log += `　💚 ${info.name} 自愈 +${healed} HP`
      }
    }
    s.logKind = 'attack'
    s.lastLog = log
    return log
  }

  // 首次归零且带分裂：原地分裂成两只 50% HP 个体（整场只触发一次）
  if (mech.split && !enemy.splitDone) {
    enemy.splitDone = true
    const childHp = Math.max(1, Math.round(enemy.maxHp * 0.5))
    enemy.maxHp = childHp
    enemy.hp = childHp
    enemy.shieldLeft = 0
    const log = `🧬 ${info.name} 受创分裂！重置为 ${childHp} HP（分裂体 ×2）`
    s.logKind = 'attack'
    s.lastLog = log
    return log
  }

  // 击败：记怪物库 + 掉武器 + 刷新新怪
  enemy.hp = 0
  s.defeats += 1
  const b = ensureBestiary(s)
  const firstTime = !b.defeated[enemy.type]
  markDefeated(s, enemy.type)
  const gain = 6 + Math.round(enemy.maxHp * 0.6)
  const ups = gainExp(s, gain)
  let log = `击败 **${info.name}**（${info.tierLabel}·${RARITY_LABEL[enemy.rarity]}）！${tag}`
  log += firstTime ? '🆕 收录进怪物库' : `怪物库 ×${b.defeated[enemy.type]}`
  log += ` +${gain}XP`
  if (ups > 0) log += `　⬆ 升级 Lv ${s.level}！`
  if (!s.arsenal) s.arsenal = parseArsenal(null)
  const drop = rollWeapon(s.arsenal.pity)
  s.arsenal.pity = drop.pity
  // ≥25 连「燃」：掉落保底额外推进 1 步（加速保底，不改变单次掉落概率）
  if (sk.tier >= 2) s.arsenal.pity = Math.min(PITY_LIMIT, s.arsenal.pity + 1)
  s.arsenal.owned[drop.weapon.id] = (s.arsenal.owned[drop.weapon.id] || 0) + 1
  s.lastDrop = { id: drop.weapon.id, at: Date.now() }
  log += `　✦ 获得 ${RARITY_LABEL[drop.weapon.rarity]}·${drop.weapon.name}！`
  spawnEnemy(s)
  const next = enemyInfo(s.enemy.type)
  log += `　新的野生 ${next.name}（${next.tierLabel}·${RARITY_LABEL[s.enemy.rarity]}）出现`
  s.logKind = ups > 0 ? 'levelup' : 'victory'
  s.lastLog = log
  return log
}

function hpBar(s, total) {
  const n = total || 10
  const ratio = Math.max(0, s.enemy.hp) / s.enemy.maxHp
  const filled = Math.round(ratio * n)
  return { bar: '█'.repeat(filled) + '░'.repeat(n - filled), num: `${s.enemy.hp}/${s.enemy.maxHp}`, ratio }
}

// ============================ 输出文本 ============================

// 状态栏：1 行（玩家小头像 ⚔ 敌人小头像 + 等级 + HP 条），带 256 色与逐帧动画
function statusLine() {
  const s = loadSave()
  const frame = Math.floor(Date.now() / 700) % 2
  const pBase = decodeGrid('player').grid
  const pMini = miniGrid(pBase, 12, 2)
  const bob = frame ? [[null, null, null, null, null, null, null, null, null, null, null, null], pMini[0]] : pMini
  const eMini = miniGrid(enemyGrid(s.enemy.type, s.enemy.rarity, frame === 0), 12, 2)
  const pStr = renderHalfBlock(bob, 12, 2, true)[0]
  const eStr = renderHalfBlock(eMini, 12, 2, true)[0]
  const hp = hpBar(s)
  const hpColor = hp.ratio > 0.5 ? '#4ECDC4' : hp.ratio > 0.25 ? '#FFE066' : '#FF6B6B'
  const sword = '\x1b[1;31m⚔\x1b[0m'
  const lv = `\x1b[1;36mLv${s.level}\x1b[0m`
  const bar = fg(hpColor) + hp.bar + RESET + ' ' + hp.num
  const info = enemyInfo(s.enemy.type)
  const name = fg(RARITY_COLOR[s.enemy.rarity]) + info.name + RESET
  const atk = playerAtkWith(s)
  const wpn = atk.power ? ' ' + fg(RARITY_COLOR[atk.weapon.rarity]) + '⚔+' + atk.power + '%' + RESET : ''
  // 连击（<10 连不显示：低侵入，平时状态栏看不见它）
  const sk = streakState(s)
  const combo = sk.tier ? ' ' + fg(sk.tier >= 2 ? '#FFD75E' : '#8FC7FF') + '×' + sk.count + RESET : ''
  return `${pStr} ${sword} ${eStr}  ${lv} ${bar}${combo}  ${name}${wpn}`
}

// 战斗日志（供 hook systemMessage 使用，纯文本一行）
function battleLog() {
  const s = loadSave()
  const color = { attack: '#FF6B6B', victory: '#4ECDC4', levelup: '#FFD700' }[s.logKind] || '#4ECDC4'
  return { text: `⚔ ${s.lastLog || 'Nibble 待命'}`, color }
}

// 命令卡片：完整 24x24 战场（纯字符剪影，便于在代码块中原样显示）+ 状态
function card() {
  const s = loadSave()
  const p = renderShaded(shiftGrid(decodeGrid('player').grid, 0, 1), 24, 24)
  const e = renderShaded(enemyGrid(s.enemy.type, s.enemy.rarity, false), 24, 24)
  const rows = []
  for (let i = 0; i < 12; i++) rows.push(p[i] + '   ⚔   ' + e[i])
  const hp = hpBar(s)
  const sum = arsenalSummary(s)
  const best = bestiarySummary(s)
  const info = enemyInfo(s.enemy.type)
  const mech = info.mechText ? ` · ${info.mechText}` : ''
  return [
    '```',
    ...rows,
    '```',
    `**Lv ${s.level}** · XP ${s.exp}/${xpNeed(s.level)} · 出击 ${s.battles} 次 · 击败 ${s.defeats} 次` +
      (sum.streak >= STREAK_T1 ? ` · 连击 ×${sum.streak}` : ''),
    `HP [${hp.bar}] ${hp.num}　野生 **${info.name}**（${info.tierLabel}·${RARITY_LABEL[s.enemy.rarity]}）${mech}`,
    `🗡 攻击 ${sum.atkTotal}（等级基础 ${sum.atkBase}${sum.shown ? ` ＋ ${RARITY_LABEL[sum.shown.rarity]}·${sum.shown.name} 战力 +${sum.shown.power}%` : ' · 未持武器'}${sum.streakBonus ? ` ＋ 连击 +${sum.streakBonus}%` : ''}）`,
    `⚔ 武器库 ${sum.owned}/${sum.total}　保底 ${sum.pity}/${sum.pityLimit}${sum.shown && !sum.equipped ? '　（自动·取最高战力）' : ''}`,
    `📖 怪物库 ${best.seen}/${best.total}（已击败 ${best.defeated}）`,
    `最近：${s.lastLog || '待命中'}`,
  ].join('\n')
}

// 迷你头像（12x2 像素 → 1 行灰度字符），用于紧凑展示
function miniSprite(name, rarity) {
  const grid = name === 'player' ? decodeGrid('player').grid : enemyGrid(name, rarity, false)
  return renderShaded(miniGrid(grid, 12, 2), 12, 2)[0]
}

// 紧凑战斗面板（2 行）：头像 ⚔ 头像 + 等级/HP/敌人，第二行战斗日志
function panel() {
  const s = loadSave()
  const hp = hpBar(s)
  const info = enemyInfo(s.enemy.type)
  return [
    `${miniSprite('player')}  ⚔  ${miniSprite(s.enemy.type, s.enemy.rarity)}   Lv${s.level}  HP [${hp.bar}] ${hp.num}  ${info.name}（${info.tierLabel}·${RARITY_LABEL[s.enemy.rarity]}）`,
    s.lastLog || 'Nibble 待命中…（向 CodeBuddy 提问即可发动攻击）',
  ].join('\n')
}

// 当前**生效**的武器（同时就是战斗页展示的那把——刻意合并，避免"显示的是弱的、打的是强的"）：
//   手动装备优先；未装备则自动取已拥有里战力最高的那把（永不亏）
function equippedWeapon(s) {
  const owned = (s && s.arsenal && s.arsenal.owned) || {}
  if (s && s.equipped && WEAPON_INDEX[s.equipped] && owned[s.equipped]) return WEAPON_INDEX[s.equipped]
  return bestOwnedWeapon(owned)
}

// 装备/卸下（id 为 null 或未拥有则回到"跟随最近获得"）
function equipWeapon(id) {
  const s = loadSave()
  if (!s.arsenal) s.arsenal = parseArsenal(null)
  s.equipped = id && WEAPON_INDEX[id] && s.arsenal.owned[id] ? id : null
  saveSave()
  return s.equipped
}

// 武器库汇总（供状态栏 tooltip / 卡片 / 扩展使用）
function arsenalSummary(s) {
  const ar = (s && s.arsenal) || { owned: {}, pity: 0 }
  const ld = s && s.lastDrop && WEAPON_INDEX[s.lastDrop.id] ? WEAPON_INDEX[s.lastDrop.id] : null
  const shown = equippedWeapon(s)
  const atk = playerAtkWith(s)
  return {
    owned: Object.keys(ar.owned).length,
    total: WEAPON_TOTAL,
    pity: ar.pity,
    pityLimit: PITY_LIMIT,
    ownedMap: ar.owned,
    equipped: (s && s.equipped) || null, // 玩家手动装备的（null = 自动取最高战力）
    shown: shown ? { id: shown.id, name: shown.name, rarity: shown.rarity, power: shown.power } : null, // 当前生效/展示
    atkBase: atk.base, // 等级基础攻击
    atkTotal: Math.round(atk.atk), // 含武器战力与连击加成的实际攻击（展示取整，内部计算保留小数）
    streak: atk.streak, // 当前有效连击数（0 = 无）
    streakBonus: atk.streakBonus, // 连击提供的攻击加成（%）
    last: ld ? { id: ld.id, name: ld.name, rarity: ld.rarity, power: ld.power, story: ld.story || '', at: (s.lastDrop && s.lastDrop.at) || 0 } : null,
  }
}

// 武器库卡片：收集进度 + 保底进度 + 按稀有度分组列出已收集武器（纯收集，不影响战斗数值）
function arsenalCard() {
  const s = loadSave()
  const ar = s.arsenal || parseArsenal(null)
  const owned = ar.owned
  const uniq = Object.keys(owned).length
  const byRarity = { legendary: [], epic: [], rare: [], common: [] }
  for (const w of WEAPONS) if (owned[w.id]) byRarity[w.rarity].push(w)
  const order = ['legendary', 'epic', 'rare', 'common']
  const atk = playerAtkWith(s)
  const shown = equippedWeapon(s)
  const activeId = shown ? shown.id : null
  const lines = [
    '**⚔ Nibble 武器库**',
    '```',
    `已收集 ${uniq}/${WEAPON_TOTAL}　保底 ${Math.min(ar.pity + 1, PITY_LIMIT)}/${PITY_LIMIT}`,
    order.map((r) => `${RARITY_LABEL[r]} ${byRarity[r].length}/${RARITY_COUNTS[r]}`).join(' · '),
    `🗡 攻击 ${Math.round(atk.atk)}（等级基础 ${atk.base}${atk.power ? ` ＋ ${atk.weapon.name} 战力 +${atk.power}%` : ' · 未持武器'}）`,
    '```',
  ]
  for (const r of order) {
    if (!byRarity[r].length) continue
    lines.push(`**${RARITY_LABEL[r]}**（战力 +${WEAPON_POWER[r]}%）`)
    for (const w of byRarity[r]) {
      lines.push(`- ${w.name}${owned[w.id] > 1 ? ` ×${owned[w.id]}` : ''}${w.id === activeId ? '　← 生效中' : ''}`)
    }
  }
  if (!uniq) lines.push('（武器库空空如也——击败一只野生敌人即可掉落第一把！）')
  return lines.join('\n')
}

// 怪物库汇总（供状态栏 / 卡片 / 扩展使用）：遭遇与击败双状态
function bestiarySummary(s) {
  const b = (s && s.bestiary) || { seen: {}, defeated: {} }
  const seenIds = Object.keys(b.seen).filter((id) => ENEMY_INDEX[id])
  const defeatIds = Object.keys(b.defeated).filter((id) => ENEMY_INDEX[id] && b.defeated[id] > 0)
  const tierSeen = { common: 0, elite: 0, boss: 0 }
  const tierDefeated = { common: 0, elite: 0, boss: 0 }
  for (const id of seenIds) tierSeen[ENEMY_INDEX[id].tier] += 1
  for (const id of defeatIds) tierDefeated[ENEMY_INDEX[id].tier] += 1
  return {
    total: ENEMY_TOTAL,
    seen: seenIds.length,
    defeated: defeatIds.length,
    totalDefeats: defeatIds.reduce((n, id) => n + b.defeated[id], 0),
    tierSeen,
    tierDefeated,
    tierCounts: TIER_COUNTS,
    seenMap: b.seen,
    defeatedMap: b.defeated,
  }
}

// 怪物库卡片：已遭遇的怪物按 tier 分组列出（未遭遇的不显示，保留悬念）
function bestiaryCard() {
  const s = loadSave()
  const sum = bestiarySummary(s)
  const lines = [
    '**📖 Nibble 怪物库**',
    '```',
    `已收录 ${sum.seen}/${sum.total}　已击败 ${sum.defeated}/${sum.total}　累计击败 ${sum.totalDefeats} 次`,
    TIER_ORDER.map((t) => `${TIER_LABEL[t]} ${sum.tierSeen[t]}/${sum.tierCounts[t]}`).join(' · '),
    '```',
  ]
  for (const t of TIER_ORDER) {
    const ids = Object.keys(sum.seenMap).filter((id) => ENEMY_INDEX[id] && ENEMY_INDEX[id].tier === t)
    if (!ids.length) continue
    ids.sort((a, b) => (ENEMY_INDEX[a].minLv - ENEMY_INDEX[b].minLv) || a.localeCompare(b))
    lines.push(`**${TIER_LABEL[t]}**`)
    for (const id of ids) {
      const e = ENEMY_INDEX[id]
      const n = sum.defeatedMap[id] || 0
      const mech = mechSummary(e)
      lines.push(`- ${e.name}${n ? ` · 击败 ${n} 次` : ' · 已遭遇，尚未击败'}${mech ? `　（${mech}）` : ''}`)
    }
  }
  if (!sum.seen) lines.push('（怪物库还是空的——向 CodeBuddy 提问即可遭遇第一只「编程 Bug」怪物！）')
  return lines.join('\n')
}

function reset() {
  save = freshSave()
  spawnEnemy(save)
  saveSave()
  return '♻️ 已重置等级/经验/战绩/武器库/怪物库与当前敌人'
}

module.exports = {
  loadSave, reloadSave, saveSave, attack, spawnEnemy, statusLine, battleLog, card, panel, miniSprite,
  reset, hpBar, xpNeed, dataDir, arsenalCard, arsenalSummary, equippedWeapon, equipWeapon,
  playerAtk, playerAtkWith,
  // 连击：状态查询 + 档位常量（IDE 扩展比较档位跨越来触发超载演出）
  streakState, streakTag,
  STREAK_WINDOW, STREAK_T1, STREAK_T2, STREAK_T3, STREAK_MAX_BONUS,
  bestiaryCard, bestiarySummary, enemyInfo,
  // 供 IDE 扩展复用（把 24x24 网格交给 Webview 真彩绘制）
  decodeGrid, shiftGrid, enemyGrid, miniGrid, renderShaded, RARITY_COLOR,
  ENEMY_NAMES, RARITY_LABEL,
  // 武器库（纯收集）：数据 + 掉落 + 素材
  WEAPONS, WEAPON_INDEX, WEAPON_TOTAL, RARITY_COUNTS, PITY_LIMIT, rollWeapon, weaponSpriteGrid,
  WEAPON_POWER, bestOwnedWeapon,
  // 怪物库（40 只「编程 Bug」怪物）：数据 + 数值 + 机制
  ENEMIES, ENEMY_INDEX, ENEMY_TOTAL, TIER_COUNTS, TIER_LABEL, TIER_ORDER, mechSummary, enemyMaxHp, pickEnemy,
}
