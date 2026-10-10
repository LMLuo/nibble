// tools/weapons-sprites.mjs — 武器素材构建（构建期工具，运行时零依赖）
// 流程：排列图（AI 生成，绿底）→ 等分切片 → 裁剪缩放 24x24 → 调色板压缩
//       → plugins/nibble/hooks/weapons-pixels.js + preview/weapons/ 校验拼图
// 源图存于 legacy-mods/assets/weapons/sheets/，切片存于 .../cells/。
// 用法: node tools/weapons-sprites.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEETS_DIR = path.join(root, 'legacy-mods', 'assets', 'weapons', 'sheets')
const CELLS_DIR = path.join(root, 'legacy-mods', 'assets', 'weapons', 'cells')
const PREVIEW_DIR = path.join(root, 'legacy-mods', 'tools', 'preview', 'weapons')
const OUT_FILE = path.join(root, 'plugins', 'nibble', 'hooks', 'weapons-pixels.js')

const SIZE = 24 // 目标网格边长（与 png2grid.mjs 一致）
const MARGIN = 1

// 排列图清单：按阅读顺序（左→右、上→下）列出每格对应的武器 id。
// 换/加素材：改这里 + 重放排列图，重跑本脚本即可。
const SHEETS = [
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-01.png',
    ids: ['nullptr_dagger', 'comment_knife', 'enter_hammer', 'indent_sword', 'semicolon_spear', 'bracket_axe', 'todo_dart', 'log_stick'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-03.png',
    ids: ['cache_bow', 'loop_blade', 'string_whip', 'bug_net', 'pipe_wrench', 'regex_ruler', 'compile_hammer', 'stack_spoon'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-07.png',
    ids: ['heap_fork', 'byte_dart', 'hook_scythe', 'shell_fork', 'macro_mallet', 'script_scalpel', 'patch_shovel', 'merge_paddle'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-16.png',
    ids: ['diff_dagger', 'branch_staff', 'clone_cudgel', 'commit_chisel', 'tag_card', 'stash_spear', 'lint_broom', 'format_fan'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-59.png',
    ids: ['indent_pick', 'token_pick', 'pixel_pick', 'var_vane', 'func_fork', 'polyfill_pebble', 'case_club', 'alpha_arrow'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-58.png',
    ids: ['refactor_blade', 'recursion_bow', 'cache_dart', 'async_halberd', 'hash_hammer', 'bitwise_claw', 'inline_rapier', 'coroutine_whip'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-42-01.png',
    ids: ['mutex_mace', 'promise_pike', 'lambda_fist', 'stack_slicer', 'heap_harvester', 'pointer_partisan', 'closure_cleaver', 'stream_saber'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-42-08.png',
    ids: ['socket_spear', 'daemon_dagger', 'kernel_knife', 'thread_thresher', 'buffer_broadsword', 'parser_chakram', 'regex_rapier', 'opcode_scepter'],
  },
  {
    rarity: 'rare', cols: 1, rows: 1,
    file: 'Sprite_sheet_with_a_single_ret_2026-10-10T01-42-30.png',
    ids: ['query_quiver'],
  },
  {
    rarity: 'epic', cols: 3, rows: 2,
    file: 'Sprite_sheet_of_6_different_re_2026-10-10T01-51-45.png',
    ids: ['deadlock_warhammer', 'entropy_staff', 'regex_edge', 'segfault_scythe', 'overflow_glaive', 'race_blade'],
  },
  {
    rarity: 'epic', cols: 3, rows: 2,
    file: 'Sprite_sheet_of_6_different_re_2026-10-10T01-51-43.png',
    ids: ['leak_maul', 'null_cataclysm', 'infinity_lance', 'quantum_debug_blade', 'gc_guillotine', 'bigo_blade'],
  },
  {
    rarity: 'legendary', cols: 3, rows: 1,
    file: 'Sprite_sheet_of_3_different_re_2026-10-10T01-51-48.png',
    ids: ['debug_zero', 'heat_death', 'genesis_commit'],
  },
]

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase()

// —— 以下裁剪/缩放/调色板逻辑与 legacy-mods/tools/png2grid.mjs 保持一致 ——
function cropAndScale(png) {
  const { width: W, height: H, data } = png
  const get = (x, y) => {
    const i = (y * W + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  let hasAlpha = false
  const stride = Math.max(1, (H / 32) | 0)
  for (let y = 0; y < H && !hasAlpha; y += stride) {
    for (let x = 0; x < W; x += Math.max(1, (W / 32) | 0)) {
      if (get(x, y)[3] < 128) { hasAlpha = true; break }
    }
  }
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => get(x, y))
  const bg = corners.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => Math.round(v / 4))
  const isGreenKey = (r, g, b) => g > 100 && g > r * 1.3 + 20 && g > b * 1.3 + 20 // 绿幕残留清理
  const isBg = (r, g, b, a) =>
    hasAlpha ? a < 128 || isGreenKey(r, g, b) : a < 128 || isGreenKey(r, g, b) || (Math.abs(r - bg[0]) < 28 && Math.abs(g - bg[1]) < 28 && Math.abs(b - bg[2]) < 28)

  let minX = W, minY = H, maxX = -1, maxY = -1
  const colCounts = new Array(W).fill(0)
  const rowCounts = new Array(H).fill(0)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = get(x, y)
      if (!isBg(r, g, b, a)) {
        colCounts[x] += 1
        rowCounts[y] += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('图片内容为空')
  // 密度裁剪：丢弃稀疏的粒子光效，只保留主体图标（列/行内容数 ≥ 峰值的 12%）
  const trim = (counts, lo, hi) => {
    let peak = 0
    for (let i = lo; i <= hi; i++) if (counts[i] > peak) peak = counts[i]
    const cut = Math.max(2, peak * 0.12)
    let a = lo, b = hi
    while (a < b && counts[a] < cut) a++
    while (b > a && counts[b] < cut) b--
    return [a, b]
  }
  ;[minX, maxX] = trim(colCounts, minX, maxX)
  ;[minY, maxY] = trim(rowCounts, minY, maxY)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const s = Math.min((SIZE - 2 * MARGIN) / cw, (SIZE - 2 * MARGIN) / ch)
  const dw = Math.max(1, Math.round(cw * s))
  const dh = Math.max(1, Math.round(ch * s))
  const ox = Math.floor((SIZE - dw) / 2)
  const oy = Math.floor((SIZE - dh) / 2)

  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null))
  for (let ty = 0; ty < dh; ty++) {
    const y0 = Math.floor((ty * ch) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * ch) / dh))
    for (let tx = 0; tx < dw; tx++) {
      const x0 = Math.floor((tx * cw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * cw) / dw))
      const counts = new Map()
      const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 6))
      for (let sy = y0; sy < y1; sy += step) {
        for (let sx = x0; sx < x1; sx += step) {
          const [r, g, b, a] = get(minX + Math.min(cw - 1, sx), minY + Math.min(ch - 1, sy))
          if (isBg(r, g, b, a)) continue
          const qr = Math.min(240, Math.round(r / 16) * 16)
          const qg = Math.min(240, Math.round(g / 16) * 16)
          const qb = Math.min(240, Math.round(b / 16) * 16)
          const key = qr + ',' + qg + ',' + qb
          counts.set(key, (counts.get(key) || 0) + 1)
        }
      }
      if (!counts.size) continue
      let best = null, bestN = -1
      for (const [k, n] of counts) {
        if (n > bestN) { bestN = n; best = k }
      }
      const [qr, qg, qb] = best.split(',').map(Number)
      grid[oy + ty][ox + tx] = hex(qr, qg, qb)
    }
  }
  return grid
}

function toPaletteRows(grid) {
  const freq = new Map()
  for (const row of grid) for (const c of row) if (c) freq.set(c, (freq.get(c) || 0) + 1)
  let colors = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a))
  if (colors.length > 36) {
    const top = colors.slice(0, 36)
    const topSet = new Set(top)
    const dist = (h1, h2) => {
      const a = parseInt(h1.slice(1), 16)
      const b = parseInt(h2.slice(1), 16)
      const dr = ((a >> 16) & 255) - ((b >> 16) & 255)
      const dg = ((a >> 8) & 255) - ((b >> 8) & 255)
      const db = (a & 255) - (b & 255)
      return dr * dr + dg * dg + db * db
    }
    const remap = new Map()
    for (const c of freq.keys()) {
      if (topSet.has(c)) continue
      let near = top[0], nd = Infinity
      for (const t of top) {
        const d = dist(c, t)
        if (d < nd) { nd = d; near = t }
      }
      remap.set(c, near)
    }
    for (const row of grid) {
      for (let i = 0; i < row.length; i++) if (row[i] && remap.has(row[i])) row[i] = remap.get(row[i])
    }
    colors = top
  }
  const idx = new Map()
  colors.forEach((c, i) => idx.set(c, i))
  const rows = grid.map((row) => row.map((c) => (c === null ? '.' : (idx.get(c) ?? 0).toString(36))).join(''))
  return { palette: colors, rows }
}

// 抹掉 AI 生成图的水印与边框：四边 12px 白框 + 右下角水印区域一律填回绿幕
function eraseOverlays(png) {
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
        const o = (y * png.width + x) * 4
        png.data[o] = 0; png.data[o + 1] = 255; png.data[o + 2] = 0; png.data[o + 3] = 255
      }
    }
  }
  const W = png.width, H = png.height, edge = 12
  fill(0, 0, W, edge); fill(0, H - edge, W, H)
  fill(0, 0, edge, H); fill(W - edge, 0, W, H)
  fill(W - 300, H - 84, W, H) // "AI生成 WORKBUDDY>" 水印区
}

// 切片：把排列图按 cols×rows 等分，返回每个 cell 的 PNG 对象
function sliceSheet(png, cols, rows) {
  const cw = Math.floor(png.width / cols)
  const ch = Math.floor(png.height / rows)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = new PNG({ width: cw, height: ch })
      PNG.bitblt(png, cell, c * cw, r * ch, cw, ch, 0, 0)
      cells.push(cell)
    }
  }
  return cells
}

// 校验拼图：某稀有度的所有 24x24 网格按顺序拼成一张大图（scale 倍），便于人工核验
function writeContact(name, items, scale) {
  const S = scale
  const gap = 4
  const cols = Math.min(8, items.length)
  const rows = Math.ceil(items.length / cols)
  const cell = SIZE * S + gap
  const png = new PNG({ width: cols * cell + gap, height: rows * cell + gap })
  // 深色底
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 13; png.data[i + 1] = 15; png.data[i + 2] = 20; png.data[i + 3] = 255
  }
  items.forEach(({ palette, rows: gridRows }, idx) => {
    const cx = idx % cols
    const cy = Math.floor(idx / cols)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const ch2 = gridRows[y][x]
        const col = ch2 === '.' ? null : palette[parseInt(ch2, 36)]
        if (!col) continue
        const [r, g, b] = [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)]
        for (let dy = 0; dy < S; dy++) {
          for (let dx = 0; dx < S; dx++) {
            const px = gap + cx * cell + x * S + dx
            const py = gap + cy * cell + y * S + dy
            const o = (py * png.width + px) * 4
            png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255
          }
        }
      }
    }
  })
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  fs.writeFileSync(path.join(PREVIEW_DIR, name + '.png'), PNG.sync.write(png))
}

// —— 主流程 ——
fs.mkdirSync(CELLS_DIR, { recursive: true })
const out = {}
const byRarity = { common: [], rare: [], epic: [], legendary: [] }

for (const sheet of SHEETS) {
  const sheetPath = path.join(SHEETS_DIR, sheet.file)
  if (!fs.existsSync(sheetPath)) throw new Error('缺少排列图: ' + sheetPath)
  const png = PNG.sync.read(fs.readFileSync(sheetPath))
  eraseOverlays(png)
  const cells = sliceSheet(png, sheet.cols, sheet.rows)
  if (cells.length !== sheet.ids.length) {
    throw new Error(`${sheet.file}: 网格 ${cells.length} 格 ≠ 清单 ${sheet.ids.length} 个`)
  }
  cells.forEach((cell, i) => {
    const id = sheet.ids[i]
    const grid = cropAndScale(cell)
    const res = toPaletteRows(grid)
    out[id] = res
    byRarity[sheet.rarity].push({ id, ...res })
    // 切片存档（可再生的中间产物，便于单独重转）
    fs.writeFileSync(path.join(CELLS_DIR, id + '.png'), PNG.sync.write(cell))
  })
  console.log(`✓ ${sheet.file} → ${sheet.ids.length} 把（${sheet.rarity}）`)
}

let js = '// 自动生成：tools/weapons-sprites.mjs（构建期工具，运行时零依赖）。请勿手改。\n'
js += '// 源图：legacy-mods/assets/weapons/sheets/（AI 生成原创像素画，CC0）。重跑脚本更新。\n'
js += 'const WEAPON_PIXEL_DATA = {\n'
for (const id of Object.keys(out)) {
  const { palette, rows } = out[id]
  js += `  ${id}: {\n    palette: ${JSON.stringify(palette)},\n    rows: ${JSON.stringify(rows)},\n  },\n`
}
js += '}\n\nmodule.exports = { WEAPON_PIXEL_DATA }\n'
fs.writeFileSync(OUT_FILE, js, 'utf8')

for (const rarity of Object.keys(byRarity)) {
  if (byRarity[rarity].length) writeContact('contact-' + rarity, byRarity[rarity], 6)
}

console.log(`已生成 ${OUT_FILE}（${Object.keys(out).length} 把）｜ 校验拼图：${PREVIEW_DIR}/contact-*.png`)
