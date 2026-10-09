#!/usr/bin/env node
'use strict'
// nibble-mcp — 把 Nibble 小生物暴露为 MCP 工具（stdio / JSON-RPC 2.0 / 零第三方依赖）
//
// 为什么用 MCP：CodeBuddy **IDE** 会执行 hooks，但不渲染 hook 的 systemMessage 与 statusLine
// （那两项是 CodeBuddy Code 终端版的能力）。MCP 工具输出在 IDE 对话里 **必然可见**，因此这里
// 用 MCP 作为渲染通道。状态与 hooks 版共用同一份存档：${CODEBUDDY_PLUGIN_DATA}/save.json

const readline = require('readline')
const sp = require('../plugins/nibble/hooks/nibble')

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'nibble', version: '0.1.0' }

const TOOLS = [
  {
    name: 'nibble_status',
    description:
      '查看 Nibble 陪伴小生物的状态：像素头像 + 等级/经验 + 野生敌人 HP。仅用于展示游戏状态，不读取任何项目内容。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'nibble_attack',
    description:
      '让 Nibble 攻击一次野生敌人并返回一行战斗日志与迷你战场。用作“每次用户提问就攻击一次”的战斗节拍。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'nibble_card',
    description: '显示 Nibble 完整 24x24 像素战场卡片（玩家 ⚔ 野生敌人，含等级/经验/战绩）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'nibble_reset',
    description: '重置 Nibble 的等级/经验/战绩与当前敌人，重新开始。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const fence = (s) => '```\n' + s + '\n```'
const textResult = (s) => ({ content: [{ type: 'text', text: s }] })

function callTool(name) {
  const s = sp.loadSave()
  switch (name) {
    case 'nibble_status':
      return textResult(fence(sp.panel()))
    case 'nibble_attack':
      sp.attack(s)
      sp.saveSave()
      return textResult(fence(sp.panel()))
    case 'nibble_card':
      return textResult(sp.card())
    case 'nibble_reset':
      sp.reset()
      return textResult(fence(sp.panel()))
    default:
      throw new Error('未知工具: ' + name)
  }
}

function handle(msg) {
  const { id, method, params } = msg
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = params && params.name
      try {
        return reply(callTool(name))
      } catch (err) {
        return reply({ content: [{ type: 'text', text: '❌ ' + err.message }], isError: true })
      }
    }
    default:
      return id !== undefined ? fail(-32601, 'Method not found: ' + method) : undefined
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  try {
    handle(msg)
  } catch (err) {
    if (msg && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } })
    }
  }
})
