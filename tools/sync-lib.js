#!/usr/bin/env node
'use strict'
// sync-lib.js — 把插件里的「像素素材 + 渲染逻辑」同步进扩展的 lib/，让发布版自包含
// （lib/ 是构建产物，不入库；CI 与本地打包前都会跑这一步）
// 用法: node tools/sync-lib.js

const fs = require('fs')
const path = require('path')

const marketRoot = path.resolve(__dirname, '..')
const srcDir = path.join(marketRoot, 'plugins', 'nibble', 'hooks')
const libDir = path.join(marketRoot, 'vscode-extension', 'lib')
const FILES = ['pixels.js', 'nibble.js', 'weapons.js', 'weapons-pixels.js', 'weapons-stories.js']

function sync() {
  fs.mkdirSync(libDir, { recursive: true })
  for (const f of FILES) {
    const from = path.join(srcDir, f)
    if (!fs.existsSync(from)) throw new Error('缺少源文件: ' + from)
    fs.copyFileSync(from, path.join(libDir, f))
  }
  return FILES
}

if (require.main === module) {
  const copied = sync()
  console.log('📦 已同步 vscode-extension/lib/ ← ' + copied.join(', '))
}

module.exports = sync
