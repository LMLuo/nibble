#!/usr/bin/env node
// check-site.mjs —— 官网三条硬线的自检（体积 / 字体覆盖 / 降级规则），不需要浏览器
//
//   node tools/check-site.mjs           检查 _site/（没组装过就先跑 node tools/build-site.js）
//   node tools/check-site.mjs --rebase  把当前体积记成新基线（只在确认要放宽时用）
//
// 为什么要有它：官网的三条硬线（手机能滑不卡、单次改动 ≤+200KB、正文对比度 ≥7:1）只有第 2 条能
// 静态量；第 1、3 条要靠真浏览器实测（方法写在 site/README.md）。这个脚本负责把"能静态守住的部分"
// 变成一条命令，顺手把"降级规则还在不在"也断言掉——降级最容易被后来的人悄悄删掉。
//
// 退出码：0 = 全过；1 = 有 FAIL。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const OUT = path.join(ROOT, '_site')
const BASELINE = path.join(ROOT, 'tools', 'site-baseline.json')
const BUDGET_KB = 200

const fails = []
const warns = []
const ok = (msg) => console.log('  ✓ ' + msg)
const fail = (msg) => { fails.push(msg); console.log('  ✗ ' + msg) }
const warn = (msg) => { warns.push(msg); console.log('  ! ' + msg) }
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
const kb = (n) => Math.round(n / 1024)

console.log('\n【1/5】体积（硬线②：单次改动 ≤ +' + BUDGET_KB + 'KB）')
if (!fs.existsSync(OUT)) {
  fail('还没组装过 _site/：先跑 node tools/build-site.js')
} else {
  let total = 0
  const files = []
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name)
      const r = rel ? rel + '/' + name : name
      if (fs.statSync(abs).isDirectory()) { walk(abs, r); continue }
      const size = fs.statSync(abs).size
      total += size
      files.push([r, size])
    }
  }
  walk(OUT, '')
  files.sort((a, b) => b[1] - a[1])
  console.log('  _site/ 共 ' + files.length + ' 个文件 · ' + kb(total) + ' KB')
  console.log('  最大几个：' + files.slice(0, 4).map((f) => f[0] + ' ' + kb(f[1]) + 'KB').join(' / '))

  const rebase = process.argv.includes('--rebase')
  if (rebase || !fs.existsSync(BASELINE)) {
    fs.writeFileSync(
      BASELINE,
      JSON.stringify({ bytes: total, note: '基线：' + new Date().toISOString().slice(0, 10) + ' 官网组装产物总字节', files: files.length }, null, 2) + '\n',
      'utf8',
    )
    ok((rebase ? '已重设' : '首次记录') + '基线 ' + kb(total) + ' KB → tools/site-baseline.json')
  } else {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    const delta = total - base.bytes
    const line = '相对基线 ' + kb(base.bytes) + ' KB：' + (delta >= 0 ? '+' : '') + kb(delta) + ' KB'
    if (delta > BUDGET_KB * 1024) fail(line + ' —— 超出 ' + BUDGET_KB + 'KB 预算')
    else ok(line)
  }
}

console.log('\n【2/5】字体子集覆盖（缺字会静默回落系统字体）')
{
  const charset = read(path.join(SITE, 'fonts', 'charset.txt'))
  if (!charset) {
    fail('缺 site/fonts/charset.txt：先跑 npm run font')
  } else {
    const have = new Set(charset)
    const scanned = [
      [path.join(OUT, 'index.html'), '构建产物 index.html'],
      [path.join(OUT, 'demo-data.js'), '构建产物 demo-data.js'],
      [path.join(SITE, 'site.js'), '源码 site.js'],
      [path.join(SITE, 'site.css'), '源码 site.css'],
      [path.join(ROOT, 'tools', 'build-site.js'), '源码 build-site.js'],
    ]
    for (const [file, label] of scanned) {
      const text = read(file)
      if (!text) { warn('跳过（文件不存在）：' + label); continue }
      const missing = new Set()
      for (const ch of text) if (ch.codePointAt(0) >= 0x2000 && !have.has(ch)) missing.add(ch)
      if (missing.size) fail(label + ' 有 ' + missing.size + ' 个字不在子集里：' + [...missing].slice(0, 30).join('') + ' → 跑 npm run font')
      else ok(label + ' 无缺字')
    }
  }
}

console.log('\n【3/5】零外部请求（断网也要能看）')
{
  const targets = ['index.html', 'site.css', 'site.js', 'demo-data.js']
  let bad = 0
  for (const t of targets) {
    const text = read(path.join(OUT, t))
    if (!text) continue
    // 只查"要下载的东西"：src= / url(...) / @import / <link href=；页面里的 <a href> 是文案链接，不算
    const hits = [
      ...(text.match(/\b(?:src|srcset)\s*=\s*["']https?:[^"']+/gi) || []),
      ...(text.match(/url\(\s*["']?https?:[^)]+/gi) || []),
      ...(text.match(/@import\s+(?:url\()?["']https?:[^"')]+/gi) || []),
      ...(text.match(/<link[^>]+href\s*=\s*["']https?:[^"']+/gi) || []),
    ]
    if (hits.length) { bad += hits.length; fail(t + ' 里有 ' + hits.length + ' 个外部资源引用：' + hits[0].slice(0, 60)) }
  }
  if (!bad) ok('index/css/js/data 都没有外部资源引用')
}

console.log('\n【4/5】降级规则还在不在（硬线①：任何新动画都要带降级）')
{
  const css = read(path.join(SITE, 'site.css'))
  if (!css) fail('读不到 site/site.css')
  else {
    const need = [
      ['prefers-reduced-motion', /prefers-reduced-motion\s*:\s*reduce/],
      ['data-motion="reduce" 手动开关', /html\[data-motion="reduce"\]/],
      ['出视口冻结 [data-idle]', /\[data-idle\][^{]*\{[^}]*animation-play-state:\s*paused/],
      ['窄屏关粒子（≤640px）', /@media\s*\(max-width:\s*640px\)[\s\S]{0,600}?\.bg\s+\.fly/],
      ['字号令牌 --f1: 12px', /--f1:\s*12px/],
      ['天光令牌 --tod-tint', /--tod-tint:/],
    ]
    for (const [label, re] of need) {
      if (re.test(css)) ok(label + ' 在')
      else fail('CSS 里找不到：' + label)
    }
  }
  const js = read(path.join(SITE, 'site.js'))
  if (!js) fail('读不到 site/site.js')
  else {
    const need = [
      ['asleepIn()（自走定时器的暂停判据）', /function asleepIn\(/],
      ['buildIdle()（IntersectionObserver 挂 data-idle）', /function buildIdle\(/],
      ['buildTod()（滚动即一天）', /function buildTod\(/],
      ['节拍受 heroAwake() 门控', /heroAwake\(\)/],
    ]
    for (const [label, re] of need) {
      if (re.test(js)) ok(label + ' 在')
      else fail('site.js 里找不到：' + label)
    }
  }
}

console.log('\n【5/5】隐私口径（记忆点不许上报）')
{
  const js = read(path.join(SITE, 'site.js'))
  const bugPart = js ? js.slice(js.indexOf('把你今天遇到的 Bug 丢给它')) : ''
  // 只认"真的调用"：注释里提到这些词（例如"不写 localStorage"）不算
  const banned = [
    ['fetch(', /\bfetch\s*\(/],
    ['XMLHttpRequest', /new\s+XMLHttpRequest|XMLHttpRequest\s*\(/],
    ['navigator.sendBeacon', /sendBeacon\s*\(/],
    ['localStorage', /localStorage\s*[.[]/],
    ['写入 cookie', /document\.cookie\s*=/],
  ]
  let bad = 0
  for (const [label, re] of banned) if (re.test(bugPart)) { bad++; fail('记忆点代码里出现了 ' + label + '（隐私口径：纯前端、不上报、不落盘）') }
  if (!bad) ok('记忆点代码里没有 fetch/XHR/beacon/localStorage/cookie')
}

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项不通过' : '✓ 三条硬线里"能静态守住"的部分全部通过') + (warns.length ? '（' + warns.length + ' 条提示）' : ''))
console.log('  提醒：硬线① 的帧率与硬线③ 的对比度必须用真浏览器实测，方法见 site/README.md\n')
process.exit(fails.length ? 1 : 0)
