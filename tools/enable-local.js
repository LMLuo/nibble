#!/usr/bin/env node
'use strict'
// enable-local.js — 一键把本插件注册进 CodeBuddy 用户配置
// 等价于：/plugin marketplace add <dir> + /plugin install nibble@nibble-cb + 配好 statusLine
//
// 用法: node tools/enable-local.js
// 特性：写入前自动备份 settings.json；清单 JSON 会先校验；只增改这几个键，不动其它设置。

const fs = require('fs')
const os = require('os')
const path = require('path')

const marketRoot = path.resolve(__dirname, '..').replace(/\\/g, '/')
const pluginRoot = path.join(marketRoot, 'plugins', 'nibble')
const settingsPath = path.join(os.homedir(), '.codebuddy', 'settings.json')

// ---- 1. 校验清单 ----
const checks = [
  [path.join(marketRoot, '.codebuddy-plugin', 'marketplace.json'), '市场清单'],
  [path.join(pluginRoot, '.codebuddy-plugin', 'plugin.json'), '插件清单'],
  [path.join(pluginRoot, 'hooks', 'hooks.json'), 'hooks 配置'],
]
for (const [file, label] of checks) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'))
    console.log(`✅ ${label} JSON 合法: ${path.basename(file)}`)
  } catch (err) {
    console.error(`❌ ${label} 解析失败 (${file}): ${err.message}`)
    process.exit(1)
  }
}

// ---- 2. 备份并读取现有设置 ----
let settings = {}
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8')
  const backup = settingsPath + '.bak-' + Date.now()
  fs.writeFileSync(backup, raw, 'utf8')
  console.log('🗄️  已备份原设置 → ' + backup)
  try {
    settings = JSON.parse(raw)
    if (!settings || typeof settings !== 'object') settings = {}
  } catch {
    console.error('⚠️  原 settings.json 不是合法 JSON，已从空对象重建（备份仍保留）')
    settings = {}
  }
}

// ---- 3. 合并：本地市场 / 启用插件 / 状态栏 ----
settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {}
settings.extraKnownMarketplaces['nibble-cb'] = {
  source: { source: 'directory', path: marketRoot },
}

settings.enabledPlugins = settings.enabledPlugins || {}
settings.enabledPlugins['nibble@nibble-cb'] = true

settings.statusLine = {
  type: 'command',
  command: 'node "' + path.join(pluginRoot, 'hooks', 'statusline.js').replace(/\\/g, '/') + '"',
}

fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')

console.log('')
console.log('✅ 已写入 ' + settingsPath)
console.log('   市场   nibble-cb → ' + marketRoot)
console.log('   插件   nibble@nibble-cb → enabled')
console.log('   状态栏 ' + settings.statusLine.command)
console.log('')
console.log('👉 下一步：重启 CodeBuddy（或在会话里执行 /reload-plugins），状态栏就会出现像素小生物。')
console.log('   随后输入 /nibble:nibble 可查看完整战场卡片。')
