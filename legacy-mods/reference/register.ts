// @ts-nocheck
// register.ts — 模仿 Nibble 玩法的陪伴小生物 Mod（v0.4：Raster 真彩像素 + AI 原创素材 + Roguelite 持久化）
//
// 视觉语言参照 nibble.dev 的设计原则（深色底 + 青色玩家 / 橙色野生 / 红色攻击），
// 但像素素材为 AI 生成的**原创**像素画（版权干净，见 CREDITS.md），不复制 Nibble 或任何第三方素材。
//
// 渲染方案（对应 24x24 像素 ≈12 行窄带）：
//   - 终端（e.surface === 'terminal' 且运行时提供 Raster）：用 Raster 逐格绘制，
//     每格 = 字符码点 + 前景 24bit RGB + 背景 24bit RGB；字符用半方块 ▀（U+2580），
//     前景=上像素、背景=下像素 → 一格装 2 个像素，24x24 只占 12 文本行，真彩色无损。
//   - 非终端 / 无 Raster（如桌面端）：降级为方块字符 █（隔行采样 12 行），仍可辨识。
//   - 打包严格按官方示例：new Uint8Array(Uint32Array.from(numbers).buffer) → base64。
//
// 核心玩法（Roguelite 成长 + 跨会话持久化）：
//   - AbovePrompt 窄带：玩家像素小生物 ⚔ 野生敌人（Raster 并排）+ HP 条 + 单行战斗日志；
//   - 空闲时玩家播放 2 帧待机（上下浮动），攻击时前冲 2px；
//   - 每次你向 CodeBuddy 提问（prompt.submit 节拍）→ 攻击一次，野生 HP 减少；
//   - 野生 HP 归零 → 击败/捕获日志（+XP）→ 像素消散 → 刷新更硬的下一只；
//   - 成长：伤害随等级提升，击败获得经验，经验满升级；敌人 HP 与稀有度随等级提升；
//   - 持久化：等级/经验/战绩/当前敌人写入 $.store（跨会话恢复），/nibble reset 可重置；
//   - 敌人稀有度：common 原色 / rare 闪烁白色亮点像素 / epic 品红染色 / legendary 金色染色。
//
// 约束（严格遵守）：
//   - 只监听 prompt.submit 作为攻击节拍；绝不读取 payload、文件、路径、提示词、代码；
//   - 不挂 tool.call，不消耗 token，不开独立 Pane，不抢输入焦点；
//   - 运行时零第三方依赖（pngjs 仅构建期转换素材用，见 tools/png2grid.mjs）；
//   - 轻量：空闲动画用轻量 timer，session.end 时清理。

// ============================ 像素数据（构建期自动生成，请勿手改）============================
// 由 tools/png2grid.mjs 从 assets/*.png 转换而来：palette 为 24bit hex，rows 每字符是一个
// base36 调色板索引，'.' 为透空。重跑 `npm run pixels` 可更新。
const PIXEL_DATA = {
  player: {
    palette: ["#40F0E0","#40F0F0","#101040","#106060","#40C0B0","#102050","#30C0B0","#102040","#B0F0F0","#40D0C0","#30C0C0","#106050","#40D0B0","#50F0E0","#101050","#30D0C0","#F0E0E0","#107060","#C0F0F0","#207070","#107070","#202050","#30F0E0"],
    rows: ["........................","........................",".........777722.........",".......771111112........","......70881111112.......",".....7088111110092g.....","....2d8811100000092g....","...20id8000000000092....","...280000000000000092...","..2800b30000000b300042..","..2803.j3000003.k30042..",".e00033h30000033h30006e.",".e000344b00000344b00062.",".2000133000000033000062.",".20000110b0003000099062.",".200001001b3300000cc062.","..2400000011100004cc05..","..2640000010000444cdc5..","...260000000046666d9l...","....26m0000000000095....",".....27aaaaaaafff77.....",".......5555555555.......","........................","........................"],
  },
  bat: {
    palette: ["#202020","#302030","#7050A0","#604090","#7040A0","#9070B0","#D0B0F0","#9060B0","#604080","#302020","#503070","#504070","#C0A0E0","#403050","#8060B0","#302040","#503060","#6040A0","#504080","#C0B0F0","#403060","#505050","#A080C0","#B090D0","#705090","#8060A0","#8050A0","#C0B0E0"],
    rows: ["........................","........................","........................","........................","......000......120......","......0k29....1220......","......36620..l0d63......","......066g0eeea663......","......0m63422446n0......",".......0334224440.......",".......03f4224f30.......","....12103dfh4od30090....","..111bb0342113430bba19..",".12p558004421h3a1i55520.",".1155q7g0014a3018585570.",".1177557312664887575510.","...9895702j66j4177531...","...90.0002rccc2000.00...","........0i31c830........","........031..110........","........................","........................","........................","........................"],
  },
  slime: {
    palette: ["#F08010","#904000","#000000","#D06010","#A04000","#E06010","#803000","#E07010","#903000","#F07010","#F09040","#F0A040","#F09030","#702010","#F0F0E0","#703030","#702000","#703020","#F0E0E0","#802010","#E07020"],
    rows: ["........................","........................","........................","......111144444411......",".....d170000000033e.....","....f170a0000000008g....","...819baa00000000006h...","...11cb00000000000036...","...109900000000000008i..","...150022200002220008...","..15002b222000cc220051..",".4100022222000222200016.",".1100022220000222200056.",".1000000200000022000051.",".1000000000670000000051.",".1000000000000000000951.",".1330000000000000000331.",".j633300000000000033311.","...113110000000071511...","....11111111111k1141....","........................","........................","........................","........................"],
  },
  mimic: {
    palette: ["#302020","#604020","#704020","#905030","#B07040","#906030","#805020","#503020","#403020","#F0F0D0","#E0D0A0","#805030","#402020","#605040","#202020","#A06040","#706040","#603020","#905020","#806050","#201010","#907050","#604030","#F0F0C0","#A06030","#503010","#604010","#F0D0A0","#D0C090","#B09060","#C0A070","#504030","#603010","#705030","#301010","#804020"],
    rows: ["........................","....0000000000000000....","...c055dj344444552jx0...","..k22114475333gl552myk..",".02216214gp113ddj11pg0..",".01c2z212444441d8744450.",".e1222226000000m1100000.",".e12h22i019s0q100011220.",".1112260100090l9990220..",".e1126011re0e00980020...",".01160111a90s0r90s00....",".011000011000110000.....","..0100s50122211120000...","..0000aaa0000tt0uu09000.","..0v8100asnn9aannaa9000.","..0081120bb333555555oo0.","..018128m414440lll337b0.","..0181180d73330gv077760.","..08811c0d7111700i33760.","..0h18qc167ii3365337760.","..00w11c167whh5556off40.","....00111fffbbb66666000.","......00000000000000k...","........................"],
  },
}

// ============================ 网格解码 / 变换（模块级缓存）============================
const GRID_CACHE = new Map()
const TINT_CACHE = new Map()
const BLANK_GRID = Array.from({ length: 24 }, () => Array(24).fill(null))

function decodeGrid(name) {
  if (GRID_CACHE.has(name)) return GRID_CACHE.get(name)
  const { palette, rows } = PIXEL_DATA[name]
  const grid = rows.map((row) =>
    [...row].map((ch) => (ch === '.' ? null : palette[parseInt(ch, 36)] || null)),
  )
  // 闪烁亮点位：自上而下第一行有内容的中间像素（稀有/传说闪烁用）
  let spark = null
  for (let r = 0; r < grid.length && !spark; r++) {
    const cols = grid[r].map((c, i) => (c ? i : -1)).filter((i) => i >= 0)
    if (cols.length) spark = { r, c: cols[Math.floor(cols.length / 2)] }
  }
  const val = { grid, spark }
  GRID_CACHE.set(name, val)
  return val
}

// 平移网格（dx 右移 / dy 下移），越界置透空 —— 用于待机浮动与攻击前冲
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

const _h2 = (v) => v.toString(16).padStart(2, '0').toUpperCase()
function tintGrid(grid, hexColor, strength) {
  const tr = parseInt(hexColor.slice(1, 3), 16)
  const tg = parseInt(hexColor.slice(3, 5), 16)
  const tb = parseInt(hexColor.slice(5, 7), 16)
  return grid.map((row) =>
    row.map((c) => {
      if (!c) return c
      const or = parseInt(c.slice(1, 3), 16)
      const og = parseInt(c.slice(3, 5), 16)
      const ob = parseInt(c.slice(5, 7), 16)
      const r = Math.round(or * (1 - strength) + tr * strength)
      const g = Math.round(og * (1 - strength) + tg * strength)
      const b = Math.round(ob * (1 - strength) + tb * strength)
      return '#' + _h2(r) + _h2(g) + _h2(b)
    }),
  )
}

// 敌人网格：按稀有度着色 + 闪烁亮点
function enemyGrid(name, rarity, blink) {
  const base = decodeGrid(name)
  let g = base.grid
  if (rarity === 'epic') {
    const key = name + '|epic'
    if (!TINT_CACHE.has(key)) TINT_CACHE.set(key, tintGrid(g, '#E040E0', 0.35))
    g = TINT_CACHE.get(key)
  } else if (rarity === 'legendary') {
    const key = name + '|legendary'
    if (!TINT_CACHE.has(key)) TINT_CACHE.set(key, tintGrid(g, '#FFD700', 0.55))
    g = TINT_CACHE.get(key)
  }
  if (blink && base.spark) {
    g = g.map((row) => row.slice())
    g[base.spark.r][base.spark.c] = '#FFFFFF'
  }
  return g
}

// ============================ 渲染：Raster（终端）+ 方块字符降级 ============================
const DEFAULT_COLOR = 0x01000000 // 官方约定的“终端默认色”（用于透空）
const HALF_UP = 0x2580 // ▀ 上半方块：前景=上像素，背景=下像素 → 一格 2 像素
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes) {
  let s = ''
  const n = bytes.length
  let i = 0
  for (; i + 3 <= n; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
    s += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[((b1 & 15) << 2) | (b2 >> 6)] + B64[b2 & 63]
  }
  const rem = n - i
  if (rem === 1) {
    const b0 = bytes[i]
    s += B64[b0 >> 2] + B64[(b0 & 3) << 4] + '=='
  } else if (rem === 2) {
    const b0 = bytes[i], b1 = bytes[i + 1]
    s += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[(b1 & 15) << 2] + '='
  }
  return s
}

const rgb = (h) => parseInt(h.slice(1), 16)

// 24x24 网格 → Raster cells（24 列 × 12 行，每格 ▀：fg=上像素 bg=下像素）
function rasterElement(Raster, grid, key) {
  const numbers = []
  for (let r = 0; r < 24; r += 2) {
    for (let c = 0; c < 24; c++) {
      const top = grid[r][c]
      const bot = grid[r + 1][c]
      numbers.push(HALF_UP, top ? rgb(top) : DEFAULT_COLOR, bot ? rgb(bot) : DEFAULT_COLOR)
    }
  }
  const cells = toBase64(new Uint8Array(Uint32Array.from(numbers).buffer))
  return Raster({ key, columns: 24, rows: 12, cells })
}

// 降级：非终端 / 无 Raster 时，隔行采样成 12 行方块字符（多色分段 Text）
function textSprite(Box, Text, grid, keyPrefix) {
  const rows = []
  for (let r = 0; r < 24; r += 2) {
    const segs = []
    for (let c = 0; c < 24; c++) {
      const col = grid[r][c]
      const ch = col ? '█' : ' '
      const k = col || '_'
      const last = segs[segs.length - 1]
      if (last && last.k === k) last.text += ch
      else segs.push({ k, text: ch, col })
    }
    rows.push(
      Box({
        flexDirection: 'row',
        children: segs.map((s, j) =>
          Text({ key: keyPrefix + r + 's' + j, children: [s.text], color: s.col || undefined }),
        ),
      }),
    )
  }
  return Box({ flexDirection: 'column', children: rows })
}

// ============================ 战斗状态 + battleDriver 接口 ============================
// 节拍驱动接口：决定“一次攻击节拍”由什么事件触发、每次发动几次攻击。
// 默认仅 prompt.submit 驱动；以后加 turn 驱动或混合模式，只需新增实现并接线，不改主逻辑。
interface BattleDriver {
  beatsPerEvent(source: 'prompt' | 'turn'): number
}
const promptDriver: BattleDriver = {
  beatsPerEvent: (s) => (s === 'prompt' ? 1 : 0),
}
// 未来扩展（示例，第一版不接）：
//   const turnDriver: BattleDriver = { beatsPerEvent: (s) => (s === 'turn' ? 1 : 0) }
//   const hybridDriver: BattleDriver = { beatsPerEvent: () => 1 }
const driver: BattleDriver = promptDriver

// 会话内状态（等级/经验/战绩来自 $.store 持久化，见 loadSave/saveSave）
let level = 1 // 等级
let exp = 0 // 当前等级内经验
let battles = 0 // 累计攻击次数
let defeats = 0 // 累计击败数
let enemy = null // { type, name, rarity, hp, maxHp }
let phase = 'idle' // 'idle' | 'victory'（victory 为击败后短暂像素消散阶段）
let frame = 0 // 空闲动画帧索引
let attackTicks = 0 // 攻击姿势剩余帧
let victoryTicks = 0 // 击败消散剩余帧
let lastLog = 'Nibble 待命中… 向 CodeBuddy 提问即可发动攻击'
let logColor = 'brightBlack'
let timer = null // 空闲动画定时器句柄，session.end 时清理

const ENEMY_NAMES = { bat: '蝙蝠', slime: '史莱姆', mimic: '宝箱怪' }
const ENEMY_TYPES = Object.keys(ENEMY_NAMES)
const RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }
const STORE_KEY = 'nibble.save' // $.store 键（本机所有会话共享）

// ---- 成长曲线 ----
const xpNeed = (lv) => 20 + (lv - 1) * 15 // 升到下一级所需经验
const playerAtk = () => 4 + level * 2 // 基础攻击力随等级提升
const enemyMaxHp = () => 30 + (level - 1) * 8 + Math.floor(Math.random() * 16)

// 稀有度随等级小幅提升出金概率
function rollRarity() {
  const b = Math.min((level - 1) * 0.01, 0.12)
  const r = Math.random()
  if (r < 0.7 - b * 2) return 'common'
  if (r < 0.9 - b) return 'rare'
  if (r < 0.98) return 'epic'
  return 'legendary'
}

function spawnEnemy() {
  const type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)]
  const rarity = rollRarity()
  const maxHp = enemyMaxHp()
  enemy = { type, name: ENEMY_NAMES[type], rarity, hp: maxHp, maxHp }
}

// ---- 持久化（$.store：跨会话共享 JSON，4 MiB 上限；不可用时退化为仅内存）----
function snapshot() {
  return { v: 1, level, exp, battles, defeats, enemy }
}
async function loadSave($) {
  try {
    const s = await $.store.get(STORE_KEY)
    if (!s || typeof s !== 'object') return
    if (typeof s.level === 'number') level = s.level
    if (typeof s.exp === 'number') exp = s.exp
    if (typeof s.battles === 'number') battles = s.battles
    if (typeof s.defeats === 'number') defeats = s.defeats
    const e = s.enemy
    if (e && ENEMY_NAMES[e.type] && typeof e.hp === 'number' && typeof e.maxHp === 'number' && e.hp > 0) {
      enemy = { type: e.type, name: ENEMY_NAMES[e.type], rarity: e.rarity || 'common', hp: e.hp, maxHp: e.maxHp }
      lastLog = `继续上次的战斗：Lv ${level} vs 野生 ${enemy.name}（${RARITY_LABEL[enemy.rarity]}）`
      logColor = 'cyan'
    }
  } catch {
    /* 存储不可用时仅内存运行 */
  }
}
async function saveSave($) {
  try {
    await $.store.set(STORE_KEY, snapshot())
  } catch {
    /* 忽略写入失败 */
  }
}

// 结算经验，必要时连续升级（返回升级次数）
function gainExp(amount) {
  exp += amount
  let ups = 0
  while (exp >= xpNeed(level)) {
    exp -= xpNeed(level)
    level += 1
    ups += 1
  }
  return ups
}

// 一次攻击（特殊技按键 1 留接口 special()，第一版不强制实现）
function special() {
  /* TODO: Perfect 命中（未来接按键 1），当前直接按普攻处理 */
}
async function attack($) {
  if (phase === 'victory') return // 消散阶段不响应攻击
  special()
  const atk = playerAtk()
  const dmg = Math.max(1, atk + Math.floor(Math.random() * 5) - 2)
  enemy.hp -= dmg
  attackTicks = 3
  battles += 1
  if (enemy.hp <= 0) {
    enemy.hp = 0
    phase = 'victory'
    victoryTicks = 4
    defeats += 1
    const caught = Math.random() < 0.7
    const gain = 8 + enemy.maxHp
    const ups = gainExp(gain)
    lastLog = `击败野生 ${enemy.name}（${RARITY_LABEL[enemy.rarity]}）！${caught ? '捕获成功' : '未捕获'} +${gain}XP`
    logColor = 'green'
    if (ups > 0) lastLog += `　⬆ 升级 Lv ${level}！`
    if ($) await saveSave($) // 击败/升级后落盘
  } else {
    lastLog = `Nibble 攻击！野生 ${enemy.name} -${dmg} HP`
    logColor = 'red'
  }
}

function hpBar() {
  const total = 10
  const ratio = Math.max(0, enemy.hp) / enemy.maxHp
  const filled = Math.round(ratio * total)
  const bar = '█'.repeat(filled) + '░'.repeat(total - filled)
  const color = ratio > 0.5 ? 'green' : ratio > 0.25 ? 'yellow' : 'red'
  return { bar, num: `${enemy.hp}/${enemy.maxHp}`, color }
}

// ============================ register(on) ============================
export function register(on) {
  // 会话开始：恢复存档 / 生成首只野生、注册 /nibble 命令、启动轻量空闲动画定时器
  on('session.start', async ($, e, next) => {
    await loadSave($) // 恢复跨会话进度（等级/经验/战绩/当前敌人）
    if (!enemy) spawnEnemy()
    await $.command.register({
      name: 'nibble',
      description: 'Nibble 陪伴小生物：查看状态 / attack 补刀 / reset 重置',
      argumentHint: '[attack|reset]',
    })
    timer = $.clock.every(600, () => {
      if (phase === 'victory') {
        victoryTicks -= 1
        if (victoryTicks <= 0) {
          spawnEnemy()
          phase = 'idle'
          lastLog = `新的野生 ${enemy.name}（${RARITY_LABEL[enemy.rarity]}）出现`
          logColor = 'yellow'
          saveSave($) // 落盘新敌人（不阻塞动画）
        }
      } else if (attackTicks > 0) {
        attackTicks -= 1
      } else {
        frame = (frame + 1) % 2
      }
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // 会话结束：落盘进度并清理空闲定时器（避免泄漏/阻塞）
  on('session.end', async ($, e, next) => {
    if (timer && timer.cancel) timer.cancel()
    timer = null
    await saveSave($)
    return next(e)
  })

  // 攻击节拍：仅监听 prompt.submit 事件名，不读取其 payload
  on('prompt.submit', async ($, e, next) => {
    const n = driver.beatsPerEvent('prompt')
    for (let i = 0; i < n; i++) await attack($)
    $.ui.invalidate('ui.render')
    return next(e) // 不修改、不拦截提问
  })

  // /nibble 命令：查看状态 / attack 手动补刀 / reset 重置进度
  on('command.run', { command: 'nibble' }, async ($, e) => {
    const args = (e.args || '').trim()
    if (args === 'attack') {
      await attack($)
      $.ui.invalidate('ui.render')
      return { text: '🗡️ 手动补刀：' + lastLog }
    }
    if (args === 'reset') {
      level = 1
      exp = 0
      battles = 0
      defeats = 0
      spawnEnemy()
      phase = 'idle'
      lastLog = '进度已重置，新的野生敌人出现'
      logColor = 'yellow'
      try {
        await $.store.delete(STORE_KEY)
      } catch {
        /* 忽略 */
      }
      $.ui.invalidate('ui.render')
      return { text: '♻️ 已重置等级/经验/战绩，并清除存档' }
    }
    return {
      text:
        `⚔ Nibble ｜ Lv ${level} XP ${exp}/${xpNeed(level)} ｜ 攻击 ${battles} 次 · 击败 ${defeats}` +
        ` ｜ 当前野生 ${enemy.name}（${RARITY_LABEL[enemy.rarity]}）HP ${enemy.hp}/${enemy.maxHp} ｜ ${phase}`,
    }
  })

  // AbovePrompt 窄带：玩家 ⚔ 野生（Raster 真彩，24x24→12 行）+ HP 条 + 单行日志
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text, Raster } = $.ui.resolve(e)
    const useRaster = !!Raster && e.surface === 'terminal'
    if (!enemy) spawnEnemy() // 兜底：session.start 之前渲染也不至于空指针

    const renderSprite = (grid, key) =>
      useRaster ? rasterElement(Raster, grid, key) : textSprite(Box, Text, grid, key)

    // 玩家帧：待机上下浮动 / 攻击前冲 2px
    const pBase = decodeGrid('player').grid
    const pGrid = attackTicks > 0 ? shiftGrid(pBase, 2, 0) : shiftGrid(pBase, 0, frame % 2)

    // 敌人帧：victory 隔帧闪烁消散 / 稀有度着色 + 亮点
    const blink = (enemy.rarity === 'rare' || enemy.rarity === 'legendary') && frame % 2 === 0
    const eGrid = phase === 'victory' && frame % 2 === 0 ? BLANK_GRID : enemyGrid(enemy.type, enemy.rarity, blink)

    const band = Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        renderSprite(pGrid, 'p'),
        Text({ key: 'sword', children: ['⚔'], color: 'red', bold: true }),
        renderSprite(eGrid, 'e'),
      ],
    })

    const hp = hpBar()
    const lines = [
      band,
      Text({ key: 'hp', children: [' HP ' + hp.bar + ' ' + hp.num + '   Lv ' + level], color: hp.color }),
      Text({ key: 'log', children: [' ' + lastLog], color: logColor }),
    ]

    // 保留其他 mod 在 AbovePrompt 的内容（若有），放在我们上方
    const others = await next(e)
    if (others) lines.unshift(others)
    return Box({ flexDirection: 'column', children: lines })
  })
}
