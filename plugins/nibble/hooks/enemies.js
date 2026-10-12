'use strict'
// enemies.js — 怪物数据 + 出现权重 + 难度数值模型（全数据驱动）
// 设计文档：docs/游戏升级规划/08-怪物库与难度升级设计.md
// 加怪 = 在 ENEMIES 追加 {id,name,tier,minLv,mech} + 在 enemies-stories.js 补故事 + 补素材重跑构建。
// 难度为「A 档」：只做数值分级（tier/稀有度/等级三重缩放 + 精英机制），不引入玩家 HP 与失败判定。

const { STORIES } = require('./enemies-stories')

const TIER_LABEL = { common: '小怪', elite: '精英', boss: '头目' }
const TIER_ORDER = ['boss', 'elite', 'common'] // 图鉴展示顺序（稀有度感由高到低）
const TIER_MUL = { common: 1.0, elite: 2.0, boss: 3.6 }
const RARITY_MUL = { common: 1.0, rare: 1.15, epic: 1.35, legendary: 1.6 }
const MECH_LABEL = { armor: '护甲', dodge: '闪避', regen: '自愈', shield: '护盾', split: '分裂' }

// mech 可选键：{ armor:N 每次受伤减伤N }、{ dodge:0~1 闪避概率 }、{ regen:N 每回合自愈N }
//             { shield:N 开场N层护盾(伤害减半) }、{ split:true HP归零分裂一次 }
const ENEMIES = [
  // —— 小怪 Common（20）：日常可见的 Bug ——
  { id: 'null_pointer', name: '空指针幽灵', tier: 'common', minLv: 1 },
  { id: 'infinite_loop', name: '无尽轮回蛇', tier: 'common', minLv: 1 },
  { id: 'off_by_one', name: '差一错虫', tier: 'common', minLv: 1 },
  { id: 'type_coercion', name: '类型混搭兽', tier: 'common', minLv: 1 },
  { id: 'undefined_var', name: '未定义影', tier: 'common', minLv: 1 },
  { id: 'index_bounds', name: '越界游魂', tier: 'common', minLv: 2, mech: { dodge: 0.1 } },
  { id: 'mojibake', name: '乱码兽', tier: 'common', minLv: 2 },
  { id: 'uncaught_exception', name: '未捕获异常魔', tier: 'common', minLv: 2 },
  { id: 'float_drift', name: '浮点误差团', tier: 'common', minLv: 2 },
  { id: 'shadow_var', name: '变量遮蔽妖', tier: 'common', minLv: 3 },
  { id: 'callback_hell', name: '回调地狱犬', tier: 'common', minLv: 3 },
  { id: 'copy_paste', name: '复读机怪', tier: 'common', minLv: 3 },
  { id: 'magic_number', name: '魔数精', tier: 'common', minLv: 3 },
  { id: 'todo_zombie', name: 'TODO 僵尸', tier: 'common', minLv: 3 },
  { id: 'hardcode_golem', name: '硬编码石人', tier: 'common', minLv: 4, mech: { armor: 1 } },
  { id: 'global_pollution', name: '全局污染粘液', tier: 'common', minLv: 4 },
  { id: 'typo_imp', name: '拼写错误鬼', tier: 'common', minLv: 4 },
  { id: 'asi_ambusher', name: '分号伏击者', tier: 'common', minLv: 4, mech: { dodge: 0.12 } },
  { id: 'timezone_shift', name: '时区错位兽', tier: 'common', minLv: 5 },
  { id: 'bom_worm', name: 'BOM 头蠕虫', tier: 'common', minLv: 5 },

  // —— 精英 Elite（14）：深处的 Bug ——
  { id: 'memory_leak', name: '内存泄漏巨蟒', tier: 'elite', minLv: 6, mech: { regen: 3 } },
  { id: 'race_condition', name: '竞态幽灵', tier: 'elite', minLv: 6, mech: { dodge: 0.2 } },
  { id: 'deadlock_spider', name: '死锁蛛', tier: 'elite', minLv: 7, mech: { armor: 2 } },
  { id: 'stack_overflow', name: '栈溢出巨龙', tier: 'elite', minLv: 7, mech: { regen: 2 } },
  { id: 'n_plus_one', name: 'N+1 查询兽', tier: 'elite', minLv: 8, mech: { split: true } },
  { id: 'phantom_dependency', name: '幽灵依赖', tier: 'elite', minLv: 8, mech: { dodge: 0.18 } },
  { id: 'flaky_test', name: '不稳定测试兽', tier: 'elite', minLv: 9, mech: { dodge: 0.25, shield: 2 } },
  { id: 'circular_dependency', name: '循环依赖衔尾蛇', tier: 'elite', minLv: 9, mech: { regen: 4 } },
  { id: 'cache_invalidation', name: '缓存失效魔', tier: 'elite', minLv: 10, mech: { shield: 3 } },
  { id: 'dangling_pointer', name: '悬空指针', tier: 'elite', minLv: 10, mech: { armor: 3 } },
  { id: 'handle_leak', name: '句柄泄漏水蛭', tier: 'elite', minLv: 11, mech: { regen: 3 } },
  { id: 'encoding_nightmare', name: '编码噩梦', tier: 'elite', minLv: 11, mech: { armor: 2, dodge: 0.15 } },
  { id: 'clock_drift', name: '时钟漂移', tier: 'elite', minLv: 12, mech: { dodge: 0.2, shield: 2 } },
  { id: 'silent_failure', name: '静默失败幽灵', tier: 'elite', minLv: 12, mech: { shield: 3 } },

  // —— 头目 Boss（6）：系统的终极噩梦 ——
  { id: 'segfault_titan', name: '段错误泰坦', tier: 'boss', minLv: 15, mech: { armor: 4, split: true } },
  { id: 'entropy_virus', name: '熵增病毒', tier: 'boss', minLv: 18, mech: { regen: 6, shield: 3 } },
  { id: 'legacy_colossus', name: '祖传代码巨像', tier: 'boss', minLv: 20, mech: { armor: 5, regen: 4 } },
  { id: 'cascade_avalanche', name: '级联雪崩', tier: 'boss', minLv: 22, mech: { dodge: 0.2, split: true } },
  { id: 'bit_rot', name: '位腐古神', tier: 'boss', minLv: 25, mech: { armor: 6, regen: 5 } },
  { id: 'debt_singularity', name: '技术债奇点', tier: 'boss', minLv: 28, mech: { armor: 4, shield: 4, regen: 6, split: true } },
]

// 故事与索引（id → 条目）
for (const e of ENEMIES) e.story = STORIES[e.id] || ''
const ENEMY_INDEX = {}
for (const e of ENEMIES) ENEMY_INDEX[e.id] = e
const ENEMY_TOTAL = ENEMIES.length
const TIER_COUNTS = { common: 0, elite: 0, boss: 0 }
for (const e of ENEMIES) TIER_COUNTS[e.tier] = (TIER_COUNTS[e.tier] || 0) + 1

// ============================ 难度数值 ============================
// 基础 HP 曲线：与「等级基础攻击 × 普通武器战力(+8%)」配平 → 持普通武器约 5 击清一只小怪。
// ⚠️ 改 playerAtk / WEAPON_POWER 时，这里要用 tools/balance-sim.js 一起重新校准（08 文档「难度模型」）
const BASE_HP = (lv) => Math.round(21 + lv * 5.95)

// 怪物 HP = 基础曲线 × tier 倍率 × 稀有度倍率 × 随机浮动(±10%)
function enemyMaxHp(lv, entry, rarity, rnd = Math.random) {
  const mul = (TIER_MUL[entry && entry.tier] || 1) * (RARITY_MUL[rarity] || 1)
  return Math.max(6, Math.round(BASE_HP(lv) * mul * (0.9 + rnd() * 0.2)))
}

// 出现权重：小怪全程、精英 Lv6 起、头目 Lv15 起；等级越高杂兵占比越低
function tierWeight(lv) {
  return {
    common: 100 - Math.min(40, lv * 2),
    elite: lv < 6 ? 0 : Math.min(45, (lv - 4) * 4),
    boss: lv < 15 ? 0 : Math.min(12, lv - 13),
  }
}

function pickTier(lv, rnd = Math.random) {
  const w = tierWeight(lv)
  const total = w.common + w.elite + w.boss
  if (total <= 0) return 'common'
  let r = rnd() * total
  for (const t of ['common', 'elite', 'boss']) {
    r -= w[t]
    if (r < 0) return t
  }
  return 'common'
}

// 该 tier 在当前等级可出现的池子；池子为空时回落到小怪
function poolOf(tier, lv) {
  const pool = ENEMIES.filter((e) => e.tier === tier && e.minLv <= lv)
  if (pool.length) return pool
  return ENEMIES.filter((e) => e.tier === 'common')
}

function pickEnemy(lv, rnd = Math.random) {
  const pool = poolOf(pickTier(lv, rnd), lv)
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))]
}

// 机制摘要（图鉴/详情卡展示）：'护甲 2 · 闪避 20% · 自愈 3'
function mechSummary(entry) {
  const m = (entry && entry.mech) || {}
  const parts = []
  if (m.armor) parts.push(MECH_LABEL.armor + ' ' + m.armor)
  if (m.shield) parts.push(MECH_LABEL.shield + ' ' + m.shield)
  if (m.dodge) parts.push(MECH_LABEL.dodge + ' ' + Math.round(m.dodge * 100) + '%')
  if (m.regen) parts.push(MECH_LABEL.regen + ' ' + m.regen)
  if (m.split) parts.push(MECH_LABEL.split)
  return parts.join(' · ')
}

module.exports = {
  ENEMIES, ENEMY_INDEX, ENEMY_TOTAL, TIER_COUNTS,
  TIER_LABEL, TIER_ORDER, TIER_MUL, RARITY_MUL, MECH_LABEL,
  BASE_HP, enemyMaxHp, tierWeight, pickTier, pickEnemy, mechSummary,
  STORIES,
}
