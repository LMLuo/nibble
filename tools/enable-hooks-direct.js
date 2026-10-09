#!/usr/bin/env node
'use strict'
// enable-hooks-direct.js — 绕开插件市场，把 hooks / statusLine / 命令直接装到 CodeBuddy 用户级配置
// （IDE 不认 extraKnownMarketplaces，故改用官方文档的「用户级 hooks」方式）
//
// 用法: node tools/enable-hooks-direct.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const marketRoot = path.resolve(__dirname, '..')
const cliJs = path.join(marketRoot, 'plugins', 'nibble', 'hooks', 'cli.js').replace(/\\/g, '/')
const statusJs = path.join(marketRoot, 'plugins', 'nibble', 'hooks', 'statusline.js').replace(/\\/g, '/')

const home = os.homedir()
const settingsPath = path.join(home, '.codebuddy', 'settings.json')
const commandsDir = path.join(home, '.codebuddy', 'commands')

// ---- 1. 备份并读取 ----
let settings = {}
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8')
  const backup = settingsPath + '.bak-' + Date.now()
  fs.writeFileSync(backup, raw, 'utf8')
  console.log('🗄️  已备份 → ' + backup)
  try { settings = JSON.parse(raw) || {} } catch { settings = {} }
}

// ---- 2. 摘掉没生效的插件市场路线，避免以后双份执行 ----
if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces['nibble-cb']
if (settings.enabledPlugins) delete settings.enabledPlugins['nibble@nibble-cb']

// ---- 3. 追加用户级 hooks（按事件追加 + 去重，不动已有 hook）----
const cmd = (mode) => `node "${cliJs}" ${mode}`
const want = {
  SessionStart: { matcher: 'startup|resume|clear|compact', mode: 'sessionStart' },
  UserPromptSubmit: { matcher: null, mode: 'prompt' },
  SessionEnd: { matcher: null, mode: 'sessionEnd' },
}

settings.hooks = settings.hooks || {}
for (const [event, cfg] of Object.entries(want)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
  const already = JSON.stringify(list).includes(cmd(cfg.mode))
  if (!already) {
    const entry = { hooks: [{ type: 'command', command: cmd(cfg.mode), timeout: 10 }] }
    if (cfg.matcher) entry.matcher = cfg.matcher
    list.push(entry)
    console.log(`➕ hooks.${event} → ${cmd(cfg.mode)}`)
  } else {
    console.log(`↩︎ hooks.${event} 已存在，跳过`)
  }
  settings.hooks[event] = list
}

// ---- 4. 状态栏 ----
settings.statusLine = { type: 'command', command: `node "${statusJs}"` }
console.log('➕ statusLine → ' + settings.statusLine.command)

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
console.log('✅ 已写入 ' + settingsPath)

// ---- 5. 用户级 /nibble 命令（用户级命令无法用 ${CODEBUDDY_PLUGIN_ROOT}，故写绝对路径）----
const md = `---
description: Nibble 小生物：查看状态 / attack 补刀 / reset 重置
argument-hint: [attack|reset]
allowed-tools: Bash(node:*)
---

请把下面的状态面板**原样**输出给用户：保持代码块格式，**不要改动任何字符**，不要补充解释或额外建议。

!\`node "${cliJs}" do $1\`

（若上面为空或报错，说明 hook/命令未生效，请确认 node 在 PATH 中，并检查 /hooks 面板。）
`
fs.mkdirSync(commandsDir, { recursive: true })
fs.writeFileSync(path.join(commandsDir, 'nibble.md'), md, 'utf8')
console.log('✅ 已写入命令 ' + path.join(commandsDir, 'nibble.md'))
console.log('')
console.log('👉 重启 CodeBuddy 后：状态栏出现像素小生物；提问弹出一行战斗日志；输入 /nibble 看完整战场卡片。')
