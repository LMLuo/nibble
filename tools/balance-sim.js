#!/usr/bin/env node
'use strict'
// balance-sim.js — 武器战力 × 怪物难度 的平衡回归
//
// 直接 require 真实战斗代码跑模拟（不另写一套公式，避免脚本与线上漂移）：
//   刷一只指定 tier 的怪 → 反复调用 nibble.js 的 attack() → 统计"几击杀一只"
// 改 playerAtk / WEAPON_POWER / BASE_HP 后跑一遍，确认节奏没跑偏。
//
// 用法: node tools/balance-sim.js [每格样本数，默认 400]
// 目标（见 07/08 文档）：持**普通**武器时，小怪约 5 击 / 精英约 10 击 / 头目约 18 击；
//                       不带武器明显更慢，带传说明显更快。

const fs = require('fs')
const os = require('os')
const path = require('path')

// 关键：先指向临时存档目录，绝不读写真实进度
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nibble-sim-'))
process.env.CODEBBUDDY_PLUGIN_DATA = tmp

const hookDir = path.join(__dirname, '..', 'plugins', 'nibble', 'hooks')
const sp = require(path.join(hookDir, 'nibble.js'))
const enemies = require(path.join(hookDir, 'enemies.js'))

const SAMPLE = Number(process.argv[2]) || 400
const LEVELS = [1, 5, 10, 20, 30]
const WEAPON_CASES = [
  { label: '无武器', rarity: null },
  { label: '普通+8%', rarity: 'common' },
  { label: '稀有+15%', rarity: 'rare' },
  { label: '史诗+25%', rarity: 'epic' },
  { label: '传说+40%', rarity: 'legendary' },
]
const TIERS = ['common', 'elite', 'boss']

function makeSave(lv, weaponRarity) {
  const s = sp.loadSave()
  s.level = lv
  s.exp = 0
  s.battles = 0
  s.defeats = 0
  s.equipped = null
  s.arsenal = { owned: {}, pity: 0 }
  s.bestiary = { seen: {}, defeated: {} }
  if (weaponRarity) {
    // 同档战力相同，取该档第一把即可
    const w = sp.WEAPONS.filter((x) => x.rarity === weaponRarity)[0]
    s.arsenal.owned[w.id] = 1
  }
  return s
}

function entryOfTier(tier, lv) {
  const pool = sp.ENEMIES.filter((e) => e.tier === tier && e.minLv <= lv)
  return pool.length ? pool[0] : null // 该等级还没有这类怪 → 留空，不拿小怪替身
}

// 击杀一只怪需要几击（复用真实 attack；稀有度固定 common 以排除干扰）
// ⚠️ 每轮样本都必须重置 level/exp 与**武器库**：
//   ① 击败会给经验，跑几百次会自己升级；② 击败必掉武器，几百把会累积，
//   "未装备自动取最高战力"会把对照组一路污染成最强档（曾经因此跑出一片没差异的假数据）
function turnsToKill(s, entry, lv, sample, weaponRarity) {
  let total = 0
  for (let i = 0; i < sample; i++) {
    s.level = lv
    s.exp = 0
    s.equipped = null
    s.arsenal = { owned: {}, pity: 0 }
    if (weaponRarity) {
      const w = sp.WEAPONS.filter((x) => x.rarity === weaponRarity)[0]
      s.arsenal.owned[w.id] = 1
    }
    const before = s.defeats
    sp.spawnEnemy(s, { entry, rarity: 'common' })
    let turns = 0
    while (s.defeats === before && turns < 2000) {
      sp.attack(s)
      turns++
    }
    total += turns
  }
  return total / sample
}

// 改动前的旧模型（攻击 4+2lv、基础 HP 30+10(lv-1)）作为参考基线
const oldTurns = (lv, tier) => ((30 + (lv - 1) * 10) * (enemies.TIER_MUL[tier] || 1)) / (4 + lv * 2)

const f = (n) => n.toFixed(1).padStart(6)
console.log('每格样本 ' + SAMPLE + ' ｜ 单位：击杀所需回合数（提问次数）')
console.log('武器战力：' + Object.keys(sp.WEAPON_POWER).map((r) => sp.RARITY_LABEL[r] + ' +' + sp.WEAPON_POWER[r] + '%').join('　'))
console.log('')

for (const tier of TIERS) {
  console.log('【' + enemies.TIER_LABEL[tier] + '】tier 倍率 ×' + enemies.TIER_MUL[tier])
  console.log('  Lv   ' + WEAPON_CASES.map((c) => c.label.padStart(7)).join('') + '   旧模型')
  for (const lv of LEVELS) {
    const entry = entryOfTier(tier, lv)
    if (!entry) {
      console.log('  ' + String(lv).padEnd(5) + '（该等级还没解锁这一档怪）')
      continue
    }
    const vals = []
    const cells = []
    for (const c of WEAPON_CASES) {
      const v = turnsToKill(makeSave(lv, c.rarity), entry, lv, SAMPLE, c.rarity)
      vals.push(v)
      cells.push(f(v))
    }
    // 相对基准：以「普通」档为 100%，一眼看出武器到底有没有作用
    const base = vals[1] || 1
    const rel = vals.map((v) => (Math.round((v / base) * 100) + '%').padStart(7)).join('')
    console.log('  ' + String(lv).padEnd(5) + cells.join('') + '   ' + oldTurns(lv, tier).toFixed(1).padStart(6) + '  (' + entry.name + ')')
    console.log('  ' + ' '.repeat(5) + rel + '   ← 相对普通档')
  }
  console.log('')
}

// 清理临时存档
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch { /* ignore */ }
