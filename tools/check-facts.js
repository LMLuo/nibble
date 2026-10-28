'use strict'
// check-facts.js —— 文案数字口径自检（Q6「事实口径防过期」）：
//   1) 从 hooks 真源生成 docs/FACTS.md —— 官网 / README / 市场描述共用数字的唯一来源
//   2) 扫描这些文案文件，抓出"改数值后最容易漏改的旧口径"（如「必掉」「2% + 40 只保底」）
// 用法：node tools/check-facts.js        （生成 FACTS.md + 扫描；发现旧口径则退出码 1）
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')

const sp = require(path.join(ROOT, 'plugins/nibble/hooks/nibble.js'))
const wp = require(path.join(ROOT, 'plugins/nibble/hooks/weapons.js'))
const sk = require(path.join(ROOT, 'plugins/nibble/hooks/skills.js'))

// 角色帧数据挂在 window 上（webview 脚本），这里造个假 window 读出来
global.window = {}
require(path.join(ROOT, 'vscode-extension/media/actor-frames.js'))
const AF = global.window.NibbleActorFrames || {}

const pct = (n) => Math.round(n * 100) + '%'
const rarity = (o) => ['common', 'rare', 'epic', 'legendary']
  .map((k) => (sp.RARITY_LABEL[k] || k) + ' ' + pct(o[k]))
  .join(' / ')

// 真源事实（数字一律从 hooks 读，不手写）
const facts = {
  '怪物总数': sp.ENEMY_TOTAL + ' 只',
  '武器总数': wp.WEAPON_TOTAL + ' 把',
  '技能书总数': sk.SKILL_TOTAL + ' 本',
  '家具总数': sp.HOME_ITEM_IDS.length + ' 件（装潢 ' + (sp.HOME_SERIES.length * sp.HOME_SKIN_SLOTS.length) + ' + 装饰 ' + sp.HOME_EXTRA_IDS.length + '）',
  '武器掉落率': pct(wp.WEAPON_DROP_RATE),
  '武器稀有度': rarity(wp.RARITY_DROP),
  '武器保底': wp.PITY_LIMIT + ' 击未出史诗以上必出',
  '技能书掉落率': pct(sk.SKILL_DROP_RATE),
  '技能书保底': sk.SKILL_PITY_LIMIT + ' 只未出稀有必掉一本',
  '家具掉落率': pct(sp.HOME_DROP_RATE),
  '家具保底': sp.HOME_PITY_LIMIT + ' 只',
  '久别阈值': Math.round(sp.HOME_AWAY_MS / 3600000) + ' 小时',
  '角色帧': Object.keys(AF.frames || {}).length + ' 帧 / ' + (AF.palette || []).length + ' 色',
}

// 生成 docs/FACTS.md
const md = [
  '# Nibble 数字口径（唯一真源）',
  '',
  '> 由 `node tools/check-facts.js` 从 `plugins/nibble/hooks/` 生成，请勿手改。',
  '> 官网 / README / 市场描述里的数字都应与此一致；改数值只动 hooks，别在文案里写死。',
  '',
  '| 项 | 值 |',
  '|---|---|',
  ...Object.entries(facts).map(([k, v]) => `| ${k} | ${v} |`),
  '',
].join('\n')
const factsPath = path.join(ROOT, 'docs', 'FACTS.md')
fs.mkdirSync(path.dirname(factsPath), { recursive: true })
fs.writeFileSync(factsPath, md, 'utf8')
console.log('✓ 已生成 docs/FACTS.md（' + Object.keys(facts).length + ' 项）')

// 过期口径：改数值后最容易漏改的文案，出现即失败
// 注意：别把「40 只」（怪物数）「40 击」（武器保底）也禁掉，只禁确已过期的写法
const FORBIDDEN = [
  ['必掉 1 把武器', '武器已改概率掉落（见 FACTS.md）'],
  ['每杀必掉', '武器已改概率掉落'],
  ['击败必掉', '武器已改概率掉落'],
  ['2% 概率 + 40 只保底', '家具掉率已改 5% + 25 只保底'],
  ['2% 概率', '家具掉率已改 5%'],
  ['40 只保底', '家具保底已改 25 只'],
  ['40 次保底', '武器保底口径已改「40 击未出史诗以上」'],
]
// CHANGELOG 是历史记录，「不再每杀必掉」这类描述本身就该留着，所以不扫它。
// 只扫"面向用户/市场"的文案：README、官网、package.json 描述。
const SCAN_FILES = [
  'README.md',
  'vscode-extension/README.md',
  'vscode-extension/package.json',
  'site/index.html',
]
let failed = false
for (const rel of SCAN_FILES) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) continue
  const text = fs.readFileSync(abs, 'utf8')
  for (const [bad, why] of FORBIDDEN) {
    if (text.includes(bad)) {
      console.log('✗ ' + rel + ' 里出现过期口径「' + bad + '」→ ' + why)
      failed = true
    }
  }
}
if (failed) {
  console.log('❌ 文案数字口径过期，请按 FACTS.md 更新')
  process.exit(1)
}
console.log('✓ 文案数字口径无过期写法')
