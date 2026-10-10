#!/usr/bin/env node
'use strict'
// cli.js — CodeBuddy 原生插件的统一入口
//
// 用法：
//   node cli.js sessionStart      # SessionStart  hook（stdin: 会话 JSON）
//   node cli.js prompt            # UserPromptSubmit hook —— 唯一攻击节拍
//   node cli.js sessionEnd        # SessionEnd    hook
//   node cli.js do [attack|reset]  # /nibble 命令用，打印状态卡片
//
// 隐私：**从不解析 stdin 里的 prompt / 文件 / 路径内容**，只是把 stdin 排空后按节拍推进战斗。
// 输出：hook 模式只向 stdout 打一行 JSON（systemMessage 仅用户可见，不进模型上下文 → 不耗 token）；
//       命令模式打印纯文本卡片。

const sp = require('./nibble')

function readStdin() {
  return new Promise((resolve) => {
    let done = false
    const finish = (buf) => { if (!done) { done = true; resolve(buf || '') } }
    if (process.stdin.isTTY) return finish('')
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buf += d })
    process.stdin.on('end', () => finish(buf))
    process.stdin.on('error', () => finish(buf))
    setTimeout(() => finish(buf), 1500) // 兜底：无 stdin 时不挂住
  })
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj))
const mode = process.argv[2] || 'prompt'

// ———————————————— 命令模式（/nibble）————————————————
if (mode === 'do') {
  const s = sp.loadSave()
  const sub = process.argv[3] || 'status'
  if (sub === 'attack') { sp.attack(s); sp.saveSave() }
  if (sub === 'reset') { sp.reset() }
  if (sub === 'arsenal') { process.stdout.write(sp.arsenalCard()); process.exit(0) }
  process.stdout.write(sp.card())
  process.exit(0)
}

// ———————————————— hook 模式 ————————————————
readStdin().then(() => {
  const s = sp.loadSave()
  if (mode === 'sessionStart') {
    sp.saveSave()
    emit({
      continue: true,
      suppressOutput: true,
      systemMessage:
        `🐾 Nibble 已就位 ｜ Lv ${s.level} ｜ 野生 ${sp.ENEMY_NAMES[s.enemy.type]}` +
        `（${sp.RARITY_LABEL[s.enemy.rarity]}）HP ${s.enemy.hp}/${s.enemy.maxHp}`,
    })
  } else if (mode === 'sessionEnd') {
    sp.saveSave()
    emit({ continue: true, suppressOutput: true })
  } else {
    const log = sp.attack(s) // 提问节拍 → 攻击一次
    sp.saveSave()
    emit({ continue: true, suppressOutput: true, systemMessage: '⚔ ' + log })
  }
  process.exit(0)
})
