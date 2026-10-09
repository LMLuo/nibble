#!/usr/bin/env node
'use strict'
// probe-bundle.js — 在压缩后的 bundle 里定位某个关键字的上下文（诊断用）
// 用法: node tools/probe-bundle.js <关键字> [最多命中数]

const fs = require('fs')

const needle = process.argv[2] || 'builtinExtensionsOnly'
const max = Number(process.argv[3]) || 5
const files = [
  'D:/CodeBuddy CN/resources/app/out/vs/workbench/workbench.desktop.main.js',
  'D:/CodeBuddy CN/resources/app/out/main.js',
  'D:/CodeBuddy CN/resources/app/out/codebuddy/main.js',
]

for (const file of files) {
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  let i = src.indexOf(needle)
  let n = 0
  while (i >= 0 && n < max) {
    n++
    console.log('=== ' + file.replace('D:/CodeBuddy CN/resources/app/out/', '') + ' #' + n + ' ===')
    console.log(src.slice(Math.max(0, i - 340), i + 340).replace(/\s+/g, ' '))
    console.log('')
    i = src.indexOf(needle, i + 1)
  }
}
