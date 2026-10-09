#!/usr/bin/env node
'use strict'
// pack-vsce.js — 用**官方 vsce** 打包（规范 VSIX）
//
// 为什么要有这条路：自写的离线打包器（tools/make-vsix.js）体积小、不联网，但一旦 vsixmanifest 少了
// Open VSX 需要的 Assets（Icons.Default / Content.Details / Content.License）与 Icon/Categories 字段，
// 发布会直接被服务端以 406 Not Acceptable 拒绝。发布用官方 vsce 最稳。
//
// 要求 Node >= 20（vsce/ovsx 的限制）。若本机默认 Node 是 16，可用 VSCE_NODE 指定一个 Node ≥20 的可执行文件。
//   node tools/pack-vsce.js
//   VSCE_NODE="C:/path/to/node20/npx.cmd" node tools/pack-vsce.js
//
// 用法（推荐）: npm run package:official

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const extDir = path.join(root, 'vscode-extension')
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'))
const outFile = path.join(root, 'dist', `${pkg.name}-${pkg.version}.vsix`)
const version = 'v' + process.versions.node

const isWin = process.platform === 'win32'
// 优先用「与当前 Node 同一个目录」的 npx，避免 PATH 上的旧 Node 把 vsce 跑挂
const npxCmd =
  process.env.VSCE_NODE ||
  (() => {
    const local = path.join(path.dirname(process.execPath), isWin ? 'npx.cmd' : 'npx')
    return fs.existsSync(local) ? local : isWin ? 'npx.cmd' : 'npx'
  })()
const args = [
  '--yes',
  '@vscode/vsce@latest',
  'package',
  '--allow-missing-repository',
  '--no-dependencies',
  '--out',
  outFile,
]

// dist/ 是 gitignore 的，全新克隆里不存在；vsce 不会自动建目录，会直接 ENOENT
fs.mkdirSync(path.dirname(outFile), { recursive: true })

console.log('📦 用官方 vsce 打包（Node ' + version + '）…')
const r = spawnSync(npxCmd, args, { cwd: extDir, stdio: 'inherit', shell: isWin })
if (r.error) {
  console.error('❌ 无法执行 ' + npxCmd + ': ' + r.error.message)
  console.error('   如果本机默认 Node < 20，请设置 VSCE_NODE 指向 Node 20+ 的 npx，例如：')
  console.error('   VSCE_NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/npx.cmd" npm run package:official')
  process.exit(1)
}
if (r.status !== 0) {
  console.error('❌ vsce 打包失败（exit ' + r.status + '）')
  process.exit(r.status || 1)
}
console.log('✅ 已产出 ' + outFile)
