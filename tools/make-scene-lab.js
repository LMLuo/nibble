#!/usr/bin/env node
'use strict'
// make-scene-lab.js — 生成战斗场景样张的数据文件（开发辅助，产物不进 git）
//
// 用法: node tools/make-scene-lab.js
// 输出: vscode-extension/media/scene-lab-data.js
//
// 数据直接取自 plugins/nibble/hooks/ 的真实素材（单一数据源），不手抄、不转码。
// 压缩成项目原生的「调色板 + base36 索引行」格式，体积约为颜色数组的 1/6。

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const media = path.join(root, 'vscode-extension', 'media')
const sp = require(path.join(root, 'plugins', 'nibble', 'hooks', 'nibble.js'))

// 24×24 → n×n：每格取块内出现最多的非空色（与 nibble.js 的 miniGrid 同思路）
function downscale(grid, n) {
  const step = grid.length / n
  const out = []
  for (let y = 0; y < n; y++) {
    const row = []
    for (let x = 0; x < n; x++) {
      const counts = new Map()
      let best = null
      let bestN = 0
      for (let sy = Math.floor(y * step); sy < Math.floor((y + 1) * step); sy++) {
        for (let sx = Math.floor(x * step); sx < Math.floor((x + 1) * step); sx++) {
          const c = grid[sy] && grid[sy][sx]
          if (!c) continue
          const k = (counts.get(c) || 0) + 1
          counts.set(c, k)
          if (k > bestN) { bestN = k; best = c }
        }
      }
      row.push(best)
    }
    out.push(row)
  }
  return out
}

// 样张里出场的角色：主角 + 当前怪。想换就改这里再重跑。
const PICKS = {
  player: sp.decodeGrid('player').grid,
  main: sp.enemyGrid('race_condition', 'common', false),
}

// 可在样张里切换的武器：覆盖匕首 / 锤 / 弓 / 法杖 / 圣剑等不同形态，
// 用来验证「手持」的落点对各类武器是否都成立。每把只出 12 格（角色一半高）。
const WEAPON_IDS = [
  'refactor_blade', 'nullptr_dagger', 'enter_hammer',
  'recursion_bow', 'entropy_staff', 'debug_zero',
]
const WEAPON_LABEL = {
  refactor_blade: '重构刃', nullptr_dagger: '匕首', enter_hammer: '回车锤',
  recursion_bow: '长弓', entropy_staff: '法杖', debug_zero: '圣剑',
}
const weapons = {}
for (const id of WEAPON_IDS) {
  const entry = sp.WEAPON_INDEX[id]
  const g = sp.weaponSpriteGrid(id, true)
  if (g && entry) {
    weapons[id] = {
      label: WEAPON_LABEL[id] || entry.name,
      // 稀有度色给「武器格子」的描边与发光用（照用户给的那张参考图）
      rarity: entry.rarity,
      color: sp.RARITY_COLOR[entry.rarity] || '#8a8a8a',
      sm: pack(downscale(g, 12)),
    }
  }
}

// 颜色数组 → { palette, rows }（同 pixels.js 的格式）
function pack(grid) {
  const palette = []
  const idx = new Map()
  const rows = grid.map((row) =>
    row
      .map((c) => {
        if (!c) return '.'
        if (!idx.has(c)) {
          idx.set(c, palette.length)
          palette.push(c)
        }
        return idx.get(c).toString(36)
      })
      .join(''),
  )
  return { palette, rows }
}

const out = {}
for (const k of Object.keys(PICKS)) out[k] = pack(PICKS[k])
out.weapons = weapons
// 菜单里的进度数字（total 取真实值，owned/seen 是样张的演示值）
out.meta = {
  weaponOwned: 12, weaponTotal: sp.WEAPONS.length,
  enemySeen: 7, enemyTotal: sp.ENEMY_TOTAL,
}

const file = path.join(media, 'scene-lab-data.js')
fs.writeFileSync(file, 'window.SCENE_LAB_DATA = ' + JSON.stringify(out) + '\n', 'utf8')
console.log('✓ 已生成 ' + file)
console.log('  角色：' + Object.keys(PICKS).join(', ') + '｜武器：' + Object.keys(weapons).length + ' 把')
