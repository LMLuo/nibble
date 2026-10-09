#!/usr/bin/env node
'use strict'
// make-icon.js — 把 icon-src/ 里的 AI 生成图缩放成 128x128 的扩展图标（最近邻，保持像素感）
// 依赖 pngjs（本仓库 devDependency，仅构建期使用；缺了就 npm i -D pngjs）
// 用法: node tools/make-icon.js

const fs = require('fs')
const path = require('path')

let PNG
try {
  PNG = require('pngjs').PNG
} catch {
  console.error('❌ 缺少构建期依赖 pngjs，请先执行：npm i -D pngjs')
  process.exit(1)
}

const SIZE = 128
const srcDir = path.resolve(__dirname, '..', 'vscode-extension', 'icon-src')
const outFile = path.resolve(__dirname, '..', 'vscode-extension', 'icon.png')

const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
if (!files.length) {
  console.error('❌ icon-src/ 里没有 PNG')
  process.exit(1)
}
const srcFile = path.join(srcDir, files[files.length - 1])
const src = PNG.sync.read(fs.readFileSync(srcFile))
console.log('源图: ' + files[files.length - 1] + ' (' + src.width + 'x' + src.height + ')')

// 居中裁剪成正方形后最近邻缩放到 128
const side = Math.min(src.width, src.height)
const ox = Math.floor((src.width - side) / 2)
const oy = Math.floor((src.height - side) / 2)
const dst = new PNG({ width: SIZE, height: SIZE })
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const sx = ox + Math.floor((x * side) / SIZE)
    const sy = oy + Math.floor((y * side) / SIZE)
    const si = (sy * src.width + sx) * 4
    const di = (y * SIZE + x) * 4
    dst.data[di] = src.data[si]
    dst.data[di + 1] = src.data[si + 1]
    dst.data[di + 2] = src.data[si + 2]
    dst.data[di + 3] = 255
  }
}
fs.writeFileSync(outFile, PNG.sync.write(dst))
console.log('✅ 已生成 ' + outFile + ' (' + SIZE + 'x' + SIZE + ')')
