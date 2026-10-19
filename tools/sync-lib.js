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
const FILES = [
  'pixels.js', 'nibble.js',
  'weapons.js', 'weapons-pixels.js', 'weapons-stories.js',
  'enemies.js', 'enemies-pixels.js', 'enemies-stories.js',
  'skills.js', 'skills-stories.js',
]
// 素材文件由构建期脚本生成（tools/skills-sprites.mjs）：尚未生成时跳过，不阻塞同步
// （skills.js 里 require 在 try/catch 内，缺素材时回落为空表，图鉴显示空图标）
const OPTIONAL_FILES = ['skills-pixels.js']

function sync() {
  fs.mkdirSync(libDir, { recursive: true })
  for (const f of FILES) {
    const from = path.join(srcDir, f)
    if (!fs.existsSync(from)) throw new Error('缺少源文件: ' + from)
    fs.copyFileSync(from, path.join(libDir, f))
  }
  const skipped = []
  for (const f of OPTIONAL_FILES) {
    const from = path.join(srcDir, f)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(libDir, f))
    else skipped.push(f)
  }
  return { copied: FILES, skipped }
}

if (require.main === module) {
  const r = sync()
  console.log('📦 已同步 vscode-extension/lib/ ← ' + r.copied.join(', '))
  if (r.skipped.length) console.log('⏭ 跳过未生成的素材文件（跑素材管线后会自动纳入）：' + r.skipped.join(', '))
}

module.exports = sync
