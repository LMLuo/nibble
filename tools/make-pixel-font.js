#!/usr/bin/env node
'use strict'
// make-pixel-font.js — 把「方舟像素字体 12px」子集化成官网用的两个 woff2
//
//   node tools/make-pixel-font.js       （= npm run font）
//
// 为什么要子集化：官方单个 woff2 ≈ 552KB，整包塞进落地页太重；
// 我们只保留"官网实际会出现"的字符（页面文案 + 演示数据里的怪物/武器名与故事），
// 产物通常几十 KB，而且中文是真单字、可选中可搜索。
//
// 输入（不入库，见 .gitignore）：
//   site/fonts/src/prop/ark-pixel-12px-proportional-zh_hans.otf.woff2
//   site/fonts/src/mono/ark-pixel-12px-monospaced-zh_hans.otf.woff2
//   —— 来自 https://github.com/TakWolf/ark-pixel-font/releases（OFL-1.1，见 site/fonts/OFL.txt）
// 输出（入库）：site/fonts/nibble-pixel.woff2、site/fonts/nibble-pixel-mono.woff2、site/fonts/charset.txt
//
// 字体按 OFL-1.1 授权：这里做了子集化（= 修改），所以字族名不沿用原名，改用 NibblePixel；
// 许可证随字体一起放在 site/fonts/OFL.txt，官网页脚也有一行署名。
// ⚠️ 改完官网文案或仓库内的怪物/武器数据后，重跑一次本脚本，否则新出现的字会回落到系统字体。

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SITE = path.join(ROOT, 'site')
const SRC = path.join(SITE, 'fonts', 'src')
const OUT = path.join(SITE, 'fonts')

const JOBS = [
  { name: 'nibble-pixel', file: path.join(SRC, 'prop', 'ark-pixel-12px-proportional-zh_hans.otf.woff2') },
  { name: 'nibble-pixel-mono', file: path.join(SRC, 'mono', 'ark-pixel-12px-monospaced-zh_hans.otf.woff2') },
]

// 除了页面里出现的字，再兜住一批"随时可能出现"的字符：
// ASCII 可见字符 + 常用中英文标点 + 官网用到的符号/罗马数字/方块
function baseCharset() {
  const out = new Set()
  for (let c = 0x20; c <= 0x7e; c++) out.add(String.fromCharCode(c))
  const extra =
    '　、。！？：；（）〔〕【】「」『』《》〈〉—…·～×÷±≈≤≥°％‰　‘’“”' +
    '＋－＝＊／＼｜＆＾＃＠～￥€$¢£§¶©®™†‡•‥…※★☆■□▲△▼▽◆◇○●◎▼←→↑↓↔↕' +
    '✿∿✹☾⚔♥♡♠♣♦♪♫✧✦✦🗡🎒📖🦴█░▒▓↵⏎␣✓✗✔✘'
  for (const ch of extra) out.add(ch)
  return out
}

function collectChars() {
  const set = baseCharset()
  const files = [
    path.join(SITE, 'index.html'),
    path.join(SITE, 'site.js'),
    path.join(SITE, 'site.css'),
    // 构建脚本自己生成的文案也在页面上（例如「无特殊机制」），必须一起扫
    path.join(ROOT, 'tools', 'build-site.js'),
  ]
  // 构建产物（占位符填充后的真实文案 + 演示数据）也扫一遍
  for (const gen of [path.join(ROOT, '_site', 'index.html'), path.join(ROOT, '_site', 'demo-data.js')]) {
    if (fs.existsSync(gen)) files.push(gen)
  }
  let extraChars = 0
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    for (const ch of fs.readFileSync(f, 'utf8')) if (!set.has(ch)) { set.add(ch); extraChars++ }
  }
  return { set, files, extraChars }
}

async function main() {
  const subsetFont = require('subset-font')
  for (const job of JOBS) {
    if (!fs.existsSync(job.file)) {
      console.error('✗ 缺少字体源文件：' + job.file)
      console.error('  请从 https://github.com/TakWolf/ark-pixel-font/releases 下载')
      console.error('  ark-pixel-font-12px-{proportional,monospaced}-otf.woff2-<版本>.zip，解压到 site/fonts/src/')
      process.exitCode = 1
      return
    }
  }

  const { set, files, extraChars } = collectChars()
  const text = [...set].join('')
  console.log('字符集：' + [...set].length + ' 个（额外从页面/数据里补了 ' + extraChars + ' 个），来源 ' + files.length + ' 个文件')

  fs.mkdirSync(OUT, { recursive: true })
  for (const job of JOBS) {
    const src = fs.readFileSync(job.file)
    const out = await subsetFont(src, text, { targetFormat: 'woff2' })
    const dest = path.join(OUT, job.name + '.woff2')
    fs.writeFileSync(dest, out)
    console.log(
      '✓ ' + path.basename(dest) + '  ' + Math.round(src.length / 1024) + 'KB → ' + Math.round(out.length / 1024) + 'KB',
    )
  }
  fs.writeFileSync(path.join(OUT, 'charset.txt'), text, 'utf8')
  console.log('✓ charset.txt（构建时会用它检查页面有没有用到没打包的字）')
}

main().catch((e) => {
  console.error('✗ 子集化失败：' + (e && e.message ? e.message : e))
  process.exitCode = 1
})
