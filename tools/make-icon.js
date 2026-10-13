#!/usr/bin/env node
'use strict'
// make-icon.js — 生成扩展图标（VS Code / 插件市场用）
//
// 用法: node tools/make-icon.js
// 输出: vscode-extension/icon.png（128×128，package.json 的 "icon" 指向它）
//
// 图标 = **主角像素**（plugins/nibble/hooks 里的真实素材，24 格）整数倍放大后居中在暖暗底上。
// 整数倍是硬要求：非整数倍会把像素格拉成大小不一的方块，一眼就假 —— 12 格的武器素材也是同理。
// 24 × 4 = 96 → 四周各留 16px（12.5%），是应用图标常见的留白比例。
//
// 注：此前的做法是拿 icon-src/ 里 AI 生成的图缩放下采样，会糊；那条路已弃用，
// icon-src/ 仅作为历史源图保留，不再参与构建。

const fs = require('fs')
const path = require('path')

let PNG
try {
  PNG = require('pngjs').PNG
} catch {
  console.error('❌ 缺少构建期依赖 pngjs，请先执行：npm i -D pngjs')
  process.exit(1)
}

const root = path.resolve(__dirname, '..')
const outFile = path.join(root, 'vscode-extension', 'icon.png')
const sp = require(path.join(root, 'plugins', 'nibble', 'hooks', 'nibble.js'))

const SIZE = 128
const ZOOM = 4 // 主角实际占 20×22 格 → 80×88px，占画布 62%×69%（应用图标常见的图形占比）
const BG = [0x17, 0x12, 0x10] // 与面板底色同一个暖暗值

const { grid } = sp.decodeGrid('player')

// 素材在 24×24 里未必顶格，按真实的非空像素范围居中最稳
let x0 = grid[0].length
let y0 = grid.length
let x1 = -1
let y1 = -1
for (let y = 0; y < grid.length; y++) {
  for (let x = 0; x < grid[y].length; x++) {
    if (!grid[y][x]) continue
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
}
if (x1 < 0) {
  console.error('❌ 主角像素数据是空的')
  process.exit(1)
}

const w = (x1 - x0 + 1) * ZOOM
const h = (y1 - y0 + 1) * ZOOM
const ox = Math.round((SIZE - w) / 2)
const oy = Math.round((SIZE - h) / 2)

// 背景：暖暗底 + 四档量化的中心暖光。
// 量化（而不是平滑渐变）是为了跟像素风一致 —— 放大后能看到硬边的同心环，不是糊的。
const GLOW = [226, 160, 96] // 与面板顶部光晕同一个暖橙
const dst = new PNG({ width: SIZE, height: SIZE })
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = (x + 0.5 - SIZE / 2) / (SIZE / 2)
    const dy = (y + 0.5 - SIZE / 2) / (SIZE / 2)
    const d = Math.sqrt(dx * dx + dy * dy)
    const step = d < 0.32 ? 3 : d < 0.58 ? 2 : d < 0.82 ? 1 : 0
    const k = step * 0.035
    const di = (y * SIZE + x) * 4
    dst.data[di] = Math.round(BG[0] + (GLOW[0] - BG[0]) * k)
    dst.data[di + 1] = Math.round(BG[1] + (GLOW[1] - BG[1]) * k)
    dst.data[di + 2] = Math.round(BG[2] + (GLOW[2] - BG[2]) * k)
    dst.data[di + 3] = 255
  }
}

// 地平线：主角脚底那一条横带。它让主角"站住"而不是浮着 ——
// 战斗页的构图骨架（角色站在水平地面上）缩到图标里就是这一条。
const gy = oy + h
const gh = Math.max(2, Math.round(SIZE / 32))
for (let y = gy; y < gy + gh && y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const di = (y * SIZE + x) * 4
    dst.data[di] = 0x3f
    dst.data[di + 1] = 0x30
    dst.data[di + 2] = 0x26
    dst.data[di + 3] = 255
  }
}

let painted = 0
for (let y = y0; y <= y1; y++) {
  for (let x = x0; x <= x1; x++) {
    const c = rgb(grid[y] && grid[y][x])
    if (!c) continue
    painted++
    // 一个逻辑像素铺满 ZOOM×ZOOM 个设备像素 —— 这是像素素材放大后不糊的唯一做法
    for (let dy = 0; dy < ZOOM; dy++) {
      for (let dx = 0; dx < ZOOM; dx++) {
        const px = ox + (x - x0) * ZOOM + dx
        const py = oy + (y - y0) * ZOOM + dy
        if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue
        const di = (py * SIZE + px) * 4
        dst.data[di] = c[0]
        dst.data[di + 1] = c[1]
        dst.data[di + 2] = c[2]
        dst.data[di + 3] = 255
      }
    }
  }
}

fs.writeFileSync(outFile, PNG.sync.write(dst))
console.log('✅ 已生成 ' + outFile)
console.log(
  '   画布 ' + SIZE + '×' + SIZE +
  ' · 主角 ' + (x1 - x0 + 1) + '×' + (y1 - y0 + 1) + ' 格 → ' + w + '×' + h + 'px' +
  '（放大 ' + ZOOM + ' 倍）· 实心 ' + painted + ' 格',
)

function rgb(c) {
  if (!c) return null
  if (Array.isArray(c)) return c
  const s = String(c).replace('#', '')
  const v = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16)
  if (Number.isNaN(v)) return null
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
