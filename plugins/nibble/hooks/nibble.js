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
  ENEMIES, ENEMY_INDEX, ENEMY_TOTAL, TIER_COUNTS, TIER_LABEL, TIER_ORDER, RARITY_MUL,
  enemyMaxHp, pickEnemy, mechSummary,
} = require('./enemies')
// 技能书（50 本）：收集层（掉落 + 技能库 + 4 槽装配）+ 出手层（随机施放与标签结算，见 attack）
const {
  SKILLS, SKILL_INDEX, SKILL_TOTAL, SKILL_RARITY_COUNTS, SKILL_POWER, SKILL_WEIGHT, SKILL_TIER,
  SKILL_DROP_RATE, SKILL_PITY_LIMIT, SKILL_RARITY_DROP, rollSkill,
  TAG_KEYS, TAG_LABEL, TAG_POWER, TAG_DESC, COMBOS,
  emptySlots, normalizeSlots, slotExpect, combosOf, autoSlots, skillSpriteGrid,
  castContext, tagValue, hasCombo,
} = require('./skills')

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
    skills: { owned: {}, pity: 0 }, skillSlots: [null, null, null, null], lastSkillDrop: null,
    streak: { count: 0, lastAt: 0 }, lastDmg: 0,
    // 风险层（第三刀）：玩家血量只在攻击/反击时变化；playerHp 缺省 = 满血
    playerHp: null, playerGuard: null, knockbackAt: 0,
    // 小屋（家园）：装潢套装 + 家具摆放。null = 用前端默认摆法。
    // ⚠️ 只能加可选字段，**绝不能升 v 版本号** —— loadSave 是 `v === 1` 硬门，改版本会清空所有玩家存档。
    home: null,
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

// 解析技能书存档：与 parseArsenal 同策略（未知 id 静默丢弃，旧档缺省 = 0 本）
function parseSkills(a) {
  const out = { owned: {}, pity: 0 }
  if (a && typeof a === 'object') {
    if (a.owned && typeof a.owned === 'object') {
      for (const k of Object.keys(a.owned)) {
        if (SKILL_INDEX[k]) out.owned[k] = Math.max(1, Number(a.owned[k]) || 1)
      }
    }
    out.pity = Math.max(0, Number(a.pity) || 0)
  }
  return out
}

function ensureSkills(s) {
  if (!s.skills) s.skills = parseSkills(null)
  return s.skills
}

// 小屋（家园）：槽位 id 与房间尺寸必须和 media/home-data.js 保持一致。
// 后端不认识家具尺寸，只做「已知槽位 + 落在房间内 + 每个槽位最多一条」这三道校验，
// 真正的重叠判定留在前端 canPlace（它才知道 2×2 / 3×2 这些占地）。
// 房间里的 6 个家具位（布局用）
const HOME_SLOT_IDS = ['bed', 'desk', 'chair', 'lamp', 'rug', 'deco']
// 20 件通用装饰的 id，必须与 media/home-data.js 的 EXTRAS 一致。
const HOME_EXTRA_IDS = [
  'plant', 'books', 'mug', 'globe', 'boxes', 'floorlamp', 'guitar', 'tank', 'catbed', 'coffee',
  'shelf', 'sofa', 'cabinet', 'screen', 'turntable', 'foldingtable',
  'wardrobe', 'bigshelf', 'beanbag', 'cattree',
]
const HOME_EXTRA_MAX = 16
const HOME_PIECE_IDS = HOME_SLOT_IDS.concat(HOME_EXTRA_IDS)
const HOME_COLS = 10
const HOME_ROWS = 8

// —— 物品化模型（2026-10-27 重构）——
// 小屋不是「整屋切换 5 套」，而是 8 个搭配槽位逐件挑。
// 物品 id 形如 'wood_bed' / 'star_floor'：系列 × 槽位。稀有度跟随系列。
const HOME_SKIN_SLOTS = ['floor', 'wall', 'bed', 'desk', 'chair', 'lamp', 'rug', 'deco']
const HOME_SERIES = [
  { id: 'wood', name: '暖木', rarity: 'common' },
  { id: 'study', name: '旧书房', rarity: 'rare' },
  { id: 'moss', name: '苔石', rarity: 'rare' },
  { id: 'neon', name: '霓虹', rarity: 'epic' },
  { id: 'star', name: '星海', rarity: 'legendary' },
]
const HOME_SLOT_NAME = {
  floor: '地板', wall: '墙纸', bed: '床铺', desk: '桌子',
  chair: '椅子', lamp: '灯', rug: '地毯', deco: '摆件',
}
const HOME_EXTRA_NAME = {
  plant: '绿植盆栽', books: '一摞书', mug: '马克杯', globe: '地球仪', boxes: '纸箱堆',
  floorlamp: '落地灯', guitar: '木吉他', tank: '小鱼缸', catbed: '猫窝', coffee: '咖啡机',
  shelf: '书架', sofa: '双人沙发', cabinet: '矮柜', screen: '屏风', turntable: '唱片机柜',
  foldingtable: '折叠桌', wardrobe: '大衣柜', bigshelf: '靠墙大书架', beanbag: '懒人沙发', cattree: '猫爬架',
}
// 槽位物品 id 全集（40 件）+ 装饰（20 件）
const HOME_SKIN_ITEM_IDS = []
for (const s of HOME_SERIES) for (const slot of HOME_SKIN_SLOTS) HOME_SKIN_ITEM_IDS.push(s.id + '_' + slot)
const HOME_ITEM_IDS = HOME_SKIN_ITEM_IDS.concat(HOME_EXTRA_IDS)
const HOME_ITEM_SET = new Set(HOME_ITEM_IDS)
const HOME_ITEM_RARITY = {}
for (const s of HOME_SERIES) {
  for (const slot of HOME_SKIN_SLOTS) HOME_ITEM_RARITY[s.id + '_' + slot] = s.rarity
}
for (const id of HOME_EXTRA_IDS) {
  // 与 home-data.js 的 EXTRAS 稀有度保持一致
  const rare = ['guitar', 'tank', 'catbed', 'coffee', 'sofa', 'cabinet', 'turntable', 'foldingtable']
  if (rare.indexOf(id) >= 0) HOME_ITEM_RARITY[id] = 'rare'
  else if (id === 'cattree') HOME_ITEM_RARITY[id] = 'legendary'
  else if (['shelf', 'screen', 'wardrobe', 'bigshelf', 'beanbag'].indexOf(id) >= 0) HOME_ITEM_RARITY[id] = 'epic'
  else HOME_ITEM_RARITY[id] = 'common'
}
const HOME_RARITY_WEIGHT = { common: 5, rare: 3, epic: 2, legendary: 1 }

// 开局：整套暖木（8 件）+ 6 件普通装饰
function freshHomeOwned() {
  const out = {}
  for (const slot of HOME_SKIN_SLOTS) out['wood_' + slot] = true
  for (const id of HOME_EXTRA_IDS) if (HOME_ITEM_RARITY[id] === 'common') out[id] = true
  return out
}
function freshHomeSkins() {
  const out = {}
  for (const slot of HOME_SKIN_SLOTS) out[slot] = 'wood_' + slot
  return out
}
// 物品 id → 中文名（日志用）
function homeItemName(id) {
  if (HOME_EXTRA_NAME[id]) return HOME_EXTRA_NAME[id]
  const i = id.indexOf('_')
  const sid = id.slice(0, i)
  const slot = id.slice(i + 1)
  const s = HOME_SERIES.find((x) => x.id === sid)
  return (s ? s.name : sid) + '·' + (HOME_SLOT_NAME[slot] || slot)
}
// 保底/掉落概率（2026-10-28 调过：2%/40 只太稀，实测 45 次击杀才出 1 件，玩家会觉得"根本不掉"）
//   5% + 25 只保底 → 平均约 16 次击杀一件，集齐 60 件约需 950 次击杀
const HOME_DROP_RATE = 0.05
const HOME_PITY_LIMIT = 25
// 久别（72 小时没活动）：屋子落灰、小狗趴睡；下次活动时自己醒来并打扫，给一次性小奖励。
// ⚠️ 前端 home-view.js 里有同一个 72h 常量（只用于"进面板时先看到落灰"），改这里要同步改那边。
const HOME_AWAY_MS = 72 * 60 * 60 * 1000

function parseHome(h) {
  const out = { skins: freshHomeSkins(), layout: [], owned: freshHomeOwned(), pity: 0, lastSeen: 0, wake: null }
  if (!h || typeof h !== 'object') return out

  // skins：每个槽位只认自己那 5 个物品（'wood_bed' 只能进 bed 位）
  if (h.skins && typeof h.skins === 'object') {
    for (const slot of HOME_SKIN_SLOTS) {
      const id = String(h.skins[slot] || '')
      if (!HOME_ITEM_SET.has(id)) continue
      if (id.slice(id.lastIndexOf('_') + 1) !== slot) continue
      out.skins[slot] = id
    }
  }

  // owned：只接受已知物品 id
  if (h.owned && typeof h.owned === 'object') {
    for (const k of Object.keys(h.owned)) {
      if (h.owned[k] && HOME_ITEM_SET.has(k)) out.owned[k] = true
    }
  }
  // 开局那批永远视为拥有，避免异常档变成空手
  const base = freshHomeOwned()
  for (const k of Object.keys(base)) out.owned[k] = true

  if (Array.isArray(h.layout)) {
    const seen = {}
    let extras = 0
    for (const it of h.layout) {
      if (!it || typeof it !== 'object') continue
      // key 是新结构；slot 是旧档（6 件套内家具时期）
      const key = String(it.key || it.slot || '')
      if (HOME_PIECE_IDS.indexOf(key) < 0 || seen[key]) continue
      const isExtra = HOME_EXTRA_IDS.indexOf(key) >= 0
      if (isExtra && extras >= HOME_EXTRA_MAX) continue
      const gx = Math.round(Number(it.gx))
      const gy = Math.round(Number(it.gy))
      if (!isFinite(gx) || !isFinite(gy)) continue
      if (gx < 0 || gx >= HOME_COLS || gy < 0 || gy >= HOME_ROWS) continue
      seen[key] = true
      if (isExtra) extras++
      out.layout.push({ key, gx, gy })
    }
  }

  out.pity = Math.max(0, Number(h.pity) || 0)
  // allNotified：家具集齐的提示只写一次日志，避免每杀一只都刷一行
  out.allNotified = !!h.allNotified
  // 久别状态：lastSeen 是"最后一次活动"（每次攻击刷新），wake 是上一次醒来的结算结果
  out.lastSeen = Math.max(0, Number(h.lastSeen) || 0)
  if (h.wake && typeof h.wake === 'object' && Number(h.wake.at) > 0) {
    out.wake = {
      at: Number(h.wake.at),
      hours: Math.max(1, Math.round(Number(h.wake.hours) || 1)),
      item: HOME_ITEM_SET.has(String(h.wake.item)) ? String(h.wake.item) : null,
      // seen：前端播过演出后回写。false 时面板一打开就补播，true 之后不再重复
      seen: !!h.wake.seen,
    }
  }
  return out
}

// 保存小屋。走 reloadSave 是必须的：hooks 与扩展是两个进程，
// 直接用内存缓存会覆盖掉另一侧刚写进去的进度（等级/掉落在同一份 save.json 里）。
//
// ⚠️ 只能覆盖 skins / layout。前端提交的 home 不带 owned / pity，
// 整体替换会把收集进度清零。
function saveHome(h) {
  reloadSave()
  const prev = save.home && typeof save.home === 'object' ? parseHome(save.home) : parseHome(null)
  const next = parseHome(h)
  prev.skins = next.skins
  prev.layout = next.layout
  if (!prev.owned || typeof prev.owned !== 'object') prev.owned = next.owned
  save.home = prev
  saveSave()
  return save.home
}

// 懒初始化：老档 / 只存过布局的档都没有 owned，这里补齐种子
function ensureHome(s) {
  if (!s.home || typeof s.home !== 'object') s.home = parseHome(null)
  if (!s.home.owned || typeof s.home.owned !== 'object') s.home.owned = {}
  const base = freshHomeOwned()
  for (const k of Object.keys(base)) s.home.owned[k] = true
  if (!s.home.skins || typeof s.home.skins !== 'object') s.home.skins = freshHomeSkins()
  if (typeof s.home.pity !== 'number' || s.home.pity < 0) s.home.pity = 0
  if (!Array.isArray(s.home.layout)) s.home.layout = []
  if (typeof s.home.lastSeen !== 'number' || s.home.lastSeen < 0) s.home.lastSeen = 0
  if (!('wake' in s.home)) s.home.wake = null
  if (typeof s.home.allNotified !== 'boolean') s.home.allNotified = false
  return s.home
}

// 调试用：把全部 60 件家具标记为已拥有（不动等级/武器/图鉴等其它进度）。
// 只在本地开发想看全貌时用，命令面板里有入口；正式玩法仍然靠掉落。
function unlockAllHome() {
  const s = reloadSave()
  const home = ensureHome(s)
  for (const id of HOME_ITEM_IDS) home.owned[id] = true
  saveSave()
  return Object.keys(home.owned).length
}

// 反向：把家具进度恢复成开局那 14 件（暖木 8 + 普通装饰 6），搭配回到整套暖木
function resetHomeOwned() {
  const s = reloadSave()
  const home = ensureHome(s)
  home.owned = freshHomeOwned()
  home.skins = freshHomeSkins()
  home.pity = 0
  home.lastSeen = 0
  home.wake = null
  home.allNotified = false
  saveSave()
  return Object.keys(home.owned).length
}

// 家具掉落的独立保底池。单件掉落（40 件槽位物品 + 20 件装饰）：
//   - 只从未拥有的物品里抽，稀有度决定权重
//   - 未出件才累加 pity，出件即清零；集齐后不再产出
function rollFurniture(pity, owned) {
  const cur = Math.max(0, Number(pity) || 0)
  const has = owned && typeof owned === 'object' ? owned : {}
  const pool = HOME_ITEM_IDS.filter((id) => !has[id])
  if (!pool.length) return { item: null, pity: 0, done: true }
  const next = cur + 1
  if (next >= HOME_PITY_LIMIT) {
    return { item: pool[Math.floor(Math.random() * pool.length)], pity: 0, done: false }
  }
  if (Math.random() >= HOME_DROP_RATE) return { item: null, pity: next, done: false }
  let total = 0
  for (const id of pool) total += HOME_RARITY_WEIGHT[HOME_ITEM_RARITY[id]] || 1
  let r = Math.random() * total
  for (const id of pool) {
    r -= HOME_RARITY_WEIGHT[HOME_ITEM_RARITY[id]] || 1
    if (r <= 0) return { item: id, pity: 0, done: false }
  }
  return { item: pool[0], pity: 0, done: false }
}

// 久别回来的"一次性小奖励"：从没拥有的家具里按稀有度加权抽一件。
// 不加货币、不做商店 —— 只补一件家具，和"打扫房间"这件事在语义上是一件事。
function pickAwayGift(owned) {
  const has = owned && typeof owned === 'object' ? owned : {}
  const pool = HOME_ITEM_IDS.filter((id) => !has[id])
  if (!pool.length) return null
  let total = 0
  for (const id of pool) total += HOME_RARITY_WEIGHT[HOME_ITEM_RARITY[id]] || 1
  let r = Math.random() * total
  for (const id of pool) {
    r -= HOME_RARITY_WEIGHT[HOME_ITEM_RARITY[id]] || 1
    if (r <= 0) return id
  }
  return pool[0]
}

// 每次攻击调用一次：刷新 lastSeen；距上次 ≥72h 则结算一次"醒来"（同一段离开只结算一次）
// 返回 wake 事件或 null。纯存档逻辑，不碰渲染。
function touchHomeAway(s, now) {
  const home = ensureHome(s)
  const at = Number(now) || Date.now()
  const last = Number(home.lastSeen) || 0
  home.lastSeen = at
  if (!last) { // 老档 / 新档：先记一笔，不触发事件（否则谁第一次打开都会被判"离开过"）
    home.wake = null
    return null
  }
  const away = at - last
  if (away < HOME_AWAY_MS) return null
  const gift = pickAwayGift(home.owned)
  if (gift) home.owned[gift] = true
  home.wake = { at, hours: Math.max(1, Math.round(away / 3600000)), item: gift || null, seen: false }
  return home.wake
}

// 前端播完"醒来"演出后回写：之后重开面板不再重复播（否则每次启动都来一遍"你回来啦"）
function markWakeSeen(at) {
  const s = reloadSave()
  const home = ensureHome(s)
  if (!home.wake || home.wake.at !== Number(at)) return false
  home.wake.seen = true
  saveSave()
  return true
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
  const bonus = streakBonusOf(count)
  const tier = count >= STREAK_T3 ? 3 : count >= STREAK_T2 ? 2 : count >= STREAK_T1 ? 1 : 0
  return { count, bonus, tier }
}

// 连击加成（只看连击数）：≥10 起 +10%、每连 +1%、封顶 +30%
// 抽成独立函数是因为「连击增幅」标签要按"连击 +N"计算加成（只影响本次，不改计数）
function streakBonusOf(count) {
  const c = Math.max(0, Number(count) || 0)
  return c >= STREAK_T1 ? Math.min(STREAK_T1 + (c - STREAK_T1), STREAK_MAX_BONUS) : 0
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
// streakBonus 可覆盖（「连击增幅」标签按"连击 +N"算加成，见 attack）
function playerAtkWith(s, streakBonus) {
  const base = playerAtk(s.level)
  const w = equippedWeapon(s)
  const power = w ? w.power : 0
  const sk = streakState(s)
  const bonus = typeof streakBonus === 'number' ? streakBonus : sk.bonus
  return {
    base, weapon: w, power,
    streak: sk.count, streakBonus: bonus, streakTier: sk.tier,
    atk: Math.max(1, base * (1 + (power + bonus) / 100)),
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
    enraged: false, // 狂暴（A+ 档）：HP 首次跌破 30% 后持久
    reShieldIn: 0, // 护盾再生的回合计数（护盾被击穿后开始累计）
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
          enraged: !!e.enraged,
          reShieldIn: Math.max(0, Number(e.reShieldIn) || 0),
        }
      }
      // 风险层：玩家血量 / 护盾 / 被击退时间戳（缺省 = 满血、无护盾）
      const php = Number(parsed.playerHp)
      if (isFinite(php) && php > 0) s.playerHp = Math.round(php)
      s.playerGuard = parsed.playerGuard === 'immune' || parsed.playerGuard === 'half' ? parsed.playerGuard : null
      s.knockbackAt = Math.max(0, Number(parsed.knockbackAt) || 0)
      if (typeof parsed.lastLog === 'string') s.lastLog = parsed.lastLog
      if (typeof parsed.logKind === 'string') s.logKind = parsed.logKind
      s.arsenal = parseArsenal(parsed.arsenal)
      s.bestiary = parseBestiary(parsed.bestiary)
      // 技能书：旧档没有 → 0 本、4 空槽（不影响任何既有进度）
      s.skills = parseSkills(parsed.skills)
      s.skillSlots = normalizeSlots(parsed.skillSlots, s.skills.owned)
      if (parsed.lastSkillDrop && typeof parsed.lastSkillDrop === 'object' && SKILL_INDEX[parsed.lastSkillDrop.id]) {
        s.lastSkillDrop = { id: parsed.lastSkillDrop.id, at: Number(parsed.lastSkillDrop.at) || 0 }
      }
      // 技能出手（第五刀·表现）：hooks 进程写盘、扩展进程读盘，**必须原样还原**——
      // 漏了这一条，扩展永远读到 lastCast=undefined，面板就再也没有施放特效（只有官网演示有）。
      if (parsed.lastCast && typeof parsed.lastCast === 'object' &&
        SKILL_INDEX[parsed.lastCast.id] && Number(parsed.lastCast.at) > 0) {
        s.lastCast = parsed.lastCast
      }
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
      // 小屋（家园）：旧档没有 home 字段时也会得到一个「木套已解锁、空布局」的种子，
      // 前端拿到 null 会走默认摆法，但收集进度需要这份种子才能自洽。
      s.home = parseHome(parsed.home)
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

// ============================ 玩家血量与怪物反击（第三刀）============================
// 设计文档：docs/游戏升级规划/11-玩家血量与怪物反击设计.md
// 玩家 HP 是"单场资源"：唯一回复来源是**击杀回满**；归零 = 被击退（换新怪 + 断连击，零实质惩罚）
const playerMaxHp = (lv) => Math.round(30 + Math.max(1, Number(lv) || 1) * 6)

// 反击伤害 = 玩家 maxHp 的百分比 × tier 系数 × 稀有度（等级无关、量级稳定）
// 致死下数 ≈ 20（小怪）/ 28（精英）/ 33（头目），安全边际 ≥1.8×（见 11 文档 4.2）
const COUNTER_R = { common: 0.05, elite: 0.035, boss: 0.03 }
function playerCounter(lv, rarity, tier) {
  const r = COUNTER_R[tier] || COUNTER_R.common
  return Math.max(1, Math.round(playerMaxHp(lv) * r * (RARITY_MUL[rarity] || 1)))
}

// 当前玩家 HP（缺省 / 旧档 / 异常 → 满血；被击退后立即回满，所以 0 不会持久）
function playerHpOf(s) {
  const max = playerMaxHp(s.level)
  const hp = Number(s.playerHp)
  if (!isFinite(hp) || hp <= 0) return max
  return Math.min(max, Math.round(hp))
}

// 玩家受伤：扣血 → 归零则被击退（满血 + 换新怪 + 断连击 + 零惩罚）
// 返回 true 表示被击退（调用方应立即收尾，本场不再给经验/掉落）
function hurtPlayer(s, dmg, info) {
  if (!(dmg > 0)) return false
  s.playerHp = Math.max(0, playerHpOf(s) - dmg)
  if (s.playerHp > 0) return false
  s.streak = { count: 0, lastAt: Date.now() } // 断连击（与超窗断连同口径：静默、无惩罚）
  s.playerHp = playerMaxHp(s.level) // 满血
  s.playerGuard = null
  spawnEnemy(s) // 换一只新怪（旧怪剩余 HP 不保留，避免卡关）
  s.knockbackAt = Date.now()
  s.logKind = 'knockback'
  return true
}

// 敌方反应（玩家攻击结算后，敌人仍在场时）：尖刺 → 反击 → 反震/血偿
// 顺序写死在 11 文档 4.3：**击杀成功不反击**；追击的追加一击不额外触发
function enemyReaction(s, enemy, info, mech, cast, strong) {
  let out = ''
  const maxHp = playerMaxHp(s.level)
  // ① 尖刺：每次受击反弹固定伤害（不吃护盾类减免）
  if (mech.thorns) {
    const before = playerHpOf(s)
    const knocked = hurtPlayer(s, mech.thorns, info)
    out += `　🩸 尖刺反弹 ${Math.min(mech.thorns, before)} HP（HP ${playerHpOf(s)}/${maxHp}）`
    if (knocked) {
      out += `　🛡 Nibble 被${info.name}击退！血量见底，换一只新怪继续`
      return { log: out, knocked: true }
    }
  }
  // ② 反击：按 maxHp 百分比；狂暴 ×1.5；玩家侧护盾在这里消费（护盾标签 / 续航组合留下的）
  let dmg = playerCounter(s.level, enemy.rarity, info.tier)
  if (mech.enrage && enemy.enraged) dmg = Math.round(dmg * 1.5)
  const guard = s.playerGuard || null
  s.playerGuard = null
  if (guard === 'immune') dmg = 0
  else if (guard === 'half') dmg = Math.round(dmg * 0.5)
  if (hasCombo(cast.combos, 'iron_wall')) dmg = Math.round(dmg * 0.75) // 铁壁：反击再 -25%
  if (dmg <= 0) {
    out += `　🛡 护盾挡下反击（HP ${playerHpOf(s)}/${maxHp}）`
    return { log: out, knocked: false }
  }
  const before = playerHpOf(s)
  const knocked = hurtPlayer(s, dmg, info)
  out += `　⚔ ${info.name} 反击！Nibble -${Math.min(dmg, before)} HP（HP ${playerHpOf(s)}/${maxHp}）`
  if (knocked) {
    out += `　🛡 Nibble 被${info.name}击退！血量见底，换一只新怪继续`
    return { log: out, knocked: true }
  }
  // ③ 反震：把吃到的伤害按比例反弹（以牙还牙 +25%；血偿把反弹的一半回血）
  let reflectBack = 0
  if (cast.tags.reflect) {
    // 一次算完再取整：分两步 round 会把 1.5→2 再 ×1.25→3，凭空多出 1 点
    let back = Math.round(dmg * (tagValue('reflect', strong) / 100) * (hasCombo(cast.combos, 'eye_for_eye') ? 1.25 : 1))
    if (back > 0) {
      enemy.hp = Math.max(0, enemy.hp - back)
      reflectBack = back // 表现层用（技能特效的"反震"回弹）
      out += `　↩ 反震 ${back}`
      if (hasCombo(cast.combos, 'blood_debt')) {
        const heal = Math.min(Math.round(back * 0.5), maxHp - playerHpOf(s))
        if (heal > 0) {
          s.playerHp = playerHpOf(s) + heal
          out += `（血偿 +${heal}）`
        }
      }
    }
  }
  return { log: out, knocked: false, reflect: reflectBack }
}

// 一次攻击：应用怪物机制（闪避/护盾/护甲/自愈/分裂）+ 技能出手 + 怪物反击 → 返回一行战斗日志
// 外层 attack() 包着它：先结算久别回来，再把那行"醒来"日志拼到战斗日志前面。
function attackInner(s) {
  const enemy = s.enemy
  const info = enemyInfo(enemy.type)
  const mech = info.mech
  // 表现层（第五刀·施放管线）要的"出手前快照"：命中前的两帧里，面板冻结显示这些旧值
  const hpBefore = enemy.hp
  const maxHpBefore = enemy.maxHp
  const playerHpBefore = playerHpOf(s)
  // 连击：本次攻击先计入，再按新连击结算（≥10 起才有加成与文案）
  bumpStreak(s)
  const sk = streakState(s)
  const tag = streakTag(sk)
  // 出手（第二刀）：4 槽按权重随机抽 1 本；空槽 = 普攻（倍率 1.00）
  // 设计文档：docs/游戏升级规划/10-技能书与技能库设计.md（第三、四节）
  const cast = castContext(s.skillSlots)
  const strong = cast.strong
  const has = (id) => hasCombo(cast.combos, id)
  // 连击加成：连击增幅标签按"连击 +N"计算（只影响本次加成，不改计数）；气势组合再 +3%
  let streakBonus = sk.bonus
  if (cast.tags.surge) streakBonus = streakBonusOf(sk.count + tagValue('surge', strong))
  if (has('momentum')) streakBonus += 3
  const atk = playerAtkWith(s, streakBonus).atk // 等级基础 ×（1 + 武器战力% + 连击加成%）
  s.battles += 1

  // 伤害 = atk × 技能倍率 × 稀有度共鸣 × 必暴 × 致命组合；波动仍按比例（±10%）
  const crit = !!cast.tags.crit
  const critMul = crit ? tagValue('crit', strong) : 1
  let mul = cast.power * cast.resonance * critMul
  if (crit && has('lethal')) mul *= 1.1
  let dmg = Math.max(1, Math.round(atk * mul * (0.9 + Math.random() * 0.2)))
  const notes = []
  const pierce = !!cast.tags.pierce
  const rend = !!cast.tags.rend
  const aimStrong = !!cast.tags.aim && strong
  // 表现层（第四刀·特效）要的"实际生效结果"：破甲削了几层、吸血回了多少
  let rendCut = 0
  let castHeal = 0
  if (!cast.tags.aim && mech.dodge && Math.random() < mech.dodge) {
    dmg = 0
    notes.push('闪避')
  } else {
    // 护盾格挡：贯穿 / 精准（强档）无视减半并消耗 1 层；粉碎组合把护盾直接清零
    if (enemy.shieldLeft > 0) {
      if (pierce || aimStrong) {
        if (pierce && has('shatter')) {
          enemy.shieldLeft = 0
          notes.push('粉碎')
        } else {
          enemy.shieldLeft -= 1
          notes.push(pierce ? '贯穿' : '无视格挡')
        }
      } else {
        dmg = Math.max(1, Math.round(dmg / 2))
        enemy.shieldLeft -= 1
        notes.push('护盾格挡')
      }
    }
    // 破甲：永久削护盾层
    if (rend && enemy.shieldLeft > 0) {
      const cut = Math.min(enemy.shieldLeft, tagValue('rend', strong))
      enemy.shieldLeft -= cut
      rendCut = cut
      notes.push('破甲 -' + cut + ' 盾')
    }
    // 护甲：贯穿 / 破甲 / 破防重击（暴击时）无视
    const ignoreArmor = pierce || rend || (crit && has('armor_break'))
    if (mech.armor) {
      if (ignoreArmor) {
        notes.push('无视护甲')
      } else {
        const before = dmg
        dmg = Math.max(1, dmg - mech.armor)
        if (dmg < before) notes.push(`护甲 ${mech.armor}`)
      }
    }
    if (crit) notes.push('暴击 ×' + critMul)
  }
  enemy.hp = Math.max(0, enemy.hp - dmg)
  let total = dmg

  // 追击：追加一击（不吃减伤、不再抽签、不触发反击）；重影吃暴击倍率、锁影再 +25%
  if (cast.tags.chase && dmg > 0 && enemy.hp > 0) {
    let ratio = tagValue('chase', strong)
    if (crit && has('afterimage')) ratio *= critMul
    let extra = Math.max(1, Math.round(dmg * ratio))
    if (has('lock_on')) extra = Math.max(1, Math.round(extra * 1.25))
    enemy.hp = Math.max(0, enemy.hp - extra)
    total += extra
    notes.push('追击 +' + extra)
  }
  // 组合：暴走（暴击）/ 连环（追击）额外 +1 连击计数 —— 只奖励连续，不惩罚
  let comboStreak = 0
  if (crit && has('rampage')) comboStreak += 1
  if (cast.tags.chase && has('chain')) comboStreak += 1
  if (comboStreak) s.streak.count = (Number(s.streak.count) || 0) + comboStreak

  // —— 玩家侧结算（第三刀）——
  // 护盾标签：为"下一次反击"挂上减伤（本回合被反击则当回合消费；没被反击就留到下次）
  if (cast.tags.guard) s.playerGuard = strong ? 'immune' : 'half'
  // 回复标签：本次伤害的一部分转回自身 HP；（续航组合）满血时转成一格护盾
  if (cast.tags.leech && total > 0) {
    const maxHp = playerMaxHp(s.level)
    const cur = playerHpOf(s)
    if (cur >= maxHp && hasCombo(cast.combos, 'sustain')) {
      if (!s.playerGuard) s.playerGuard = 'half'
      notes.push('回复→护盾')
    } else {
      const heal = Math.min(Math.round((total * tagValue('leech', strong)) / 100), maxHp - cur)
      if (heal > 0) {
        s.playerHp = cur + heal
        castHeal = heal
        notes.push('回复 +' + heal)
      }
    }
  }
  // 狂暴：HP 首次跌破 30% → 进入狂暴（持久），反击 ×1.5
  if (mech.enrage && !enemy.enraged && enemy.hp > 0 && enemy.hp <= Math.round(enemy.maxHp * 0.3)) {
    enemy.enraged = true
    notes.push('狂暴')
  }

  // 表现层（第四刀·技能特效）：把"这一击抽到哪本、标签实际生效了什么"记进存档，
  // 由扩展 tick 边缘检测推 type:'cast'（at 去重，与 lastDrop 同范式）。普攻写 null → 不推特效。
  // ⚠️ 只记录既有结算结果，不新增任何战斗状态、不改数值。
  s.lastCast = cast.book ? {
    id: cast.book.id,
    name: cast.book.name,
    rarity: cast.book.rarity,
    tag: cast.book.tag,
    tier: cast.tier, // 演出档：1 轻（普通）/ 2 中（稀有）/ 3 重（史诗·传说）
    slot: cast.slot, // 抽中的槽位（0~3），面板据此高亮那一格
    form: cast.book.form || '', // 招式原语（第五刀·表现）：12 选 1，逐本指派
    enemyType: enemy.type, // 被攻击的那只（击杀后存档里已换成新怪，表现层要用旧的那只）
    enemyRarity: enemy.rarity,
    power: cast.power,
    combos: cast.combos.map((c) => c.id),
    // 出手前快照：命中帧之前，面板冻结显示这些旧值（"先出特效、再打击"）
    hpBefore,
    maxHpBefore,
    playerHpBefore,
    killed: false, // 由击败分支回填
    countered: enemy.hp > 0, // 未死 → 本次会走怪物反应（反击/尖刺/反震）
    dmg: total,
    hit: dmg > 0,
    crit: crit && dmg > 0,
    pierce,
    aim: aimStrong,
    rend: rendCut,
    chase: !!cast.tags.chase && total > dmg,
    guard: cast.tags.guard ? s.playerGuard : null,
    leech: !!cast.tags.leech,
    surge: !!cast.tags.surge,
    heal: castHeal,
    reflect: 0, // 反震发生在反击之后，由敌方反应的返回值补
    at: Date.now(),
  } : null

  const note = notes.length ? `（${notes.join('·')}）` : ''
  s.lastDmg = total // 面板伤害飘字用（0 = 未命中，飘字跳过）
  const castName = cast.book ? `用「${cast.book.name}」` : ''
  let log = `Nibble ${castName}攻击！${info.name} -${total} HP${note}${tag}`

  // 未死：结算自愈 → 敌方反应（尖刺/反击/反震）
  if (enemy.hp > 0) {
    if (mech.regen) {
      const healed = Math.min(mech.regen, enemy.maxHp - enemy.hp)
      if (healed > 0) {
        enemy.hp += healed
        log += `　💚 ${info.name} 自愈 +${healed} HP`
      }
    }
    const r = enemyReaction(s, enemy, info, mech, cast, strong)
    log += r.log
    if (s.lastCast && r.reflect) s.lastCast.reflect = r.reflect // 特效层：反震回弹
    if (r.knocked) {
      s.lastLog = log // logKind 由 hurtPlayer 置为 knockback
      return log
    }
    // 护盾再生：**只有本来就有护盾的怪**才谈得上"再生"（否则等于凭空造盾，头目会被拖成两倍时长）；
    // 恢复上限 = 开场层数（mech.shield），不能越攒越多
    if (mech.reShield && mech.shield && enemy.shieldLeft === 0 && enemy.hp > 0) {
      enemy.reShieldIn = (Number(enemy.reShieldIn) || 0) + 1
      if (enemy.reShieldIn >= mech.reShield) {
        enemy.shieldLeft = Math.min(mech.shield, enemy.shieldLeft + 1)
        enemy.reShieldIn = 0
        log += '　🔁 护盾再生 +1'
      }
    }
    // ⚠️ 必须在此收尾：漏下去就会走到击败分支（曾因此把每次攻击都判成击杀）
    s.logKind = 'attack'
    s.lastLog = log
    return log
  }

  // 首次归零且带分裂：原地分裂成两只 50% HP 个体（整场只触发一次）；分裂不算击败 → 仍会反击
  if (enemy.hp <= 0 && mech.split && !enemy.splitDone) {
    enemy.splitDone = true
    const childHp = Math.max(1, Math.round(enemy.maxHp * 0.5))
    enemy.maxHp = childHp
    enemy.hp = childHp
    enemy.shieldLeft = 0
    log += `　🧬 ${info.name} 受创分裂！重置为 ${childHp} HP（分裂体 ×2）`
    if (s.lastCast) s.lastCast.countered = true // 分裂体同样会反击 → 演出管线要留"反击帧"
    const r2 = enemyReaction(s, enemy, info, mech, cast, strong)
    log += r2.log
    if (s.lastCast && r2.reflect) s.lastCast.reflect = r2.reflect
    if (r2.knocked) {
      s.lastLog = log
      return log
    }
    s.logKind = 'attack'
    s.lastLog = log
    return log
  }

  // 击败：记怪物库 + 掉武器 + 刷新新怪（**击杀成功不反击**，玩家血量回满）
  enemy.hp = 0
  s.defeats += 1
  if (s.lastCast) s.lastCast.killed = true // 表现层：命中帧之后才允许播"消散 + 掉落"
  s.playerHp = playerMaxHp(s.level) // 击杀回满：玩家 HP 的唯一回复来源
  s.playerGuard = null
  const b = ensureBestiary(s)
  const firstTime = !b.defeated[enemy.type]
  markDefeated(s, enemy.type)
  const gain = 6 + Math.round(enemy.maxHp * 0.6)
  const ups = gainExp(s, gain)
  log = `击败 **${info.name}**（${info.tierLabel}·${RARITY_LABEL[enemy.rarity]}）！${tag}`
  log += firstTime ? '🆕 收录进怪物库' : `怪物库 ×${b.defeated[enemy.type]}`
  log += ` +${gain}XP`
  if (ups > 0) log += `　⬆ 升级 Lv ${s.level}！`
  if (!s.arsenal) s.arsenal = parseArsenal(null)
  const drop = rollWeapon(s.arsenal.pity, s.arsenal.owned)
  s.arsenal.pity = drop.pity
  // ≥25 连「燃」：掉落保底额外推进 1 步（加速保底，不改变单次掉落概率）
  if (sk.tier >= 2) s.arsenal.pity = Math.min(PITY_LIMIT, s.arsenal.pity + 1)
  if (drop.weapon) {
    s.arsenal.owned[drop.weapon.id] = (s.arsenal.owned[drop.weapon.id] || 0) + 1
    s.lastDrop = { id: drop.weapon.id, at: Date.now() }
    log += `　✦ 获得 ${RARITY_LABEL[drop.weapon.rarity]}·${drop.weapon.name}！`
  }
  // 技能书：独立池（10% 掷 / 保底 20 只怪），不影响武器掉落、经验与连击
  const books = ensureSkills(s)
  const firstBook = Object.keys(books.owned).length === 0
  const sdrop = rollSkill(books.pity)
  books.pity = sdrop.pity
  if (sdrop.skill) {
    books.owned[sdrop.skill.id] = (books.owned[sdrop.skill.id] || 0) + 1
    s.lastSkillDrop = { id: sdrop.skill.id, at: Date.now() }
    log += `　📖 获得 ${RARITY_LABEL[sdrop.skill.rarity]}·${sdrop.skill.name}！`
    if (firstBook) log += '　（首次获得技能书：去「技能书」页装配最多 4 本，出手时随机施放）'
  }
  // 家具（第三池）：2% 掷 / 保底 40 只。独立 pity、只出未拥有的整套，
  // 不弹第二条 toast（同一时刻已经有武器横幅了），只在战斗日志里记一行。
  const home = ensureHome(s)
  const fdrop = rollFurniture(home.pity, home.owned)
  home.pity = fdrop.pity
  if (fdrop.item) {
    home.owned[fdrop.item] = true
    home.allNotified = false
    log += `　🛋 获得家具「${homeItemName(fdrop.item)}」！`
  } else if (fdrop.done && !home.allNotified) {
    // 池子空了（60 件全拥有）时给一次明确提示：否则"打了半天什么都不掉"会被当成 bug
    home.allNotified = true
    log += `　🛋 家具已集齐（${HOME_ITEM_IDS.length}/${HOME_ITEM_IDS.length}），不再掉落`
  }
  spawnEnemy(s)
  const next = enemyInfo(s.enemy.type)
  log += `　新的野生 ${next.name}（${next.tierLabel}·${RARITY_LABEL[s.enemy.rarity]}）出现`
  s.logKind = ups > 0 ? 'levelup' : 'victory'
  s.lastLog = log
  return log
}

// 对外的一次攻击：先结算"离开 ≥72 小时"的醒来事件，再把那行日志拼在战斗日志前面。
// 拆成包装层的理由：attackInner 有 5 个 return 点（闪避/反击/击退/分裂/击杀），
// 逐处插日志必漏；包装层只管一次，逻辑不会被战斗分支污染。
function attack(s) {
  const wake = touchHomeAway(s, Date.now())
  const log = attackInner(s)
  if (!wake) return log
  const head = wake.item
    ? `🌙 你离开了 ${wake.hours} 小时：它把屋子打扫干净，还从角落里翻出「${homeItemName(wake.item)}」`
    : `🌙 你离开了 ${wake.hours} 小时：它把屋子打扫干净了`
  const full = `${head}　${log}`
  s.lastLog = full
  return full
}

// HP 条：默认画敌人（向后兼容）；who = 'player' 时画玩家（第三刀）
function hpBar(s, total, who) {
  const n = total || 10
  const isPlayer = who === 'player'
  const cur = isPlayer ? playerHpOf(s) : s.enemy.hp
  const max = isPlayer ? playerMaxHp(s.level) : s.enemy.maxHp
  const ratio = Math.max(0, cur) / Math.max(1, max)
  const filled = Math.round(ratio * n)
  return { bar: '█'.repeat(filled) + '░'.repeat(n - filled), num: `${cur}/${max}`, ratio }
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
  const hp = hpBar(s, 10, 'player') // 第三刀：这条 HP 归玩家（敌人血量在卡片/面板里看）
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
  const color = { attack: '#FF6B6B', victory: '#4ECDC4', levelup: '#FFD700', knockback: '#FF9F45' }[s.logKind] || '#4ECDC4'
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
  const php = hpBar(s, 10, 'player')
  const sum = arsenalSummary(s)
  const best = bestiarySummary(s)
  const info = enemyInfo(s.enemy.type)
  const mech = info.mechText ? ` · ${info.mechText}` : ''
  return [
    '```',
    ...rows,
    '```',
    `🛡 Nibble HP [${php.bar}] ${php.num}${s.playerGuard ? '　（护盾已就绪）' : ''}`,
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
  const php = hpBar(s, 10, 'player')
  const info = enemyInfo(s.enemy.type)
  return [
    `${miniSprite('player')}  ⚔  ${miniSprite(s.enemy.type, s.enemy.rarity)}   Lv${s.level}  HP [${php.bar}] ${php.num}  ${info.name}（${info.tierLabel}·${RARITY_LABEL[s.enemy.rarity]}）[${hp.bar}] ${hp.num}`,
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

// 技能书汇总（供状态栏 tooltip / 面板 / 扩展使用）
// 槽位规则：4 槽、必须 4 本不同的书、全手动（不自动替换）；expect 与 combos 只用于展示
function skillSummary(s) {
  const bk = (s && s.skills) || { owned: {}, pity: 0 }
  const slots = normalizeSlots((s && s.skillSlots) || [], bk.owned)
  const ld = s && s.lastSkillDrop && SKILL_INDEX[s.lastSkillDrop.id] ? SKILL_INDEX[s.lastSkillDrop.id] : null
  const combos = combosOf(slots)
  const filled = slots.filter(Boolean).length
  return {
    owned: Object.keys(bk.owned).length,
    total: SKILL_TOTAL,
    pity: bk.pity,
    pityLimit: SKILL_PITY_LIMIT,
    ownedMap: bk.owned,
    slots,
    filled,
    expect: slotExpect(slots),
    combos: combos.map((c) => ({ id: c.id, name: c.name, desc: c.desc })),
    // 首次引导：拿到了书但一本都没上阵 → 面板把技能页入口点亮
    guide: Object.keys(bk.owned).length > 0 && filled === 0,
    last: ld ? { id: ld.id, name: ld.name, rarity: ld.rarity, tag: ld.tag, tagLabel: ld.tagLabel, story: ld.story || '', at: (s.lastSkillDrop && s.lastSkillDrop.at) || 0 } : null,
  }
}

// 装配 / 卸下：id 为 null → 清空该槽；未拥有的书忽略
// 同一本只能占一个槽（先把它从别的槽摘掉，再写入目标槽）
function equipSkill(id, slot) {
  const s = loadSave()
  const bk = ensureSkills(s)
  const i = Math.max(0, Math.min(3, Number(slot) || 0))
  if (!s.skillSlots) s.skillSlots = emptySlots()
  if (!id || !SKILL_INDEX[id] || !bk.owned[id]) {
    s.skillSlots[i] = null
  } else {
    for (let k = 0; k < 4; k++) if (s.skillSlots[k] === id) s.skillSlots[k] = null
    s.skillSlots[i] = id
  }
  s.skillSlots = normalizeSlots(s.skillSlots, bk.owned)
  saveSave()
  return s.skillSlots
}

// 一键推荐上阵（面板按钮用；只挑期望最高的一组，不改收集与保底）
function autoEquipSkills() {
  const s = loadSave()
  const bk = ensureSkills(s)
  s.skillSlots = autoSlots(bk.owned)
  saveSave()
  return s.skillSlots
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
  return '♻️ 已重置等级/经验/战绩/武器库/技能书/怪物库与当前敌人'
}

module.exports = {
  loadSave, reloadSave, saveSave, attack, spawnEnemy, statusLine, battleLog, card, panel, miniSprite,
  reset, hpBar, xpNeed, dataDir, arsenalCard, arsenalSummary, equippedWeapon, equipWeapon,
  // 技能书（第一刀：收集 + 装配；出手在第二刀接入）
  skillSummary, equipSkill, autoEquipSkills, SKILLS, SKILL_INDEX, SKILL_TOTAL, SKILL_RARITY_COUNTS,
  SKILL_POWER, SKILL_WEIGHT, SKILL_TIER, SKILL_DROP_RATE, SKILL_PITY_LIMIT, SKILL_RARITY_DROP, rollSkill,
  TAG_KEYS, TAG_LABEL, TAG_POWER, TAG_DESC, COMBOS, slotExpect, combosOf, autoSlots, skillSpriteGrid,
  // 风险层（第三刀）：玩家血量与怪物反击
  playerMaxHp, playerCounter, playerHpOf, COUNTER_R,
  playerAtk, playerAtkWith,
  // 连击：状态查询 + 档位常量（IDE 扩展比较档位跨越来触发超载演出）
  streakState, streakTag,
  STREAK_WINDOW, STREAK_T1, STREAK_T2, STREAK_T3, STREAK_MAX_BONUS,
  bestiaryCard, bestiarySummary, enemyInfo,
  // 供 IDE 扩展复用（把 24x24 网格交给 Webview 真彩绘制）
  decodeGrid, shiftGrid, enemyGrid, miniGrid, renderShaded, RARITY_COLOR,
  ENEMY_NAMES, RARITY_LABEL,
  // 小屋（家园）：逐槽位搭配 + 家具摆放 + 单件掉落池
  saveHome, parseHome, ensureHome, rollFurniture, homeItemName, unlockAllHome, resetHomeOwned,
  HOME_SLOT_IDS, HOME_EXTRA_IDS, HOME_EXTRA_MAX, HOME_SKIN_SLOTS, HOME_SERIES,
  HOME_ITEM_IDS, HOME_ITEM_RARITY, HOME_DROP_RATE, HOME_PITY_LIMIT,
  // 久别回来：72h 判定 + 一次性家具奖励（纯存档逻辑，可单测）
  HOME_AWAY_MS, pickAwayGift, touchHomeAway, markWakeSeen,
  // 武器库（纯收集）：数据 + 掉落 + 素材
  WEAPONS, WEAPON_INDEX, WEAPON_TOTAL, RARITY_COUNTS, PITY_LIMIT, rollWeapon, weaponSpriteGrid,
  WEAPON_POWER, bestOwnedWeapon,
  // 怪物库（40 只「编程 Bug」怪物）：数据 + 数值 + 机制
  ENEMIES, ENEMY_INDEX, ENEMY_TOTAL, TIER_COUNTS, TIER_LABEL, TIER_ORDER, mechSummary, enemyMaxHp, pickEnemy,
}
