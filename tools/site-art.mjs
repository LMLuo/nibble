#!/usr/bin/env node
// site-art.mjs —— 官网"画出来的素材"管线（AI 出图 → 干净的像素图）
//
//   node tools/site-art.mjs --probe <file>   只量规格：逻辑像素块大小 / 色数 / 背景形态 / 有效范围
//   node tools/site-art.mjs                  按下面的配置出图（og 分享卡 + 预览立绘）
//
// 为什么需要这一步（site/README.md 的"素材口径"）：AI 出的"像素风"图其实不是像素画——
//   ① 每个"逻辑像素"内部有噪点/渐变（色数上万）② 常有假透明（棋盘格烤进画面）
//   ③ 存成 JPEG 还会有有损彩边。直接放进页面会在纯像素场景里显得脏，体积也顶破预算。
// 本脚本做四件事：抠背景 → 找回逻辑像素网格（每格取众数色）→ 量化到 ≤N 色 → 整数倍缩放输出。
//
// 输入（不入库或已在库，见 .gitignore 与 legacy-mods/CREDITS.md）：
//   legacy-mods/assets/dog.png   拾玖的 AI 源图（1254×1254，带透明通道）
// 输出：
//   site/og.png                                  分享卡片 1200×630（≤ 预算）
//   legacy-mods/preview/shijiu-portrait.png      立绘预览（放大整数倍，gitignore 里，不进站）

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'legacy-mods', 'assets', 'dog.png')
const OUT_OG = path.join(ROOT, 'site', 'og.png')
const OUT_PORTRAIT = path.join(ROOT, 'legacy-mods', 'preview', 'shijiu-portrait.png')

const MAX_COLORS = 14 // 对齐游戏内精灵的 11 色观感；够表现黑鞍/黄褐/奶白三块即可
const PORTRAIT_SCALE = 8 // 立绘预览的放大倍数（整数倍，像素不糊）
const OG = { w: 1200, h: 630, bg: [0x13, 0x1a, 0x26], line: [0x20, 0x2b, 0x42], edge: [0x32, 0x40, 0x5c] }

// —— 读图 ——
function load(p) {
  const png = PNG.sync.read(fs.readFileSync(p))
  return { w: png.width, h: png.height, d: png.data }
}

// —— 背景判定 ——
// 有 alpha 就用 alpha；没有（假透明/棋盘格烤进图）就从四角 flood fill，只吃掉与边缘连通的部分，
// 这样狗身上的白色（胸口、口鼻）不会被误判。
function bgMask(img) {
  const { w, h, d } = img
  const mask = new Uint8Array(w * h)
  let alphaHits = 0
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] < 250) alphaHits++
  if (alphaHits > w * h * 0.02) {
    for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] < 250) mask[i] = 1
    return { mask, kind: 'alpha', ratio: alphaHits / (w * h) }
  }
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
  }
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 42
  const seeds = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ]
  const stack = []
  for (const [sx, sy] of seeds) {
    if (!mask[sy * w + sx]) {
      mask[sy * w + sx] = 1
      stack.push(sx, sy)
    }
  }
  const seedCol = at(0, 0)
  while (stack.length) {
    const y = stack.pop()
    const x = stack.pop()
    const cand = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]
    for (const [nx, ny] of cand) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const i = ny * w + nx
      if (mask[i]) continue
      const c = at(nx, ny)
      // 只吃"和角点同色系"或"灰阶浅色"（棋盘格的两种灰都是一个色系）
      const grayish = c[0] > 180 && Math.abs(c[0] - c[1]) < 12 && Math.abs(c[1] - c[2]) < 12
      if (near(c, seedCol) || grayish) {
        mask[i] = 1
        stack.push(nx, ny)
      }
    }
  }
  let n = 0
  for (let i = 0; i < w * h; i++) n += mask[i]
  return { mask, kind: alphaHits ? 'alpha(partial)' : 'checker/floodfill', ratio: n / (w * h) }
}

// —— 颜色粗量化（4bit/通道）——
// AI 图的一个逻辑像素内部有几十种"几乎一样"的色（噪声）。先把颜色压到 16×16×16 的粗格子，
// 噪声就会被合并；找块大小、统计调色板都在这层做，否则频次统计会被噪声骗（上一版就退化成 14 个近黑色）。
const coarse = (c) => (c[0] >> 4) + ',' + (c[1] >> 4) + ',' + (c[2] >> 4)

// —— 找回逻辑像素网格 ——
// 判据：真正的块内颜色是均匀的（粗量化后众数占比高）。s 越小越容易"纯"，
// 所以从大到小试，取第一个"够纯且尺寸能整除"的 s —— 那才是真实的逻辑像素大小；
// 全不达标时退回纯度最高的（并如实报告，别假装成功）。
function detectBlock(img, mask) {
  const { w, h, d } = img
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
  }
  const purityOf = (s) => {
    const cols = Math.floor(w / s)
    const rows = Math.floor(h / s)
    if (cols < 8 || rows < 8) return 0
    let pure = 0
    let blocks = 0
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const hist = new Map()
        let n = 0
        for (let y = by * s; y < (by + 1) * s; y++) {
          for (let x = bx * s; x < (bx + 1) * s; x++) {
            if (mask[y * w + x]) continue
            const k = coarse(at(x, y))
            hist.set(k, (hist.get(k) || 0) + 1)
            n++
          }
        }
        if (!n) continue
        blocks++
        pure += Math.max(...hist.values()) / n
      }
    }
    return blocks ? pure / blocks : 0
  }
  let best = { s: 1, purity: 0, fits: false }
  for (let s = 48; s >= 4; s--) {
    const fits = w % s <= 1 || s - (w % s) <= 1
    const p = purityOf(s)
    if (p >= 0.85 && fits) return { s, purity: p, fits: true }
    if (p > best.purity) best = { s, purity: p, fits }
  }
  return best
}

// —— 按块取样：块内按粗格投票，再取该格所有像素的**平均色**（比"取某一个噪声色"干净）——
function toGrid(img, mask, s) {
  const { w, h, d } = img
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
  }
  const cols = Math.floor(w / s)
  const rows = Math.floor(h / s)
  const grid = []
  const cnt = new Map()
  for (let by = 0; by < rows; by++) {
    const row = []
    for (let bx = 0; bx < cols; bx++) {
      const hist = new Map()
      let total = 0
      for (let y = by * s; y < (by + 1) * s; y++) {
        for (let x = bx * s; x < (bx + 1) * s; x++) {
          if (mask[y * w + x]) continue
          const c = at(x, y)
          const k = coarse(c)
          const e = hist.get(k) || [0, [0, 0, 0]]
          e[0]++
          e[1][0] += c[0]
          e[1][1] += c[1]
          e[1][2] += c[2]
          hist.set(k, e)
          total++
        }
      }
      if (!hist.size) {
        row.push(null)
        continue
      }
      let bestN = -1
      let bestSum = null
      for (const e of hist.values()) {
        if (e[0] > bestN) {
          bestN = e[0]
          bestSum = e[1]
        }
      }
      // 块内至少 1/4 像素属于同一个粗格才算有效，否则当背景（把毛边抠掉）
      if (bestN < s * s * 0.25) row.push(null)
      else {
        const avg = [Math.round(bestSum[0] / bestN), Math.round(bestSum[1] / bestN), Math.round(bestSum[2] / bestN)]
        row.push(avg)
        const kk = avg.join(',')
        cnt.set(kk, (cnt.get(kk) || 0) + 1)
      }
    }
    grid.push(row)
  }
  return { grid, counts: cnt }
}

// —— 量化：在粗空间里聚类，保留"占格数最多"的 N 个簇，其余映射到最近的簇 ——
function quantize(grid, counts, maxColors) {
  const clusters = new Map() // 粗格 → { n, sum }
  for (const [k, n] of counts) {
    const c = k.split(',').map(Number)
    const g = coarse(c)
    const e = clusters.get(g) || { n: 0, sum: [0, 0, 0] }
    e.n += n
    e.sum[0] += c[0] * n
    e.sum[1] += c[1] * n
    e.sum[2] += c[2] * n
    clusters.set(g, e)
  }
  const keep = [...clusters.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, maxColors)
    .map(([g, e]) => ({ g, c: [Math.round(e.sum[0] / e.n), Math.round(e.sum[1] / e.n), Math.round(e.sum[2] / e.n)] }))
  const nearest = (c) => {
    let best = keep[0].c
    let bd = Infinity
    for (const k of keep) {
      const dist = (c[0] - k.c[0]) ** 2 + (c[1] - k.c[1]) ** 2 + (c[2] - k.c[2]) ** 2
      if (dist < bd) {
        bd = dist
        best = k.c
      }
    }
    return best
  }
  const memo = new Map()
  const out = grid.map((row) =>
    row.map((c) => {
      if (!c) return null
      const k = c.join(',')
      if (!memo.has(k)) memo.set(k, nearest(c))
      return memo.get(k)
    }),
  )
  return { grid: out, palette: keep.map((k) => k.c) }
}

// —— 裁剪到有效范围 ——
function crop(grid) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }),
  )
  return grid.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1))
}

// —— 输出：网格 → PNG（整数倍缩放）——
function drawGrid(grid, scale, pad = 0) {
  const gw = grid[0].length
  const gh = grid.length
  const png = new PNG({ width: gw * scale + pad * 2, height: gh * scale + pad * 2 })
  png.data.fill(0)
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const c = grid[y][x]
      if (!c) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = pad + x * scale + dx
          const py = pad + y * scale + dy
          const i = (py * png.width + px) * 4
          png.data[i] = c[0]
          png.data[i + 1] = c[1]
          png.data[i + 2] = c[2]
          png.data[i + 3] = 255
        }
      }
    }
  }
  return png
}

// —— 输出：og 分享卡（1200×630，纯像素绘制，不用字体）——
function drawOg(grid) {
  const png = new PNG({ width: OG.w, height: OG.h })
  const put = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= OG.w || y >= OG.h) return
    const i = (y * OG.w + x) * 4
    png.data[i] = c[0]
    png.data[i + 1] = c[1]
    png.data[i + 2] = c[2]
    png.data[i + 3] = a
  }
  for (let y = 0; y < OG.h; y++) for (let x = 0; x < OG.w; x++) put(x, y, OG.bg)
  // 内描边（像素风：直角细框）
  for (let x = 12; x < OG.w - 12; x++) {
    put(x, 12, OG.edge)
    put(x, OG.h - 13, OG.edge)
  }
  for (let y = 12; y < OG.h - 12; y++) {
    put(12, y, OG.edge)
    put(OG.w - 13, y, OG.edge)
  }
  // 星点（固定种子，不用随机）
  let seed = 20261013
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 46; i++) {
    const x = 20 + Math.floor(rnd() * (OG.w - 40))
    const y = 20 + Math.floor(rnd() * (OG.h - 120))
    const a = 40 + Math.floor(rnd() * 120)
    put(x, y, [0xe8, 0xee, 0xf9], a)
  }
  const gw = grid[0].length
  const gh = grid.length
  // 地平线 + 地面
  const lineY = OG.h - 96
  for (let x = 12; x < OG.w - 12; x++) {
    put(x, lineY, OG.line)
    put(x, lineY + 1, OG.line)
  }
  for (let y = lineY + 2; y < OG.h - 12; y++) {
    for (let x = 13; x < OG.w - 13; x++) {
      const c = [0x0f, 0x16, 0x22]
      put(x, y, c)
    }
  }
  // 狗：整数倍放大，脚落在地平线上（pngjs 的字段是 width/height/data，别写成 w/h/d）
  const scale = Math.max(1, Math.min(Math.floor((lineY - 60) / gh), Math.floor((OG.w - 200) / gw)))
  const dog = gridPM(grid, scale)
  const ox = Math.round((OG.w - gw * scale) / 2)
  const oy = lineY - gh * scale + 2
  for (let y = 0; y < dog.height; y++) {
    for (let x = 0; x < dog.width; x++) {
      const i = (y * dog.width + x) * 4
      if (dog.data[i + 3] === 0) continue
      put(ox + x, oy + y, [dog.data[i], dog.data[i + 1], dog.data[i + 2]])
    }
  }
  return { png, scale }
}
function gridPM(grid, scale) {
  return drawGrid(grid, scale)
}

// —— 主流程 ——
// cells = 目标网格高度（逻辑像素数）。AI 图的"逻辑像素"往往不是均匀网格（自动探测只用来报告事实），
// 所以出图时由我们明确指定密度：默认 72 格高 ≈ 游戏内 24×24 精灵的 3 倍细节，
// 既读得出"像素画"，又保得住脸。
function pipeline(file, cells) {
  const img = load(file)
  const { mask, kind, ratio } = bgMask(img)
  const { w, h } = img
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  const auto = detectBlock(img, mask)
  const s = Math.max(1, Math.round((cells ? bh / cells : bh / 120))) // 无 --cells 时按 120 格兜底
  const { grid, counts } = toGrid(img, mask, s)
  const q = quantize(grid, counts, MAX_COLORS)
  // 去孤立点：源图的噪点会在深色区域留下零星浅色点（看着"脏"）。
  // 一个格子的四邻全与它不同 → 它是孤立点，改成邻居里最多的那个颜色。
  const despeckle = (g, rounds) => {
    let cur = g
    for (let r = 0; r < rounds; r++) {
      const gh = cur.length
      const gw = cur[0].length
      const near = (a, b) => !!a && !!b && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 24
      const out = cur.map((row) => row.slice())
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const c = cur[y][x]
          if (!c) continue
          const nb = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ].map(([a, b]) => (a < 0 || b < 0 || a >= gw || b >= gh ? null : cur[b][a]))
          if (!nb.every((n) => !near(c, n))) continue
          const freq = new Map()
          nb.forEach((n) => {
            if (!n) return
            const k = n.join()
            freq.set(k, (freq.get(k) || 0) + 1)
          })
          if (freq.size) out[y][x] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)
          else out[y][x] = null
        }
      }
      cur = out
    }
    return cur
  }
  const cut = crop(despeckle(q.grid, 2))
  return { img, kind, bgRatio: ratio, block: auto, s, bbox: { x0, y0, bw, bh }, grid: cut, palette: q.palette }
}

const args = process.argv.slice(2)
const num = (flag, def) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def
}
const probeAt = args.indexOf('--probe')
const file = probeAt >= 0 ? args[probeAt + 1] || SRC : SRC
const CELLS = num('--cells', 72) // 目标网格高度（格）

if (probeAt >= 0) {
  const r = pipeline(file, CELLS)
  console.log('文件 ' + path.relative(ROOT, file))
  console.log('  尺寸 ' + r.img.w + 'x' + r.img.h)
  console.log('  背景形态 ' + r.kind + '（占 ' + Math.round(r.bgRatio * 100) + '%）')
  console.log('  有效范围 ' + r.bbox.bw + 'x' + r.bbox.bh + 'px')
  console.log('  自动探测逻辑像素 ' + r.block.s + 'px（纯度 ' + (r.block.purity * 100).toFixed(1) + '%：' +
    (r.block.purity >= 0.85 ? '源图网格干净' : '源图没有统一网格 → 出图靠 --cells 指定密度') + '）')
  console.log('  本次网格 ' + r.grid[0].length + 'x' + r.grid.length + ' 格（1 格 = ' + r.s + 'px）')
  console.log('  量化后颜色 ' + r.palette.length + ' 个：' + r.palette.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')).join(' '))
  process.exit(0)
}

const r = pipeline(SRC, CELLS)
console.log('源 ' + path.relative(ROOT, SRC) + ' → 网格 ' + r.grid[0].length + 'x' + r.grid.length + ' 格（1 格 = ' + r.s + 'px）' +
  '，色 ' + r.palette.length + '，背景 ' + Math.round(r.bgRatio * 100) + '%（' + r.kind + '）')

fs.mkdirSync(path.dirname(OUT_PORTRAIT), { recursive: true })
const portrait = drawGrid(r.grid, PORTRAIT_SCALE, 8)
fs.writeFileSync(OUT_PORTRAIT, PNG.sync.write(portrait))
console.log('✓ ' + path.relative(ROOT, OUT_PORTRAIT) + '  ' + portrait.width + 'x' + portrait.height +
  '  ' + Math.round(fs.statSync(OUT_PORTRAIT).size / 1024) + 'KB（预览用，不进站）')

const og = drawOg(r.grid)
fs.writeFileSync(OUT_OG, PNG.sync.write(og.png))
console.log('✓ ' + path.relative(ROOT, OUT_OG) + '  ' + og.png.width + 'x' + og.png.height +
  '  ' + Math.round(fs.statSync(OUT_OG).size / 1024) + 'KB（分享卡，狗按 ' + og.scale + ' 倍整数放大）')
