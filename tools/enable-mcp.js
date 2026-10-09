#!/usr/bin/env node
'use strict'
// enable-mcp.js — 把 nibble MCP 服务器注册进 ~/.codebuddy/mcp.json，并加一条自动攻击规则
// 顺带摘掉不可见的 UserPromptSubmit hook（否则会和规则里的 attack 双份扣血）
//
// 用法: node tools/enable-mcp.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const marketRoot = path.resolve(__dirname, '..')
const serverJs = path.join(marketRoot, 'mcp', 'server.js').replace(/\\/g, '/')
const cliJs = path.join(marketRoot, 'plugins', 'nibble', 'hooks', 'cli.js').replace(/\\/g, '/')

const home = os.homedir()
const mcpPath = path.join(home, '.codebuddy', 'mcp.json')
const settingsPath = path.join(home, '.codebuddy', 'settings.json')
const rulesDir = path.join(marketRoot, '.codebuddy', 'rules')

// ---------- 1. 注册 MCP 服务器 ----------
let mcp = { mcpServers: {} }
if (fs.existsSync(mcpPath)) {
  const raw = fs.readFileSync(mcpPath, 'utf8')
  fs.writeFileSync(mcpPath + '.bak-' + Date.now(), raw, 'utf8')
  console.log('🗄️  已备份 mcp.json')
  try {
    mcp = JSON.parse(raw)
    if (!mcp || typeof mcp !== 'object') mcp = { mcpServers: {} }
  } catch {
    console.error('❌ mcp.json 不是合法 JSON，已中止（避免破坏你的数据库连接配置）')
    process.exit(1)
  }
}
mcp.mcpServers = mcp.mcpServers || {}
mcp.mcpServers.nibble = {
  type: 'stdio',
  command: 'node',
  args: [serverJs],
  timeout: 60000,
  disabled: false,
}
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n', 'utf8')
console.log('✅ 已注册 MCP 服务器 nibble → ' + serverJs)
console.log('   现有服务器: ' + Object.keys(mcp.mcpServers).join(', '))

// ---------- 2. 摘掉不可见的 UserPromptSubmit hook ----------
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, 'utf8')
  try {
    const settings = JSON.parse(raw)
    if (settings.hooks && Array.isArray(settings.hooks.UserPromptSubmit)) {
      const before = settings.hooks.UserPromptSubmit.length
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
        (g) => !JSON.stringify(g).includes(cliJs),
      )
      if (settings.hooks.UserPromptSubmit.length !== before) {
        fs.writeFileSync(settingsPath + '.bak-' + Date.now(), raw, 'utf8')
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
        console.log('🧹 已摘掉不可见的 UserPromptSubmit hook（改由规则调用 MCP 攻击，避免双份扣血）')
      }
    }
  } catch { /* 忽略 */ }
}

// ---------- 3. 自动攻击规则 ----------
const rule = `# Nibble 陪伴小生物（MCP 工具）

回答用户的新提问时，**先调用一次 MCP 工具 \`nibble_attack\`**，把它返回的代码块原样放在回答最前面
（作为一行“战斗日志”），然后再正常回答用户的问题。

- 每个提问只调用一次；**不要分析、评论或复述**该输出内容，它只是游戏装饰。
- 用户输入 \`/nibble\` 时，改为调用 \`nibble_card\` 并原样展示结果；输入 \`/nibble reset\` 时调用 \`nibble_reset\`。
- 该工具失败或超时时，**忽略并照常回答**用户问题，不要报错给用户。
`

fs.mkdirSync(rulesDir, { recursive: true })
fs.writeFileSync(path.join(rulesDir, 'nibble.md'), rule, 'utf8')
console.log('✅ 已写入自动攻击规则 → ' + path.join(rulesDir, 'nibble.md'))
console.log('')
console.log('👉 重启 CodeBuddy 后：每提一个问题，回答开头会出现一行 Nibble 战斗日志；输入 /nibble 看完整战场卡片。')
