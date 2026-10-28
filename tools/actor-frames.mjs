// tools/actor-frames.mjs — 小屋角色动画帧构建（构建期工具，运行时零依赖）
//
// 为什么要有这个文件：
//   小屋里的角色要走路 / 玩耍 / 休息 / 搞怪，但角色素材只有一张 24×24 的
//   像素画（plugins/nibble/hooks/pixels.js 的 player）。手绘十几帧既贵又容易和
//   本体形象跑偏，所以在**网格层面**做姿势推导：抬头、垂头、迈腿、塌腰、翻肚皮。
//   全部是整行/整列的平移与整像素替换，不缩放、不插值 —— 放大后不会糊。
//
// 输出：
//   vscode-extension/media/actor-frames.js   （webview 直接 <script> 引）
//   legacy-mods/tools/preview/actor/frames.png（人工核验样张，8x）
//
// 用法: node tools/actor-frames.mjs
// 改角色形象（pixels.js 的 player）后重跑一次即可，无需手改任何帧。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { PNG } from 'pngjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_JS = path.join(root, 'vscode-extension', 'media', 'actor-frames.js')
const OUT_PREVIEW = path.join(root, 'legacy-mods', 'tools', 'preview', 'actor', 'frames.png')

const { PIXEL_DATA } = require(path.join(root, 'plugins', 'nibble', 'hooks', 'pixels.js'))
const N = 24
const base = PIXEL_DATA.player.rows.map((r) => [...r])
const DARK = '0' // #303020：眼线 / 轮廓
const CREAM = '1' // #F0E0C0：脸部底色（闭眼时铺回）

// 眼睛矩形（从放大网格人工核对得出）：左 (10..11, 7..8)、右 (15..16, 7..8)
// 每个眼窝只有 2×2：2 像素深色 + 1 像素高光。闭眼 = 上排铺脸色、下排留 1px 眼线。
const EYES = [
  { x0: 10, x1: 11, y0: 7, y1: 8 },
  { x0: 15, x1: 16, y0: 7, y1: 8 },
]

function blank() {
  return Array.from({ length: N }, () => new Array(N).fill('.'))
}
function clone(g) {
  return g.map((r) => r.slice())
}
// 整行平移（dy>0 向下）；空出来的行补透明
function shiftRows(g, dy, y0, y1) {
  const out = clone(g)
  for (let y = y0; y <= y1; y++) {
    const src = y - dy
    out[y] = src >= y0 && src <= y1 ? g[src].slice() : new Array(N).fill('.')
  }
  return out
}
// 整体上下移动（不缩放），底部或顶部补透明
function moveAll(g, dy) {
  const out = blank()
  for (let y = 0; y < N; y++) {
    const src = y - dy
    if (src < 0 || src >= N) continue
    out[y] = g[src].slice()
  }
  return out
}
// 去掉底部 k 行（腿部），整体下沉 k 行：坐 / 趴 的压缩感
function sitDown(g, k) {
  const out = blank()
  for (let y = k; y < N; y++) out[y] = g[y - k].slice()
  return out
}
// 闭眼：上排铺脸色（只抹掉高光与眼白），下排保留 1px 眼线 —— 2×2 眼窝正好对上
function closeEyes(g) {
  const out = clone(g)
  for (const e of EYES) {
    for (let y = e.y0; y < e.y1; y++) {
      for (let x = e.x0; x <= e.x1; x++) out[y][x] = CREAM
    }
    for (let x = e.x0; x <= e.x1; x++) out[e.y1][x] = DARK
  }
  return out
}
// 水平翻转（走路左右迈腿用；角色本身对称，翻过来不会"左右不是同一只狗"）
function flipX(g) {
  return g.map((r) => r.slice().reverse())
}
// 垂直翻转：翻肚皮（四脚朝天）
function flipY(g) {
  return g.slice().reverse().map((r) => r.slice())
}
// 底部 k 行横向平移：迈腿
function stepLegs(g, dx, rows) {
  const out = clone(g)
  for (let y = N - rows; y < N; y++) {
    const row = g[y]
    const next = new Array(N).fill('.')
    for (let x = 0; x < N; x++) {
      const sx = x - dx
      if (sx < 0 || sx >= N) continue
      next[x] = row[sx]
    }
    out[y] = next
  }
  return out
}

// ---------- 姿势表 ----------
// 头区：0..12；腿区：底部 4 行。所有平移都按「整行」走，边缘不会被拉花。
const frames = {}
frames.stand = clone(base)
// 呼吸：头与上半身抬起 1px，第 12 行复制补缝（脖子被拉长 1px，像素不糊）
frames.breathe = (() => {
  const g = clone(base)
  for (let y = 12; y >= 1; y--) g[y] = base[y - 1].slice()
  g[0] = new Array(N).fill('.')
  return g
})()
// 走路 4 帧：迈腿 × 左右 + 身体 1px 起伏（走起来靠代码按 4 帧循环）
frames.walk1 = stepLegs(base, 1, 4)
frames.walk2 = moveAll(stepLegs(base, 1, 4), -1)
frames.walk3 = stepLegs(base, -1, 4)
frames.walk4 = moveAll(stepLegs(base, -1, 4), -1)
// 闭眼必须在**原始坐标**里做，再做压姿势 —— 否则眼框会跟着整帧下沉而对不上（踩过一次）
const closed = closeEyes(base)
// 坐 / 趴：去掉底部 2 行腿部并整体下沉，身子贴地
frames.sit = sitDown(base, 2)
frames.rest = sitDown(closed, 2)
// 睡：再垂头 2px（头陷进肩膀）
frames.sleep = shiftRows(frames.rest, 2, 0, 12)
// 眨眼 / 开心（玩耍时用）：站立闭眼
frames.happy = closed
// 搞怪：翻肚皮（垂直翻转后往下一格，露出肚皮）
frames.goofy = moveAll(flipY(closed), 1)
// 搞怪第二帧：左右轻晃（翻过来以后再翻回去会闪，用水平翻转做微晃）
frames.goofy2 = flipX(frames.goofy)

// ---------- 打哈欠（只改嘴与眼，身形不动）----------
// 原 19 色里没有偏红的值；嘴腔单独补第 20 色（只有这张帧用到，其它帧的色板不变）
const MOUTH_RED = '#B0453A'
const RED = 'j' // 调色板第 20 位（0-9 a-i 之后的 j）
// k=1 半张 / k=2 大张
function mouthOpen(g, k) {
  const out = clone(g)
  if (k === 1) {
    for (let x = 12; x <= 15; x++) out[12][x] = DARK
    out[13][13] = RED
    out[13][14] = RED
    return out
  }
  for (let x = 12; x <= 15; x++) out[12][x] = DARK
  out[13][11] = DARK
  for (let x = 12; x <= 15; x++) out[13][x] = RED
  out[13][16] = DARK
  out[14][12] = DARK
  out[14][13] = 'b' // 舌头（#F0D0C0，原色板里就有）
  out[14][14] = 'b'
  out[14][15] = DARK
  return out
}
// 头（0..14 行）整体上抬 1px：g[y+1] → out[y]，末行复制原第 14 行补缝，避免身体断开
function headUp(g) {
  const out = clone(g)
  for (let y = 0; y <= 14; y++) out[y] = (y + 1 <= 14 ? g[y + 1] : g[14]).slice()
  return out
}
// 头压低 1px（冲撞/发怒时压肩）：g[y-1] → out[y]，第 0 行保持空
function headDown(g) {
  const out = clone(g)
  for (let y = 14; y >= 1; y--) out[y] = g[y - 1].slice()
  out[0] = new Array(N).fill('.')
  return out
}
frames.yawn1 = mouthOpen(closed, 1)
frames.yawn2 = headUp(mouthOpen(closed, 2))

// ---------- 生气（只加眉毛 + 张嘴，不动身形）----------
// 24 格上"凶"只靠两笔斜眉：外高内低，压到眼睛上方一格
// "生气"照用户给的参考：**嘴角向下**的小撇嘴（不是龇牙）。
// 24 格上只有 2 行可用，画成"中间高、两角低"就是向下撇：
//   row12  .####.   ← 上唇中间
//   row13  #....#   ← 两角下沉
function frown(g) {
  const out = clone(g)
  // 中间 2 格抬高、两角各下沉 1 格 = 小撇嘴（参考图里就是这种"浅 ︵"）
  out[12][13] = DARK
  out[12][14] = DARK
  out[13][12] = DARK
  out[13][15] = DARK
  return out
}
frames.angry = frown(base) // 普攻前冲：撇嘴
frames.angry2 = frown(headDown(base)) // 施放命中：撇嘴 + 头压低 1px（冲撞感）

// ---------- 写 webview 数据 ----------
const payload = {
  w: N,
  h: N,
  palette: PIXEL_DATA.player.palette.concat([MOUTH_RED]),
  frames,
}
const js =
  "'use strict'\n" +
  '// actor-frames.js — 小屋角色动画帧（构建期由 tools/actor-frames.mjs 生成，请勿手改）\n' +
  '// 源：plugins/nibble/hooks/pixels.js 的 player（身体）+ 整行平移推导出的姿势（动作）\n' +
  'window.NibbleActorFrames = ' +
  JSON.stringify(payload) +
  '\n'
fs.writeFileSync(OUT_JS, js)

// ---------- 样张（8x，深底，按顺序排一行） ----------
const ORDER = ['stand', 'breathe', 'walk1', 'walk2', 'walk3', 'walk4', 'sit', 'rest', 'sleep', 'happy', 'goofy', 'goofy2', 'yawn1', 'yawn2', 'angry', 'angry2']
// 只看某一帧的细节：ACTOR_FRAME=rest node tools/actor-frames.mjs 24
const ONLY = process.env.ACTOR_FRAME || ''
const ORDER_OUT = ONLY && frames[ONLY] ? [ONLY] : ORDER
// 样张放大倍数可用参数覆盖：node tools/actor-frames.mjs 24 → 看细节用
const S = Math.max(4, Number(process.argv[2]) || 14)
const GAP = 10
const COLS = Math.min(4, ORDER_OUT.length)
const ROWS_N = Math.ceil(ORDER_OUT.length / COLS)
const W = COLS * (N * S + GAP) + GAP
const H = ROWS_N * (N * S + GAP) + GAP
const png = new PNG({ width: W, height: H })
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4
    png.data[o] = 26
    png.data[o + 1] = 21
    png.data[o + 2] = 17
    png.data[o + 3] = 255
  }
}
ORDER_OUT.forEach((name, i) => {
  const g = frames[name]
  const ox = GAP + (i % COLS) * (N * S + GAP)
  const oy0 = GAP + Math.floor(i / COLS) * (N * S + GAP)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const ch = g[y][x]
      if (!ch || ch === '.') continue
      const c = rgb(payload.palette[parseInt(ch, 36)])
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const px = ox + x * S + dx
          const py = oy0 + y * S + dy
          const o = (py * W + px) * 4
          png.data[o] = c[0]
          png.data[o + 1] = c[1]
          png.data[o + 2] = c[2]
          png.data[o + 3] = 255
        }
      }
    }
  }
})
fs.mkdirSync(path.dirname(OUT_PREVIEW), { recursive: true })
fs.writeFileSync(OUT_PREVIEW, PNG.sync.write(png))
console.log('✓ actor-frames.js（' + ORDER.length + ' 帧）')
console.log('✓ 样张: ' + path.relative(root, OUT_PREVIEW))
console.log('  顺序: ' + ORDER_OUT.join(' / '))
