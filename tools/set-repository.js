#!/usr/bin/env node
'use strict'
// set-repository.js — 把 vscode-extension/package.json 的 repository 指向当前仓库
//
// 为什么需要它：本地开发时没有仓库，写死占位符会在发布时把错误信息带上市场页（也容易被 CI 守卫拦下）。
// 让 CI 在打包前根据 GITHUB_REPOSITORY 自动注入，本地 package.json 保持干净、无需维护。
//
// 用法：
//   node tools/set-repository.js                 # CI 里用 GITHUB_REPOSITORY=owner/repo
//   node tools/set-repository.js LMLuo/nibble    # 手动指定

const fs = require('fs')
const path = require('path')

const repo = process.argv[2] || process.env.GITHUB_REPOSITORY
if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
  console.error('❌ 需要 owner/repo 参数，或设置 GITHUB_REPOSITORY 环境变量')
  process.exit(1)
}

const file = path.resolve(__dirname, '..', 'vscode-extension', 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.repository = { type: 'git', url: 'https://github.com/' + repo + '.git' }
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('✅ repository → ' + pkg.repository.url + '（仅改工作区副本，不会提交）')
