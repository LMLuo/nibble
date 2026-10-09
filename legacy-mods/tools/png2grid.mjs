// tools/png2grid.mjs — 构建期工具：把 AI 生成的像素画 PNG 转成 24x24 颜色网格
// 产物：hooks/_pixels.gen.txt（TS 片段，手工内联进 register.ts）+ tools/preview/<name>.png 预览图
// 仅构建期使用 pngjs；运行时零依赖。不读取任何项目代码/提示词，只处理图片本身。
//
// 用法: node tools/png2grid.mjs <outFile> <previewDir> name=path.png ...
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const SIZE = 24 // 目标网格边长（半方块渲染时占 12 文本行）
const MARGIN = 1 // 四周留白
const [outFile, previewDir, ...pairs] = process.argv.slice(2)
if (!outFile || pairs.length === 0) {
  console.error('用法: node tools/png2grid.mjs <outFile> <previewDir> name=path.png ...')
  process.exit(1)
}

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase()

const loadPNG = (p) => PNG.sync.read(fs.readFileSync(p))

// 自动裁剪到内容包围盒并等比缩放放进 24x24（盒内多数票采样，抑制抗锯齿杂色）
function cropAndScale(png) {
  const { width: W, height: H, data } = png
  const get = (x, y) => {
    const i = (y * W + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  // 判断是否有真透明；若整图不透明则以角点均值作为背景色抠图
  let hasAlpha = false
  const stride = Math.max(1, (H / 32) | 0)
  for (let y = 0; y < H && !hasAlpha; y += stride) {
    for (let x = 0; x < W; x += Math.max(1, (W / 32) | 0)) {
      if (get(x, y)[3] < 128) { hasAlpha = true; break }
    }
  }
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => get(x, y))
  const bg = corners
    .reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0])
    .map((v) => Math.round(v / 4))
  const isBg = (r, g, b, a) =>
    hasAlpha ? a < 128 : a < 128 || (Math.abs(r - bg[0]) < 28 && Math.abs(g - bg[1]) < 28 && Math.abs(b - bg[2]) < 28)

  let minX = W, minY = H, maxX = -1, maxY = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = get(x, y)
      if (!isBg(r, g, b, a)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('图片内容为空')
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

// 调色板压缩：>36 色时按出现频率取前 36，其余映射到最近色（base36 索引，'.' 为透空）
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
  const rows = grid.map((row) =>
    row.map((c) => (c === null ? '.' : (idx.get(c) ?? 0).toString(36))).join(''),
  )
  return { palette: colors, rows }
}

// 预览图：把 24x24 网格放大 12 倍写入 PNG，便于人工核验
function writePreview(name, palette, rows, dir) {
  if (!dir) return
  const S = 12
  const png = new PNG({ width: SIZE * S, height: SIZE * S })
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ch = rows[y][x]
      const col = ch === '.' ? null : palette[parseInt(ch, 36)]
      const [r, g, b] = col
        ? [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16), parseInt(col.slice(5, 7), 16)]
        : [13, 15, 20] // 背景 #0D0F14
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const o = ((y * S + dy) * SIZE * S + (x * S + dx)) * 4
          png.data[o] = r
          png.data[o + 1] = g
          png.data[o + 2] = b
          png.data[o + 3] = 255
        }
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name + '.png'), PNG.sync.write(png))
}

const out = {}
for (const pair of pairs) {
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq)
  const p = pair.slice(eq + 1)
  const grid = cropAndScale(loadPNG(p))
  const res = toPaletteRows(grid)
  out[name] = res
  writePreview(name, res.palette, res.rows, previewDir)
}

let ts = '// 自动生成：tools/png2grid.mjs（构建期工具，运行时零依赖）。请勿手改，重跑脚本更新。\n'
ts += 'const PIXEL_DATA = {\n'
for (const name of Object.keys(out)) {
  const { palette, rows } = out[name]
  ts += `  ${name}: {\n    palette: ${JSON.stringify(palette)},\n    rows: ${JSON.stringify(rows)},\n  },\n`
}
ts += '}\n'
fs.writeFileSync(outFile, ts)
console.log('已生成', outFile, '｜ 预览图位于', previewDir || '(未生成)')
