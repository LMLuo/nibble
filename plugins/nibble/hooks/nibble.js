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

// ============================ 网格解码 / 变换 ============================
const GRID_CACHE = new Map()
const TINT_CACHE = new Map()

function decodeGrid(name) {
  if (GRID_CACHE.has(name)) return GRID_CACHE.get(name)
  const { palette, rows } = PIXEL_DATA[name]
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
const ENEMY_NAMES = { bat: '蝙蝠', slime: '史莱姆', mimic: '宝箱怪' }
const ENEMY_TYPES = Object.keys(ENEMY_NAMES)
const RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }
const RARITY_COLOR = { common: '#FFB86B', rare: '#FFE066', epic: '#E040E0', legendary: '#FFD700' }

function dataDir() {
  const env = process.env.CODEBUDDY_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA
  const dir = env || path.join(os.homedir(), '.codebuddy', 'plugins', 'data', 'nibble')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}
const savePath = () => path.join(dataDir(), 'save.json')

let save = null

function freshSave() {
  return { v: 1, level: 1, exp: 0, battles: 0, defeats: 0, lastLog: null, logKind: 'idle', enemy: null }
}

// 成长曲线
const xpNeed = (lv) => 20 + (lv - 1) * 15
const playerAtk = (lv) => 4 + lv * 2
const enemyMaxHp = (lv) => 30 + (lv - 1) * 8 + Math.floor(Math.random() * 16)

function rollRarity(lv) {
  const b = Math.min((lv - 1) * 0.01, 0.12)
  const r = Math.random()
  if (r < 0.7 - b * 2) return 'common'
  if (r < 0.9 - b) return 'rare'
  if (r < 0.98) return 'epic'
  return 'legendary'
}

function spawnEnemy(s) {
  const type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)]
  const maxHp = enemyMaxHp(s.level)
  s.enemy = { type, rarity: rollRarity(s.level), hp: maxHp, maxHp }
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
      if (e && ENEMY_NAMES[e.type] && typeof e.hp === 'number' && typeof e.maxHp === 'number' && e.hp > 0) {
        s.enemy = { type: e.type, rarity: RARITY_LABEL[e.rarity] ? e.rarity : 'common', hp: e.hp, maxHp: e.maxHp }
      }
      if (typeof parsed.lastLog === 'string') s.lastLog = parsed.lastLog
      if (typeof parsed.logKind === 'string') s.logKind = parsed.logKind
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

// 一次攻击：返回一行战斗日志
function attack(s) {
  const atk = playerAtk(s.level)
  const dmg = Math.max(1, atk + Math.floor(Math.random() * 5) - 2)
  s.enemy.hp -= dmg
  s.battles += 1
  if (s.enemy.hp <= 0) {
    s.enemy.hp = 0
    s.defeats += 1
    const caught = Math.random() < 0.7
    const gain = 8 + s.enemy.maxHp
    const ups = gainExp(s, gain)
    let log = `击败野生 ${ENEMY_NAMES[s.enemy.type]}（${RARITY_LABEL[s.enemy.rarity]}）！${caught ? '捕获成功' : '未捕获'} +${gain}XP`
    if (ups > 0) log += `　⬆ 升级 Lv ${s.level}！`
    spawnEnemy(s)
    log += `　新的野生 ${ENEMY_NAMES[s.enemy.type]}（${RARITY_LABEL[s.enemy.rarity]}）出现`
    s.logKind = ups > 0 ? 'levelup' : 'victory'
    s.lastLog = log
    return log
  }
  const log = `Nibble 攻击！野生 ${ENEMY_NAMES[s.enemy.type]} -${dmg} HP`
  s.logKind = 'attack'
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
  const name = fg(RARITY_COLOR[s.enemy.rarity]) + ENEMY_NAMES[s.enemy.type] + RESET
  return `${pStr} ${sword} ${eStr}  ${lv} ${bar}  ${name}`
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
  return [
    '```',
    ...rows,
    '```',
    `**Lv ${s.level}** · XP ${s.exp}/${xpNeed(s.level)} · 攻击 ${s.battles} 次 · 击败 ${s.defeats} 次`,
    `HP [${hp.bar}] ${hp.num}　野生 **${ENEMY_NAMES[s.enemy.type]}**（${RARITY_LABEL[s.enemy.rarity]}）`,
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
  return [
    `${miniSprite('player')}  ⚔  ${miniSprite(s.enemy.type, s.enemy.rarity)}   Lv${s.level}  HP [${hp.bar}] ${hp.num}  ${ENEMY_NAMES[s.enemy.type]}（${RARITY_LABEL[s.enemy.rarity]}）`,
    s.lastLog || 'Nibble 待命中…（向 CodeBuddy 提问即可发动攻击）',
  ].join('\n')
}

function reset() {
  save = freshSave()
  spawnEnemy(save)
  saveSave()
  return '♻️ 已重置等级/经验/战绩与当前敌人'
}

module.exports = {
  loadSave, reloadSave, saveSave, attack, spawnEnemy, statusLine, battleLog, card, panel, miniSprite,
  reset, hpBar, xpNeed, dataDir,
  // 供 IDE 扩展复用（把 24x24 网格交给 Webview 真彩绘制）
  decodeGrid, shiftGrid, enemyGrid, miniGrid, renderShaded, RARITY_COLOR,
  ENEMY_NAMES, RARITY_LABEL,
}
