#!/usr/bin/env node
'use strict'
// statusline.js — 状态栏渲染：像素小生物（逐帧动画）+ 等级 + HP 条 + 野生敌人
// 由 settings.json 的 statusLine.command 调用；CodeBuddy 会把会话 JSON 从 stdin 传入，本脚本不读取其内容。

const sp = require('./nibble')

let done = false
const finish = () => {
  if (done) return
  done = true
  try { process.stdout.write(sp.statusLine()) } catch { /* 出错就输出空串，别影响状态栏 */ }
  process.exit(0)
}

if (process.stdin.isTTY) {
  finish()
} else {
  process.stdin.on('data', () => {})
  process.stdin.on('end', finish)
  process.stdin.on('error', finish)
  setTimeout(finish, 1200)
}
