#!/usr/bin/env node
/**
 * cleanup-experiments.js —— 清理"试通道"阶段留下的实验性配置
 *
 * 背景：为了让像素小生物在 GUI IDE 里可见，先后试过三条路（用户级 hooks、
 * statusLine、MCP 服务器 + 项目规则）。扩展（常驻 UI）落地后，其中一部分成了
 * 冗余甚至有害（MCP 每轮耗 token；项目规则会让模型每轮多调一次工具）。
 *
 * 本脚本：保留游戏真正的驱动器（提问即攻击的 hooks），清掉其余实验残留。
 *
 * 做三件事：
 *   1) settings.json：删 statusLine（IDE 不渲染，扩展已接管状态栏）；
 *      并把 UserPromptSubmit 补回 cli.js prompt（否则宠物不会动）。
 *   2) mcp.json：删掉实验用的 nibble MCP 服务器（其他服务器一律不动）。
 *   3) 删除实验残留：用户级 /nibble 命令、项目规则、更名前的旧存档。
 *
 * 所有改动前都会备份；存档 plugins/data/nibble 与仓库源码不动。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
const CB = path.join(HOME, '.codebuddy')
const WORKSPACE = path.resolve(__dirname, '..', '..') // 工作区根目录（nibble-cb 的上级）
const TS = Date.now()
const MARK = 'nibble-cb' // 只清理指向本项目工作区的条目，绝不误伤用户自己的配置

const log = (s) => console.log(s)
const done = []
const kept = []

function backup(file) {
  if (!fs.existsSync(file)) return null
  const dst = `${file}.bak-cleanup-${TS}`
  if (fs.statSync(file).isDirectory()) {
    fs.cpSync(file, dst, { recursive: true }) // 目录要用 cpSync（copyFileSync 会 EPERM）
  } else {
    fs.copyFileSync(file, dst)
  }
  return dst
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

// 判断一条 hook 条目是否属于本项目的实验配置
function isOurs(entry) {
  const hs = (entry && entry.hooks) || []
  return hs.some((h) => typeof h.command === 'string' && h.command.includes(MARK))
}

// ============================ 1) settings.json ============================
function cleanSettings() {
  const file = path.join(CB, 'settings.json')
  const s = readJson(file)
  if (!s) {
    log('⚠ settings.json 读不到或格式异常，跳过')
    return
  }
  const bak = backup(file)
  log(`\n[1/3] settings.json（备份 → ${path.basename(bak || '(无)')}）`)

  // 1a. statusLine：指向本项目的才删
  if (s.statusLine && String(s.statusLine.command || '').includes(MARK)) {
    delete s.statusLine
    done.push('settings.json → 删除 statusLine（IDE 不渲染；状态栏已由扩展提供）')
  } else if (s.statusLine) {
    kept.push('settings.json → statusLine 未删（不是本项目配置）')
  } else {
    kept.push('settings.json → statusLine 已不存在（无需处理）')
  }

  // 1b. hooks：保留 SessionStart/SessionEnd（读/写存档），补回 UserPromptSubmit（攻击节拍）
  if (s.hooks && typeof s.hooks === 'object') {
    let cliCmd = null
    for (const ev of Object.keys(s.hooks)) {
      const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : []
      for (const entry of arr) {
        if (!isOurs(entry)) continue
        for (const h of entry.hooks || []) {
          if (typeof h.command === 'string' && /cli\.js/.test(h.command)) cliCmd = h.command
        }
      }
    }

    if (cliCmd) {
      const promptCmd = cliCmd.replace(/\b(sessionStart|sessionEnd|prompt)\b/, 'prompt')
      const cur = Array.isArray(s.hooks.UserPromptSubmit) ? s.hooks.UserPromptSubmit : []
      if (cur.some(isOurs)) {
        kept.push('settings.json → UserPromptSubmit 已存在，未改动')
      } else {
        cur.push({ hooks: [{ type: 'command', command: promptCmd, timeout: 10 }] })
        s.hooks.UserPromptSubmit = cur
        done.push('settings.json → 补回 UserPromptSubmit（提问即攻击，驱动战斗）')
      }
      kept.push('settings.json → 保留 SessionStart / SessionEnd（读/写存档）')
    } else {
      log('  ⚠ 未找到 cli.js 的 hook 命令，UserPromptSubmit 未补')
    }
  }

  writeJson(file, s)
  log('  ✓ 已写入')
}

// ============================ 2) mcp.json ============================
function cleanMcp() {
  const file = path.join(CB, 'mcp.json')
  const s = readJson(file)
  if (!s) {
    log('⚠ mcp.json 读不到或格式异常，跳过')
    return
  }
  const bak = backup(file)
  log(`\n[2/3] mcp.json（备份 → ${path.basename(bak || '(无)')}）`)
  const servers = s.mcpServers || {}
  const hit = Object.keys(servers).filter((k) => JSON.stringify(servers[k]).includes(MARK + '/mcp'))
  if (hit.length === 0) {
    kept.push('mcp.json → 没有本项目的 MCP 服务器')
    log('  ✓ 无需改动')
    return
  }
  for (const k of hit) {
    delete servers[k]
    done.push(`mcp.json → 删除 MCP 服务器 "${k}"（每轮耗 token）`)
  }
  const rest = Object.keys(servers)
  writeJson(file, s)
  log(`  ✓ 已写入；保留其他 ${rest.length} 个服务器：${rest.join(', ')}`)
  kept.push(`mcp.json → 保留 ${rest.length} 个无关服务器`)
}

// ============================ 3) 残留文件 ============================
function rm(file, label) {
  if (!fs.existsSync(file)) {
    log(`  - 不存在，跳过：${file}`)
    return
  }
  backup(file)
  fs.rmSync(file, { recursive: true, force: true })
  done.push(`${label} → 已删除（备份 ${path.basename(file)}.bak-cleanup-${TS}）`)
  log(`  ✓ 已删除并备份：${file}`)
}

function cleanFiles() {
  log('\n[3/3] 实验残留文件')
  // 用户级命令（扩展自带 nibble.* 命令，此为试通道时手写的）
  rm(path.join(CB, 'commands', 'nibble.md'), '用户级命令 /nibble')
  // 项目规则（"每次回答前先调 MCP"——MCP 删掉后它只会白耗 token）
  rm(path.join(WORKSPACE, '.codebuddy', 'rules', 'nibble.md'), '项目规则 .codebuddy/rules/nibble.md')
  // 更名前的旧存档（spinlings → nibble）
  rm(path.join(CB, 'plugins', 'data', 'spinlings'), '旧命名存档 plugins/data/spinlings')

  const live = path.join(CB, 'plugins', 'data', 'nibble', 'save.json')
  if (fs.existsSync(live)) {
    const s = readJson(live) || {}
    kept.push(`存档 plugins/data/nibble/save.json 保留（Lv${s.level || 1}，进度不丢）`)
    log(`  ✓ 保留存档：Lv${s.level || 1}`)
  }
}

// ============================ 主流程 ============================
function main() {
  log('=== Nibble 实验配置清理 ===')
  log(`项目根：${WORKSPACE}`)
  cleanSettings()
  cleanMcp()
  cleanFiles()

  log('\n=== 已清理 ===')
  done.forEach((d) => log('  ✓ ' + d))
  log('\n=== 已保留 ===')
  kept.forEach((k) => log('  · ' + k))
  log(`\n提示：所有被改/被删项都有 .bak-cleanup-${TS} 备份，可人工还原。`)
}

main()
