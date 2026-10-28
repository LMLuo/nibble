#!/usr/bin/env node
'use strict'
// balance-sim.js — 武器战力 × 技能书 × 怪物难度 的平衡回归
//
// 直接 require 真实战斗代码跑模拟（不另写一套公式，避免脚本与线上漂移）：
//   刷一只指定 tier 的怪 → 反复调用 nibble.js 的 attack() → 统计"几击杀一只"
// 改 playerAtk / WEAPON_POWER / BASE_HP / SKILL_POWER 后跑一遍，确认节奏没跑偏。
//
// 用法: node tools/balance-sim.js [每格样本数，默认 400]
// 目标（见 07/08/10 文档）：
//   表 A（无技能）：持**普通**武器时，小怪约 5 击 / 精英约 10 击 / 头目约 18 击；不带武器明显更慢，带传说明显更快。
//   表 B（技能档）：4 本史诗档（期望 ×1.25）≈ 比无技能快 20%；4 本传说档（×1.40）≈ 快 30%（收集兑现，不补偿敌人 HP）。

const fs = require('fs')
const os = require('os')
const path = require('path')

// 关键：先指向临时存档目录，绝不读写真实进度
// ⚠️ 变量名必须与 plugins/nibble/hooks/nibble.js 的 dataDir() 一致：CODEBUDDY_PLUGIN_DATA（无第二个 D）；
// 兜底 CLAUDE_PLUGIN_DATA。写错时钩子会回落到 ~/.codebuddy/plugins/data/nibble（真实存档）——曾因此污染过真实进度。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nibble-sim-'))
process.env.CODEBUDDY_PLUGIN_DATA = tmp
process.env.CLAUDE_PLUGIN_DATA = tmp

const hookDir = path.join(__dirname, '..', 'plugins', 'nibble', 'hooks')
const sp = require(path.join(hookDir, 'nibble.js'))

// 自检隔离是否生效：拿不到临时目录就直接退出，宁可跑不了也不能动真实存档
if (sp.dataDir() !== tmp) {
  console.error('❌ 存档隔离失效：dataDir = ' + sp.dataDir() + '（期望 ' + tmp + '）——拒绝运行以免污染真实进度')
  process.exit(1)
}
const enemies = require(path.join(hookDir, 'enemies.js'))

const SAMPLE = Number(process.argv[2]) || 400
// 可选：模拟"从 N 连击开始"（连击加成会乘进攻击力；默认 0 = 零连击基线）
// 用法: NIBBLE_SIM_STREAK=30 node tools/balance-sim.js
const STREAK = Math.max(0, Number(process.env.NIBBLE_SIM_STREAK) || 0)
const LEVELS = [1, 5, 10, 20, 30]
const WEAPON_CASES = [
  { label: '无武器', rarity: null },
  { label: '普通+8%', rarity: 'common' },
  { label: '稀有+15%', rarity: 'rare' },
  { label: '史诗+25%', rarity: 'epic' },
  { label: '传说+40%', rarity: 'legendary' },
]
const TIERS = ['common', 'elite', 'boss']
// 技能档（第二刀）：无技能 / 4 本同档；同档 4 本还会吃到稀有度共鸣（+5%，全传说 +10%）
const SKILL_CASES = [
  { label: '无技能', rarity: null },
  { label: '4普通', rarity: 'common' },
  { label: '4稀有', rarity: 'rare' },
  { label: '4史诗', rarity: 'epic' },
  { label: '4传说', rarity: 'legendary' },
]

// 某档的前 4 本（必须 4 本不同，与游戏内"禁止重复上阵"一致）
function skillSlotsOf(rarity) {
  const slots = [null, null, null, null]
  if (!rarity) return slots
  const pool = sp.SKILLS.filter((x) => x.rarity === rarity).slice(0, 4)
  pool.forEach((x, i) => { slots[i] = x.id })
  return slots
}

function ownedOf(rarity) {
  const owned = {}
  for (const id of skillSlotsOf(rarity)) if (id) owned[id] = 1
  return owned
}

function makeSave(lv, weaponRarity, skillRarity) {
  const s = sp.loadSave()
  s.level = lv
  s.exp = 0
  s.battles = 0
  s.defeats = 0
  s.equipped = null
  s.streak = { count: STREAK, lastAt: STREAK ? Date.now() : 0 }
  s.arsenal = { owned: {}, pity: 0 }
  s.bestiary = { seen: {}, defeated: {} }
  // 技能书同样必须每轮重置：击败会掉书并推进保底，不重置会污染对照组
  s.skills = { owned: ownedOf(skillRarity), pity: 0 }
  s.skillSlots = skillSlotsOf(skillRarity)
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
// ⚠️ 每轮样本都必须重置 level/exp、**武器库**与**连击**：
//   ① 击败会给经验，跑几百次会自己升级；② 击败会掉武器，几百把会累积，
//   "未装备自动取最高战力"会把对照组一路污染成最强档（曾经因此跑出一片没差异的假数据）；
//   ③ 连击每击 +1，不重置会一路涨到封顶，把"零连击基线"污染成高连击数据
// 每轮重置（武器 / 技能 / 连击 / 玩家血量）——必须全量重置，否则对照组会被上一轮污染
function resetRound(s, lv, weaponRarity, skillRarity) {
  s.level = lv
  s.exp = 0
  s.equipped = null
  s.streak = { count: STREAK, lastAt: STREAK ? Date.now() : 0 }
  s.arsenal = { owned: {}, pity: 0 }
  s.skills = { owned: ownedOf(skillRarity), pity: 0 }
  s.skillSlots = skillSlotsOf(skillRarity)
  s.playerHp = sp.playerMaxHp(lv)
  s.playerGuard = null
  if (weaponRarity) {
    const w = sp.WEAPONS.filter((x) => x.rarity === weaponRarity)[0]
    s.arsenal.owned[w.id] = 1
  }
}

// 击杀一只怪需要几回合（**纯伤害对拼**）：每击前把玩家血量补满 —— 被击退会换怪、把"打这只怪要几回合"
// 变得不可比，所以回合数用"不会被打退"的假设测量；被打退的风险由 riskRate() 单独测。
function turnsToKill(s, entry, lv, sample, weaponRarity, skillRarity) {
  let total = 0
  for (let i = 0; i < sample; i++) {
    resetRound(s, lv, weaponRarity, skillRarity)
    const before = s.defeats
    sp.spawnEnemy(s, { entry, rarity: 'common' })
    let turns = 0
    while (s.defeats === before && turns < 2000) {
      s.playerHp = sp.playerMaxHp(lv) // 局部：只用于测回合数
      sp.attack(s)
      turns++
    }
    total += turns
  }
  return total / sample
}

// 击退率（**自然血量**）：这一场会不会在打死它之前被击退（每样本一次机会，被击退即记为失败）
function riskRate(s, entry, lv, sample, skillRarity) {
  let knocks = 0
  for (let i = 0; i < sample; i++) {
    resetRound(s, lv, 'common', skillRarity)
    const before = s.defeats
    sp.spawnEnemy(s, { entry, rarity: 'common' })
    let turns = 0
    while (turns < 2000) {
      sp.attack(s)
      turns++
      if (s.logKind === 'knockback') { knocks++; break } // 被打退 → 这一场失败
      if (s.defeats > before) break // 击杀成功
    }
  }
  return knocks / sample
}

// 改动前的旧模型（攻击 4+2lv、基础 HP 30+10(lv-1)）作为参考基线
const oldTurns = (lv, tier) => ((30 + (lv - 1) * 10) * (enemies.TIER_MUL[tier] || 1)) / (4 + lv * 2)

const f = (n) => n.toFixed(1).padStart(6)
console.log('每格样本 ' + SAMPLE + ' ｜ 单位：击杀所需回合数（提问次数）')
console.log('武器战力：' + Object.keys(sp.WEAPON_POWER).map((r) => sp.RARITY_LABEL[r] + ' +' + sp.WEAPON_POWER[r] + '%').join('　'))
console.log('技能倍率：' + Object.keys(sp.SKILL_POWER).map((r) => sp.RARITY_LABEL[r] + ' ×' + sp.SKILL_POWER[r].toFixed(2)).join('　') +
  '　出手权重 ' + Object.keys(sp.SKILL_WEIGHT).map((r) => sp.SKILL_WEIGHT[r]).join('/'))
if (STREAK) console.log('连击：每轮从 ×' + STREAK + ' 开始（攻击 +' + sp.streakState({ streak: { count: STREAK, lastAt: Date.now() } }).bonus + '% 起，随攻击继续累积）')
console.log('')

console.log('【表 A】武器战力（无技能）—— 用于和历史基线逐格对照，改动前必须一致')
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
      const v = turnsToKill(makeSave(lv, c.rarity, null), entry, lv, SAMPLE, c.rarity, null)
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

console.log('【表 B】技能档（固定普通武器 +8%，无连击基线）—— 收集兑现的加速幅度')
console.log('　回合数 = 纯伤害对拼（每击补满玩家血量）；被击退的风险见【表 C】')
for (const tier of TIERS) {
  console.log('【' + enemies.TIER_LABEL[tier] + '】')
  console.log('  Lv   ' + SKILL_CASES.map((c) => c.label.padStart(7)).join(''))
  for (const lv of LEVELS) {
    const entry = entryOfTier(tier, lv)
    if (!entry) {
      console.log('  ' + String(lv).padEnd(5) + '（该等级还没解锁这一档怪）')
      continue
    }
    const vals = SKILL_CASES.map((c) => turnsToKill(makeSave(lv, 'common', c.rarity), entry, lv, SAMPLE, 'common', c.rarity))
    const base = vals[0] || 1
    console.log('  ' + String(lv).padEnd(5) + vals.map(f).join(''))
    console.log('  ' + ' '.repeat(5) + vals.map((v) => (Math.round((v / base) * 100) + '%').padStart(7)).join('') + '   ← 相对无技能')
  }
  console.log('')
}

console.log('【表 C】击退率（自然血量：这一场会不会在打死它之前被击退）')
console.log('　玩家可承受回合数 = maxHp ÷ 反击伤害（小怪/精英/头目 = 5% / 3.5% / 3%）')
for (const tier of TIERS) {
  console.log('【' + enemies.TIER_LABEL[tier] + '】')
  console.log('  Lv   ' + SKILL_CASES.map((c) => c.label.padStart(7)).join(''))
  for (const lv of LEVELS) {
    const entry = entryOfTier(tier, lv)
    if (!entry) {
      console.log('  ' + String(lv).padEnd(5) + '（该等级还没解锁这一档怪）')
      continue
    }
    const risks = SKILL_CASES.map((c) => riskRate(makeSave(lv, 'common', c.rarity), entry, lv, SAMPLE, c.rarity))
    console.log('  ' + String(lv).padEnd(5) + risks.map((r) => ((r * 100).toFixed(0) + '%').padStart(7)).join('') +
      '   ← 可承受 ' + Math.round(sp.playerMaxHp(lv) / sp.playerCounter(lv, 'common', tier)) + ' 回合')
  }
  console.log('')
}

// 清理临时存档
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch { /* ignore */ }
