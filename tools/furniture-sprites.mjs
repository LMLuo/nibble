// tools/furniture-sprites.mjs — 小屋家具素材构建（构建期工具，运行时零依赖）
//
// 与 weapons-sprites / monsters-sprites 同一套思路，唯一差别是**目标尺寸不固定**：
// 每件家具按 home-data.js 里 SLOTS[].sprite 的 [w, h] 输出，所以同一槽位跨 5 套
// 尺寸完全一致，玩家换套装时布局一格都不会错位。
//
// 流程：绿底排列图 → 等分切片 → 裁剪 + 等比缩放到槽位尺寸（底部贴齐）→ 调色板量化
//       → vscode-extension/media/furniture-pixels.js + preview 校验拼图
//
// 为什么输出到 media/ 而不是 hooks/：家具是**前端**用的（画进图集），
// 而 localResourceRoots 只开放 vscode-extension/media/ 这一层。
//
// 用法: node tools/furniture-sprites.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEETS_DIR = path.join(root, 'legacy-mods', 'assets', 'furniture', 'sheets')
const CELLS_DIR = path.join(root, 'legacy-mods', 'assets', 'furniture', 'cells')
const PREVIEW_DIR = path.join(root, 'legacy-mods', 'tools', 'preview', 'furniture')
const OUT_FILE = path.join(root, 'vscode-extension', 'media', 'furniture-pixels.js')

const MARGIN = 1 // 左右与顶部各留 1px；底部不留，家具必须贴地

// 槽位像素尺寸：**必须与 media/home-data.js 的 SLOTS[].sprite 保持一致**。
// 改这里之前先改那边，否则换套装会错位。
const SLOT_SIZES = {
  bed: [80, 62],
  desk: [70, 50],
  chair: [38, 42],
  lamp: [30, 52],
  rug: [108, 54],
  deco: [34, 40],
}

// 材质贴图：地板是一块 2:1 的等距菱形砖（正好铺满一格），墙纸是 32×32 的可平铺方砖。
// 尺寸与 home-data.js 的 TILE_W / TILE_H 绑定，改房间格距要同步改这里。
const TILE_SIZES = {
  tile_floor: [32, 16],
  tile_wall: [32, 32],
}

// 20 件通用装饰的像素尺寸。**必须与 home-data.js 的 EXTRAS[].sprite 一致**。
// 尺寸按「视觉高度」分档，不按占格：书架要 68 高，杯子只要 22 高。
const EXTRA_SIZES = {
  plant: [38, 42],
  books: [38, 26],
  mug: [38, 22],
  globe: [38, 40],
  boxes: [38, 34],
  floorlamp: [38, 58],
  guitar: [38, 56],
  tank: [38, 36],
  catbed: [38, 26],
  coffee: [38, 34],
  shelf: [70, 68],
  sofa: [70, 46],
  cabinet: [70, 34],
  screen: [70, 66],
  turntable: [70, 38],
  foldingtable: [70, 40],
  wardrobe: [80, 62],
  bigshelf: [80, 62],
  beanbag: [80, 54],
  cattree: [80, 62],
}

// 排列图清单：一张图 = 一套的 6 件，3 列 × 2 行，按阅读顺序（左→右、上→下）对应 ids。
// 加一套 = 放一张图 + 在这里加一条 + 重跑脚本。
// 排列图清单。**一张图 3 件、横向排开**（cols=3, rows=1）比 3×2 稳得多：
// AI 经常把 6 件挤成「上排 2 件 + 下排 4 件」，列投影几乎没有空隙，自动分割会失败。
// 3 件横排时每件之间有很宽的绿带，切点找得准，单件占的像素也更多。
// 暖木套是最早生成的 3×2 图且恰好合规，保留原样不动。
const SHEETS = [
  { setId: 'wood', cols: 3, rows: 2, file: '01-wood.png', ids: ['bed', 'desk', 'chair', 'lamp', 'rug', 'deco'] },
  { setId: 'study', cols: 3, rows: 1, file: '02-study-a.png', ids: ['bed', 'desk', 'chair'] },
  { setId: 'study', cols: 3, rows: 1, file: '02-study-b.png', ids: ['lamp', 'rug', 'deco'] },
  { setId: 'moss', cols: 3, rows: 1, file: '03-moss-a.png', ids: ['bed', 'desk', 'chair'] },
  { setId: 'moss', cols: 3, rows: 1, file: '03-moss-b.png', ids: ['lamp', 'rug', 'deco'] },
  { setId: 'neon', cols: 3, rows: 1, file: '04-neon-a.png', ids: ['bed', 'desk', 'chair'] },
  { setId: 'neon', cols: 3, rows: 1, file: '04-neon-b.png', ids: ['lamp', 'rug', 'deco'] },
  { setId: 'star', cols: 3, rows: 1, file: '05-star-a.png', ids: ['bed', 'desk', 'chair'] },
  { setId: 'star', cols: 3, rows: 1, file: '05-star-b.png', ids: ['lamp', 'rug', 'deco'] },
  // 材质：一套一张，左边地砖（菱形）、右边墙纸（方砖）
  { setId: 'wood', cols: 2, rows: 1, file: '01-wood-tile.png', ids: ['tile_floor', 'tile_wall'] },
  { setId: 'study', cols: 2, rows: 1, file: '02-study-tile.png', ids: ['tile_floor', 'tile_wall'] },
  { setId: 'moss', cols: 2, rows: 1, file: '03-moss-tile.png', ids: ['tile_floor', 'tile_wall'] },
  { setId: 'neon', cols: 2, rows: 1, file: '04-neon-tile.png', ids: ['tile_floor', 'tile_wall'] },
  { setId: 'star', cols: 2, rows: 1, file: '05-star-tile.png', ids: ['tile_floor', 'tile_wall'] },
  // 通用装饰：setId 统一用 'x'（跨套装共用），输出 key 形如 'x/plant'
  { setId: 'x', cols: 3, rows: 1, file: '06-ex1.png', ids: ['plant', 'books', 'mug'] },
  { setId: 'x', cols: 3, rows: 1, file: '06-ex2.png', ids: ['globe', 'boxes', 'floorlamp'] },
  { setId: 'x', cols: 4, rows: 1, file: '06-ex3.png', ids: ['guitar', 'tank', 'catbed', 'coffee'] },
  { setId: 'x', cols: 3, rows: 1, file: '07-ex4.png', ids: ['shelf', 'sofa', 'cabinet'] },
  { setId: 'x', cols: 3, rows: 1, file: '07-ex5.png', ids: ['screen', 'turntable', 'foldingtable'] },
  { setId: 'x', cols: 2, rows: 1, file: '08-ex6.png', ids: ['wardrobe', 'bigshelf'] },
  { setId: 'x', cols: 2, rows: 1, file: '08-ex7.png', ids: ['beanbag', 'cattree'] },
]

// 像素画不是色越多越好。48 色时每件家具都能凑出十几级渐变，
// 缩到 80×62 之后这些渐变变成一片碎点，整屋看起来「乱」。
// 12~16 色是像素画的舒适区：材质靠大色块 + 明确明暗两阶表达，而不是靠色阶。
const MAX_COLORS = 14

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase()

// 抹掉生成图的水印与边框：四边 12px + 右下角水印区一律填回绿幕
function eraseOverlays(png) {
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
        const o = (y * png.width + x) * 4
        png.data[o] = 0
        png.data[o + 1] = 255
        png.data[o + 2] = 0
        png.data[o + 3] = 255
      }
    }
  }
  const W = png.width
  const H = png.height
  const edge = 12
  fill(0, 0, W, edge)
  fill(0, H - edge, W, H)
  fill(0, 0, edge, H)
  fill(W - edge, 0, W, H)
  fill(W - 300, H - 84, W, H) // 水印区（image_gen 右下角）
}

// 背景判定（与 cropAndScale 内部同一口径），用于投影统计
function makeIsBg(png) {
  const { width: W, height: H, data } = png
  const get = (x, y) => {
    const i = (y * W + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ].map(([x, y]) => get(x, y))
  const bg = corners.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => Math.round(v / 4))
  const isGreenKey = (r, g, b) => g > 100 && g > r * 1.3 + 20 && g > b * 1.3 + 20
  return (r, g, b, a) =>
    a < 128 || isGreenKey(r, g, b) || (Math.abs(r - bg[0]) < 28 && Math.abs(g - bg[1]) < 28 && Math.abs(b - bg[2]) < 28)
}

// 按内容空隙自动找切割线。
// 为什么不用等分：AI 生成的排列图**不保证**每件都居中在自己那格，
// 硬等分会把超出半格的家具拦腰切断（暖木套的床就被切掉了一条边）。
// 这里按「整列/整行有多少非背景像素」找空白带，取最宽的 N-1 个空隙中点当刀口。
function findBounds(png, axis, expected, minGap) {
  const isBg = makeIsBg(png)
  const W = png.width
  const H = png.height
  const n = axis === 'x' ? W : H
  const counts = new Array(n).fill(0)
  if (axis === 'x') {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (!isBg(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3])) counts[x] += 1
      }
    }
  } else {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (!isBg(png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3])) counts[y] += 1
      }
    }
  }

  const gaps = []
  let start = -1
  for (let i = 0; i < n; i++) {
    if (counts[i] === 0) {
      if (start < 0) start = i
    } else if (start >= 0) {
      if (i - start >= minGap) gaps.push([start, i - 1, i - start])
      start = -1
    }
  }
  if (start >= 0 && n - start >= minGap) gaps.push([start, n - 1, n - start])

  // 首尾的空白带不是切割点（那是页边距）
  const inner = gaps.filter((g) => g[0] > 0 && g[1] < n - 1)
  if (inner.length < expected - 1) return null
  inner.sort((a, b) => b[2] - a[2])
  const cut = inner
    .slice(0, expected - 1)
    .sort((a, b) => a[0] - b[0])
    .map((g) => Math.round((g[0] + g[1]) / 2))

  const bounds = [0, ...cut, n]
  return bounds.length === expected + 1 ? bounds : null
}

// 切片：优先按内容空隙切；找不到空隙（家具挨太近）时退回等分
function sliceSheet(png, cols, rows) {
  const minGap = Math.max(6, Math.round(Math.min(png.width, png.height) * 0.012))
  const xb = findBounds(png, 'x', cols, minGap) || null
  const yb = findBounds(png, 'y', rows, minGap) || null
  const xs = xb || Array.from({ length: cols + 1 }, (_, i) => Math.round((i * png.width) / cols))
  const ys = yb || Array.from({ length: rows + 1 }, (_, i) => Math.round((i * png.height) / rows))
  if (!xb) console.log('   ! 列方向没找到足够空隙，退回等分')
  if (!yb) console.log('   ! 行方向没找到足够空隙，退回等分')

  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = xs[c]
      const y0 = ys[r]
      const cw = Math.max(1, xs[c + 1] - x0)
      const ch = Math.max(1, ys[r + 1] - y0)
      const cell = new PNG({ width: cw, height: ch })
      PNG.bitblt(png, cell, x0, y0, cw, ch, 0, 0)
      cells.push(cell)
    }
  }
  return cells
}

// 清背景：image_gen 给的"绿幕"经常不是纯 #00FF00，而是带噪点的中绿（实测 #3E9E5F 左右），
// 单靠 `g > r*1.3+20` 这类启发式会漏掉一堆噪点，缩到 56×46 后变成家具边缘的绿色毛刺。
//
// 做法：统计整格出现最多的颜色当作背景色，按距离清除；再补一刀「绿度」判定收拾残余。
// 不做边缘泛洪：背景噪点与 eraseOverlays 填的纯绿之间色差太大（欧氏距离 ~150），
// 泛洪根本连不通，而且椅子镂空里的背景也不与边缘连通。
function clearBackground(png, tol = 50) {
  const { width: W, height: H, data } = png
  // 关键：只在「绿色像素」里统计众数。
  // 床/桌这类大件会占掉格子一半以上面积，如果全图统计，众数会落在木色上，
  // 结果是把家具本身当成背景清掉（第一版就是这么翻车的）。
  const hist = new Map()
  const isGreenish = (r, g, b) => g > 90 && g - Math.max(r, b) > 25
  let greenCount = 0
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    const r = data[o]
    const g = data[o + 1]
    const b = data[o + 2]
    if (!isGreenish(r, g, b)) continue
    const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3)
    hist.set(key, (hist.get(key) || 0) + 1)
    greenCount++
  }
  let bestKey = 0
  let bestN = -1
  for (const [k, n] of hist) {
    if (n > bestN) {
      bestN = n
      bestKey = k
    }
  }
  // 绿像素不到 5% 说明这张图没用绿幕，那就别清（宁可留背景也别把家具削掉）
  if (greenCount < W * H * 0.05) return 0

  const br = ((bestKey / 1024) | 0) * 8 + 4
  const gKey = (bestKey / 32) | 0
  const bgg = (gKey % 32) * 8 + 4
  const bgb = (bestKey % 32) * 8 + 4

  const tol2 = tol * tol
  let cleared = 0
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    const dr = data[o] - br
    const dg = data[o + 1] - bgg
    const db = data[o + 2] - bgb
    if (dr * dr + dg * dg + db * db < tol2) {
      data[o + 3] = 0
      cleared++
    }
  }
  return cleared
}

// 整体压暗（只作用于材质贴图，不碰家具）。
// AI 出的地砖比设计稿亮一大截（实测 #E0A060，原定 #9C7342），
// 铺满整屋之后家具也是暖木色，两者糊成一片、层次全没了。
// 只压地板/墙纸：家具是画面主体，压它等于本末倒置。
function dimPixels(png, factor) {
  const { width: W, height: H, data } = png
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    if (data[o + 3] === 0) continue // 透明像素不用管
    data[o] = Math.round(data[o] * factor)
    data[o + 1] = Math.round(data[o + 1] * factor)
    data[o + 2] = Math.round(data[o + 2] * factor)
  }
}

// 压暗系数：地板压得多（它面积最大、最容易抢戏），墙纸只轻微压一点。
const FLOOR_DIM = 0.78
const WALL_DIM = 0.9

// 把边缘若干像素打成透明。专门给墙纸用：
// image_gen 给的方砖四边常带一圈白/浅色边框，平铺后会变成网格线。
function shrinkEdges(png, px) {
  const { width: W, height: H, data } = png
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= px && y >= px && x < W - px && y < H - px) continue
      data[(y * W + x) * 4 + 3] = 0
    }
  }
}

// 裁剪 + 等比缩放 + 量化成目标尺寸的字符网格。
// 与 pixel-sheet.mjs 的差别：
//   1) 目标宽高可变（按槽位）；
//   2) 垂直方向**底部贴齐**而不是居中 —— 家具要坐在地上，居中会让它浮起 1~2px；
//   3) 缩放用面积平均（每格取多个采样点的众数）而不是双线性，
//      否则边缘会发灰、进 GL 后变成暗缝（第一刀已经踩过这个坑）。
function cropAndScale(png, TW, TH, margin, keepEdges) {
  const mg = margin == null ? MARGIN : margin
  const { width: W, height: H, data } = png
  const get = (x, y) => {
    const i = (y * W + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }

  const corners = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
  ].map(([x, y]) => get(x, y))
  const bg = corners.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => Math.round(v / 4))
  const isGreenKey = (r, g, b) => g > 100 && g > r * 1.3 + 20 && g > b * 1.3 + 20
  const isBg = (r, g, b, a) =>
    a < 128 || isGreenKey(r, g, b) || (Math.abs(r - bg[0]) < 28 && Math.abs(g - bg[1]) < 28 && Math.abs(b - bg[2]) < 28)

  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1
  const colCounts = new Array(W).fill(0)
  const rowCounts = new Array(H).fill(0)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = get(x, y)
      if (isBg(r, g, b, a)) continue
      colCounts[x] += 1
      rowCounts[y] += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('格子内容为空（可能切偏了）')

  // 密度裁剪：丢掉稀疏的粒子/光晕，只留主体（列/行内容数 ≥ 峰值 12%）
  const trim = (counts, lo, hi) => {
    let peak = 0
    for (let i = lo; i <= hi; i++) if (counts[i] > peak) peak = counts[i]
    const cut = Math.max(2, peak * 0.12)
    let a = lo
    let b = hi
    while (a < b && counts[a] < cut) a++
    while (b > a && counts[b] < cut) b--
    return [a, b]
  }
  // 地砖/墙纸不能修剪：菱形的四个尖端本来就「稀疏」，被裁掉后砖块缩水，
  // 铺起来就会在格与格之间留出背景空隙。
  if (!keepEdges) {
    ;[minX, maxX] = trim(colCounts, minX, maxX)
    ;[minY, maxY] = trim(rowCounts, minY, maxY)
  }

  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  // 材质模式：直接铺满目标尺寸，不做等比缩放。
  // AI 画的地砖经常是近似正方形而不是 2:1 菱形，等比缩放后会只占半格宽，
  // 铺起来就全是空隙 —— 等距地砖的形状本来就是被投影压扁的，拉伸反而是对的。
  let dw
  let dh
  if (keepEdges) {
    dw = TW
    dh = TH
  } else {
    const s = Math.min((TW - 2 * mg) / cw, (TH - mg) / ch)
    dw = Math.max(1, Math.round(cw * s))
    dh = Math.max(1, Math.round(ch * s))
  }
  const ox = Math.floor((TW - dw) / 2)
  const oy = TH - dh // 底部贴齐

  const grid = Array.from({ length: TH }, () => Array(TW).fill(null))
  for (let ty = 0; ty < dh; ty++) {
    const y0 = Math.floor((ty * ch) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * ch) / dh))
    for (let tx = 0; tx < dw; tx++) {
      const x0 = Math.floor((tx * cw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * cw) / dw))
      const counts = new Map()
      // 遍历目标像素覆盖的全部源像素取众数。
      // 原来是「6×6 跳采样」：怪物 24×24 缩得狠（十几倍）时看不出问题，
      // 但家具只缩 1~2 倍，跳采样会跨到相邻像素，把细节抹成一片糊。
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
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
      let best = null
      let bestN = -1
      for (const [k, n] of counts) {
        if (n > bestN) {
          bestN = n
          best = k
        }
      }
      const [qr, qg, qb] = best.split(',').map(Number)
      grid[oy + ty][ox + tx] = hex(qr, qg, qb)
    }
  }
  return grid
}

// 去孤立杂色。AI 生成的「像素风插画」在缩放后会在边缘和暗部留下大量 1px 杂点，
// 这是画面「乱」的第一元凶 —— 人眼会把这些点读成噪点而不是材质。
// 规则：一个像素四周没有同色邻居、但有个邻居占了多数（≥2），就把自己并入那个颜色。
function despeckle(grid, rounds) {
  const h = grid.length
  const w = grid[0].length
  for (let round = 0; round < (rounds || 1); round++) {
    const src = grid.map((row) => row.slice())
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = src[y][x]
        if (!c) continue
        const counts = new Map()
        let same = 0
        const nb = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]
        for (const [nx, ny] of nb) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const n = src[ny][nx]
          if (!n) continue
          if (n === c) same++
          counts.set(n, (counts.get(n) || 0) + 1)
        }
        if (same > 0 || !counts.size) continue
        let best = null
        let bestN = 0
        for (const [k, n] of counts) {
          if (n > bestN) {
            bestN = n
            best = k
          }
        }
        if (bestN >= 2) grid[y][x] = best
      }
    }
  }
  return grid
}

function toPaletteRows(grid, maxColors) {
  const freq = new Map()
  for (const row of grid) for (const c of row) if (c) freq.set(c, (freq.get(c) || 0) + 1)
  let colors = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a))
  if (colors.length > maxColors) {
    const top = colors.slice(0, maxColors)
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
      let near = top[0]
      let nd = Infinity
      for (const t of top) {
        const d = dist(c, t)
        if (d < nd) {
          nd = d
          near = t
        }
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

// 校验拼图：按各件自己的尺寸放大排列，供人工核对观感与套内一致性
function writeContact(name, items, scale) {
  const S = scale
  const gap = 10
  const cols = Math.min(3, items.length)
  const rows = Math.ceil(items.length / cols)
  const cellW = Math.max(...items.map((i) => i.w)) * S + gap
  const cellH = Math.max(...items.map((i) => i.h)) * S + gap
  const png = new PNG({ width: cols * cellW + gap, height: rows * cellH + gap })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 22
    png.data[i + 1] = 18
    png.data[i + 2] = 15
    png.data[i + 3] = 255
  }
  items.forEach((item, k) => {
    const cx = k % cols
    const cy = Math.floor(k / cols)
    // 底部对齐：与运行时一致的贴地观感
    const baseX = gap + cx * cellW
    const baseY = gap + cy * cellH + cellH - gap
    for (let y = 0; y < item.h; y++) {
      for (let x = 0; x < item.w; x++) {
        const ch2 = item.rows[y][x]
        if (ch2 === '.') continue
        const col = item.palette[parseInt(ch2, 36)]
        if (!col) continue
        const r = parseInt(col.slice(1, 3), 16)
        const g = parseInt(col.slice(3, 5), 16)
        const b = parseInt(col.slice(5, 7), 16)
        for (let dy = 0; dy < S; dy++) {
          for (let dx = 0; dx < S; dx++) {
            const px = baseX + x * S + dx
            const py = baseY - (item.h - y) * S + dy
            if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue
            const o = (py * png.width + px) * 4
            png.data[o] = r
            png.data[o + 1] = g
            png.data[o + 2] = b
            png.data[o + 3] = 255
          }
        }
      }
    }
  })
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  fs.writeFileSync(path.join(PREVIEW_DIR, name + '.png'), PNG.sync.write(png))
}

// —— 主流程 ——
fs.mkdirSync(SHEETS_DIR, { recursive: true })
fs.mkdirSync(CELLS_DIR, { recursive: true })

if (!fs.existsSync(SHEETS_DIR)) throw new Error('缺少排列图目录：' + SHEETS_DIR)

const out = {}
// 一套可能来自多张排列图，contact 拼图要按套装聚合
const bySet = {}
let sheetCount = 0
const missing = []

for (const sheet of SHEETS) {
  const sheetPath = path.join(SHEETS_DIR, sheet.file)
  if (!fs.existsSync(sheetPath)) {
    missing.push(sheet.file)
    continue // 素材还没画完的套跳过去，已画好的照常生成
  }
  const png = PNG.sync.read(fs.readFileSync(sheetPath))
  eraseOverlays(png)
  const cells = sliceSheet(png, sheet.cols, sheet.rows)
  if (cells.length !== sheet.ids.length) {
    throw new Error(`${sheet.file}: 网格 ${cells.length} 格 ≠ 清单 ${sheet.ids.length} 个（检查 cols/rows）`)
  }

  if (!bySet[sheet.setId]) bySet[sheet.setId] = []
  cells.forEach((cell, i) => {
    const slotId = sheet.ids[i]
    const size = SLOT_SIZES[slotId] || TILE_SIZES[slotId] || EXTRA_SIZES[slotId]
    if (!size) throw new Error('未知槽位尺寸: ' + slotId)
    const isTile = !!TILE_SIZES[slotId]
    clearBackground(cell)
    if (slotId === 'tile_wall') shrinkEdges(cell, 3)
    // 材质压暗：必须在清背景之后（否则背景残留也被压暗，更难分辨）
    if (slotId === 'tile_floor') dimPixels(cell, FLOOR_DIM)
    else if (slotId === 'tile_wall') dimPixels(cell, WALL_DIM)
    // 地砖必须铺满整格（margin=0），否则相邻砖之间会留出黑缝
    const grid = cropAndScale(cell, size[0], size[1], isTile ? 0 : MARGIN, isTile)
    // 家具去两轮杂点（边缘毛刺 + 暗部散点）；材质贴图只有 32×16，去点会把纹理抹平，跳过
    if (!isTile) despeckle(grid, 2)
    const res = toPaletteRows(grid, MAX_COLORS)
    out[sheet.setId + '/' + slotId] = { w: size[0], h: size[1], palette: res.palette, rows: res.rows }
    bySet[sheet.setId].push({ slotId, w: size[0], h: size[1], ...res })
    fs.writeFileSync(path.join(CELLS_DIR, sheet.setId + '-' + slotId + '.png'), PNG.sync.write(cell))
  })
  console.log(`✓ ${sheet.file} → ${sheet.ids.length} 件（${sheet.setId}）`)
  sheetCount++
}

// 校验拼图统一在全部图处理完后生成，保证一套的 6 件都在同一张图上
const ROTATE = ['bed', 'desk', 'chair', 'lamp', 'rug', 'deco']
for (const setId of Object.keys(bySet)) {
  if (setId === 'x') continue
  const items = ROTATE.map((s) => bySet[setId].find((it) => it.slotId === s)).filter(Boolean)
  writeContact('contact-' + setId, items, 5)
}
// 20 件装饰单独一张拼图（按定义顺序）
if (bySet['x']) writeContact('contact-extras', bySet['x'], 4)

if (!sheetCount) throw new Error('没有可用的排列图，请先放入 ' + SHEETS_DIR)
if (missing.length) console.log('（跳过未生成的套：' + missing.join(', ') + '）')

let js = '// 自动生成：tools/furniture-sprites.mjs（构建期工具，运行时零依赖）。请勿手改。\n'
js += '// 源图：legacy-mods/assets/furniture/sheets/（AI 生成原创像素画）。重跑脚本更新。\n'
js += '// 尺寸与 home-data.js 的 SLOTS[].sprite 一一对应，换套装不会错位。\n'
js += 'const FURNITURE_PIXEL_DATA = {\n'
for (const key of Object.keys(out)) {
  const { w, h, palette, rows } = out[key]
  js += `  '${key}': {\n    w: ${w},\n    h: ${h},\n    palette: ${JSON.stringify(palette)},\n    rows: ${JSON.stringify(rows)},\n  },\n`
}
js += '}\n\n'
js += 'if (typeof module !== \'undefined\' && module.exports) module.exports = { FURNITURE_PIXEL_DATA }\n'
js += 'else (typeof window !== \'undefined\' ? window : globalThis).NibbleFurniturePixels = FURNITURE_PIXEL_DATA\n'
fs.writeFileSync(OUT_FILE, js, 'utf8')

console.log(`已生成 ${OUT_FILE}（${Object.keys(out).length} 件）｜ 校验拼图：${PREVIEW_DIR}/contact-*.png`)
