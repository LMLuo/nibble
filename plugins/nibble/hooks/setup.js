#!/usr/bin/env node
'use strict'
// setup.js — 把 statusLine 写入 ~/.codebuddy/settings.json（保留其它已有设置）
// 由 /nibble:nibble-setup 命令调用。

const fs = require('fs')
const os = require('os')
const path = require('path')

const root = process.env.CODEBUDDY_PLUGIN_ROOT || path.resolve(__dirname, '..')
const script = path.join(root, 'hooks', 'statusline.js').replace(/\\/g, '/')
const settingsPath = path.join(os.homedir(), '.codebuddy', 'settings.json')

let json = {}
try {
  json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  if (!json || typeof json !== 'object') json = {}
} catch { /* 文件不存在或损坏 → 新建 */ }

json.statusLine = { type: 'command', command: `node "${script}"` }

try {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n', 'utf8')
  console.log('✅ 已写入 statusLine 配置到：' + settingsPath)
  console.log('   command = ' + json.statusLine.command)
  console.log('')
  console.log('若状态栏未立即刷新：重启 CodeBuddy，或运行 /statusline 检查当前配置。')
} catch (err) {
  console.log('❌ 写入失败：' + err.message)
  console.log('请手动在 ' + settingsPath + ' 中加入：')
  console.log('  "statusLine": { "type": "command", "command": "node \\"' + script + '\\"" }')
}
