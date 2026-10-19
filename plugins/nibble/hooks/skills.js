'use strict'
// skills.js — 技能书（50 本）+ 标签 + 组合 + 掉落/装配逻辑
// 设计文档：docs/游戏升级规划/10-技能书与技能库设计.md
// 加一本书 = 在 SKILLS 追加 {id, name, rarity, tag} + skills-stories.js 补一句注记 + 重跑素材管线。
//
// 口径（第一刀 = 收集层，不影响任何战斗数值）：
//   - 掉落：每次击败 10% 掷；独立保底 20 只怪（保底只给"稀有及以上"）
//   - 装配：4 槽、必须 4 本不同的书、全手动（不自动替换）
//   - 出手：随机施放是本文件的数据（SKILL_POWER / SKILL_WEIGHT），但**由第二刀接入战斗**

const { STORIES } = require('./skills-stories')
const { fitToBox } = require('./weapons')

// 技能素材（构建期由 tools/skills-sprites.mjs 生成）；未构建时回落为空表，保证不崩
let SKILL_PIXEL_DATA = {}
try { SKILL_PIXEL_DATA = require('./skills-pixels').SKILL_PIXEL_DATA || {} } catch { /* 素材未生成 */ }

// ============================ 技能书表（50 本） ============================
// tag：九个标签之一（见 TAG_LABEL）；标签决定组合搭配与出手时的自动效果
const SKILLS = [
  // —— 普通（20）：日常开发工具风，倍率 1.00（= 普攻） ——
  { id: 'print_debug', name: '打印大法', rarity: 'common', tag: 'aim' },
  { id: 'try_catch', name: '捕获兜底', rarity: 'common', tag: 'guard' },
  { id: 'rubber_duck', name: '小黄鸭', rarity: 'common', tag: 'leech' },
  { id: 'git_blame', name: '甩锅回溯', rarity: 'common', tag: 'rend' },
  { id: 'console_log', name: '控制台神谕', rarity: 'common', tag: 'pierce' },
  { id: 'todo_comment', name: '待办符咒', rarity: 'common', tag: 'surge' },
  { id: 'sleep_retry', name: '睡一秒', rarity: 'common', tag: 'guard' },
  { id: 'regex_magic', name: '正则玄学', rarity: 'common', tag: 'crit' },
  { id: 'hotfix_tape', name: '胶带热修', rarity: 'common', tag: 'leech' },
  { id: 'force_push', name: '强制推送', rarity: 'common', tag: 'chase' },
  { id: 'paste_stackoverflow', name: '复制粘贴术', rarity: 'common', tag: 'aim' },
  { id: 'off_by_one_patch', name: '差一补丁', rarity: 'common', tag: 'reflect' },
  { id: 'mock_data', name: '假数据面具', rarity: 'common', tag: 'guard' },
  { id: 'semicolon_ward', name: '分号结界', rarity: 'common', tag: 'pierce' },
  { id: 'print_sleep', name: '打印个寂寞', rarity: 'common', tag: 'leech' },
  { id: 'assert_self', name: '自我断言', rarity: 'common', tag: 'crit' },
  { id: 'if_else_tower', name: 'if-else 高塔', rarity: 'common', tag: 'rend' },
  { id: 'reboot_chant', name: '重启咒语', rarity: 'common', tag: 'reflect' },
  { id: 'linter_shield', name: '格式护盾', rarity: 'common', tag: 'guard' },
  { id: 'comment_out', name: '注释大法', rarity: 'common', tag: 'surge' },

  // —— 稀有（15）：工程手法，倍率 1.10 ——
  { id: 'stack_trace', name: '调用栈', rarity: 'rare', tag: 'pierce' },
  { id: 'stress_test', name: '压测狂魔', rarity: 'rare', tag: 'crit' },
  { id: 'shadow_strike', name: '暗影突袭', rarity: 'rare', tag: 'chase' },
  { id: 'shield_aura', name: '护盾光环', rarity: 'rare', tag: 'guard' },
  { id: 'breakpoint_trap', name: '断点陷阱', rarity: 'rare', tag: 'aim' },
  { id: 'unit_test_ward', name: '单测结界', rarity: 'rare', tag: 'guard' },
  { id: 'binary_search', name: '二分定位', rarity: 'rare', tag: 'aim' },
  { id: 'cache_warm', name: '缓存预热', rarity: 'rare', tag: 'leech' },
  { id: 'load_balancer', name: '负载均衡', rarity: 'rare', tag: 'reflect' },
  { id: 'null_check', name: '空值校验', rarity: 'rare', tag: 'pierce' },
  { id: 'retry_backoff', name: '退避重试', rarity: 'rare', tag: 'surge' },
  { id: 'type_guard', name: '类型守卫', rarity: 'rare', tag: 'rend' },
  { id: 'log_trace', name: '埋点追踪', rarity: 'rare', tag: 'chase' },
  { id: 'memory_profiler', name: '内存剖析', rarity: 'rare', tag: 'crit' },
  { id: 'graceful_degrade', name: '优雅降级', rarity: 'rare', tag: 'leech' },

  // —— 史诗（10）：底层灾难具象化，倍率 1.20、标签强档 ——
  { id: 'crit_focus', name: '专注瞄准', rarity: 'epic', tag: 'crit' },
  { id: 'combo_finisher', name: '连击终结', rarity: 'epic', tag: 'surge' },
  { id: 'arch_master', name: '架构之眼', rarity: 'epic', tag: 'rend' },
  { id: 'schema_guard', name: '模式约束', rarity: 'epic', tag: 'guard' },
  { id: 'zero_downtime', name: '零停机发布', rarity: 'epic', tag: 'reflect' },
  { id: 'race_radar', name: '竞态雷达', rarity: 'epic', tag: 'aim' },
  { id: 'profiler_blade', name: '剖析利刃', rarity: 'epic', tag: 'pierce' },
  { id: 'chaos_monkey', name: '混沌猴子', rarity: 'epic', tag: 'chase' },
  { id: 'drain_life_patch', name: '补丁吸血', rarity: 'epic', tag: 'leech' },
  { id: 'overload_burst', name: '过载爆发', rarity: 'epic', tag: 'crit' },

  // —— 传说（5）：创世级，倍率 1.30、标签强档 ——
  { id: 'hello_world', name: 'Hello, World', rarity: 'legendary', tag: 'chase' },
  { id: 'root_access', name: '根权限', rarity: 'legendary', tag: 'pierce' },
  { id: 'gc_finalizer', name: '终结清理', rarity: 'legendary', tag: 'leech' },
  { id: 'immutable_truth', name: '不可变真理', rarity: 'legendary', tag: 'guard' },
  { id: 'infinite_refactor', name: '无限重构', rarity: 'legendary', tag: 'surge' },
]

// ============================ 标签（9 个） ============================
// 每个标签两档强度：弱档 = 普通/稀有，强档 = 史诗/传说（强档数值由第二刀接入战斗）
const TAG_KEYS = ['leech', 'guard', 'surge', 'crit', 'pierce', 'rend', 'aim', 'chase', 'reflect']
const TAG_LABEL = {
  leech: '回复', guard: '护盾', surge: '连击增幅', crit: '必暴',
  pierce: '贯穿', rend: '破甲', aim: '精准', chase: '追击', reflect: '反震',
}
const TAG_POWER = {
  leech: { weak: 8, strong: 15 },      // 吸血 %
  guard: { weak: 50, strong: 100 },    // 反击减伤 %（100 = 免疫一次）
  surge: { weak: 2, strong: 4 },       // 本次按"连击 +N"计算
  crit: { weak: 2, strong: 2.5 },      // 本次伤害倍率
  pierce: { weak: 0, strong: 1 },      // 削弱层数（0 = 只无视减伤）
  rend: { weak: 1, strong: 2 },        // 永久削层数
  aim: { weak: 0, strong: 1 },         // 1 = 同时无视护盾减半
  chase: { weak: 0.5, strong: 1 },     // 追加一击的伤害比例
  reflect: { weak: 50, strong: 100 },  // 反弹所受反击的比例 %
}
const TAG_DESC = {
  leech: { weak: '本次伤害的 8% 转为自身 HP', strong: '本次伤害的 15% 转为自身 HP' },
  guard: { weak: '下一次反击伤害 -50%', strong: '免疫一次反击' },
  surge: { weak: '本次攻击按"连击 +2"计算加成', strong: '本次攻击按"连击 +4"计算加成' },
  crit: { weak: '本次伤害 ×2', strong: '本次伤害 ×2.5' },
  pierce: { weak: '本次无视敌方护甲与护盾格挡', strong: '无视减伤，且额外削 1 层' },
  rend: { weak: '永久削敌方 1 层护甲或护盾', strong: '永久削 2 层' },
  aim: { weak: '本次无视闪避', strong: '无视闪避，且无视护盾减半' },
  chase: { weak: '追加一次 50% 伤害（不触发反击）', strong: '追加一次 100% 伤害（不触发反击）' },
  reflect: { weak: '本回合所受反击的 50% 反弹', strong: '本回合所受反击的 100% 反弹' },
}

// ============================ 组合（12 条配对 + 1 条共鸣） ============================
// 规则：只看"已上阵的 4 本"里是否同时存在这两个标签 —— 不要求相邻、不要求指定书名
const COMBOS = [
  { id: 'rampage', name: '暴走', tags: ['crit', 'surge'], desc: '暴击时连击计数 +1' },
  { id: 'armor_break', name: '破防重击', tags: ['pierce', 'crit'], desc: '暴击无视护甲与护盾' },
  { id: 'sustain', name: '续航', tags: ['leech', 'guard'], desc: '满血时吸血量转为护盾' },
  { id: 'chain', name: '连环', tags: ['chase', 'surge'], desc: '追击命中也计入连击 +1' },
  { id: 'lethal', name: '致命', tags: ['aim', 'crit'], desc: '命中且暴击时伤害再 ×1.1' },
  { id: 'shatter', name: '粉碎', tags: ['rend', 'pierce'], desc: '护盾被贯穿时直接清零' },
  { id: 'iron_wall', name: '铁壁', tags: ['reflect', 'guard'], desc: '反弹的同时反击伤害再 -25%' },
  { id: 'blood_debt', name: '血偿', tags: ['leech', 'reflect'], desc: '反弹伤害的 50% 转为自身 HP' },
  { id: 'afterimage', name: '重影', tags: ['chase', 'crit'], desc: '追击也吃本次暴击倍率' },
  { id: 'lock_on', name: '锁影', tags: ['aim', 'chase'], desc: '追击必定命中（无视闪避）' },
  { id: 'momentum', name: '气势', tags: ['surge', 'leech'], desc: '按"连击 +2"计算，且吸血随连击每连 +1%' },
  { id: 'eye_for_eye', name: '以牙还牙', tags: ['rend', 'reflect'], desc: '反弹伤害无视敌方护甲' },
]
const RESONANCE = { expect: { common: 0.05, rare: 0.05, epic: 0.05, legendary: 0.1 } } // 4 槽同档加成（全传说 10%）

// 倍率：普通 = 1.00 = 普攻（保证"装书永不劣于不装"），区间刻意收窄到 1.00~1.30
const SKILL_POWER = { common: 1, rare: 1.1, epic: 1.2, legendary: 1.3 }
// 出手权重：高稀有度 = 更低概率 + 更高倍率（低概率高倍率 = 重击高光）
const SKILL_WEIGHT = { common: 4, rare: 3, epic: 2, legendary: 1 }
// 演出档（技能特效的强度刻度）：轻 = 普通 / 中 = 稀有 / 重 = 史诗·传说（与 strong 同源）
const SKILL_TIER = { common: 1, rare: 2, epic: 3, legendary: 3 }

// ============================ 招式（第五刀·表现） ============================
// 每本书配一个"招式原语"：12 个共享原语 + 逐本指派（**纯表现，不参与任何数值结算**）。
// 硬约束：同一个标签下的书**不许用同一个原语**（同标签的书玩家最容易放一起比较，撞脸立刻被看出来）；
// 12 个原语各自怎么画见 docs/游戏升级规划/10-技能书与技能库设计.md「八·补·五」。
const FORM_PRIMITIVES = [
  'bolt', 'thrust', 'slash', 'burst', 'drip', 'stamp',
  'ward', 'vortex', 'stack', 'chars', 'boomerang', 'hail',
]
// 逐本指派：50 本**全部显式指定**（不再靠标签兜底），按标签分组排——「同标签内不重复」
// 由 tools/test-extension.js 的「技能书原语指派」自检断言。加新书时挑本标签还没占用的原语；
// 跨标签撞原语是允许的（约束只在同标签内，见文件末尾那条 ⚠️）。
const SKILL_FORMS = {
  // —— 精准 aim ——
  print_debug: 'chars',          // 打印大法 → 打印出一行像素字块
  paste_stackoverflow: 'stack',  // 复制粘贴术 → 一段段代码往上叠
  breakpoint_trap: 'stamp',      // 断点陷阱 → 啪一下盖个断点印
  binary_search: 'thrust',       // 二分定位 → 一条直线直插中点
  race_radar: 'vortex',          // 竞态雷达 → 雷达转圈扫描

  // —— 护盾 guard ——
  try_catch: 'boomerang',        // 捕获兜底 → 把异常兜住再抛回去
  sleep_retry: 'stamp',          // 睡一秒 → Z 字印戳从头顶砸下
  mock_data: 'chars',            // 假数据面具 → 变出一块假字糊上去
  linter_shield: 'ward',         // 格式护盾 → 规则围成一圈结界
  shield_aura: 'burst',          // 护盾光环 → 光环一圈圈脉冲推开
  unit_test_ward: 'stack',       // 单测结界 → 断言一层层叠成墙
  schema_guard: 'bolt',          // 模式约束 → 不合规就地落雷
  immutable_truth: 'vortex',     // 不可变真理 → 往中心收成一颗核

  // —— 回复 leech ——
  rubber_duck: 'chars',          // 小黄鸭 → 鸭子冒出一句反问
  hotfix_tape: 'stamp',          // 胶带热修 → 啪一下贴上胶带
  print_sleep: 'hail',           // 打印个寂寞 → 只飘出几粒没用的点
  cache_warm: 'burst',           // 缓存预热 → 从中心热扩散出去
  graceful_degrade: 'ward',      // 优雅降级 → 降级时先亮一圈护罩
  drain_life_patch: 'vortex',    // 补丁吸血 → 血被抽成漩涡
  gc_finalizer: 'drip',          // 终结清理 → 回收液滴落

  // —— 破甲 rend ——
  git_blame: 'boomerang',        // 甩锅回溯 → 锅甩出去再飞回来
  if_else_tower: 'stack',        // if-else 高塔 → 一层层 else 叠成塔
  type_guard: 'ward',            // 类型守卫 → 立在身前的盾
  arch_master: 'vortex',         // 架构之眼 → 眼瞳漩涡收束

  // —— 贯穿 pierce ——
  console_log: 'bolt',           // 控制台神谕 → 神谕自天而降
  semicolon_ward: 'ward',        // 分号结界 → 一圈分号围成结界
  stack_trace: 'stack',          // 调用栈 → 三层虚线方块逐层叠压
  null_check: 'burst',           // 空值校验 → 空值当场炸开
  profiler_blade: 'slash',       // 剖析利刃 → 一刀斜斩
  root_access: 'thrust',         // 根权限 → 直插根目录

  // —— 连击增幅 surge ——
  todo_comment: 'stamp',         // 待办符咒 → TODO 盖个戳
  comment_out: 'chars',          // 注释大法 → // 一串注释字块
  retry_backoff: 'thrust',       // 退避重试 → 退一步再冲一次
  combo_finisher: 'slash',       // 连击终结 → 收尾那一斩
  infinite_refactor: 'vortex',   // 无限重构 → 无限回环

  // —— 必暴 crit ——
  regex_magic: 'chars',          // 正则玄学 → 正则字符乱蹦
  assert_self: 'stamp',          // 自我断言 → 断言通过盖戳
  stress_test: 'hail',           // 压测狂魔 → 狂轰滥炸
  memory_profiler: 'vortex',     // 内存剖析 → 扫描向心收束
  crit_focus: 'bolt',            // 专注瞄准 → 单点落雷
  overload_burst: 'burst',       // 过载爆发 → 过载炸开

  // —— 追击 chase ——
  force_push: 'thrust',          // 强制推送 → 强行推入
  shadow_strike: 'slash',        // 暗影突袭 → 暗影一刀
  log_trace: 'hail',             // 埋点追踪 → 多点骤雨
  chaos_monkey: 'boomerang',     // 混沌猴子 → 扔出去再飞回
  hello_world: 'chars',          // Hello, World → 像素字块带引号弹出

  // —— 反震 reflect ——
  off_by_one_patch: 'boomerang', // 差一补丁 → 补丁贴片回旋贴回
  reboot_chant: 'ward',          // 重启咒语 → 重启时整个护罩
  load_balancer: 'hail',         // 负载均衡 → 请求分发到多点
  zero_downtime: 'stack',        // 零停机发布 → 灰度一层层上
  // ⚠️ arch_master 与 infinite_refactor 同原语但不同标签：允许（约束只在"同标签内"）
}
// 标签兜底：未指派的书先用标签的默认招式，保证任何一本都能画出效果
const TAG_FALLBACK_FORM = {
  leech: 'drip', guard: 'ward', surge: 'vortex', crit: 'burst',
  pierce: 'thrust', rend: 'slash', aim: 'thrust', chase: 'hail', reflect: 'boomerang',
}

const SKILL_INDEX = {}
const SKILL_RARITY_COUNTS = { common: 0, rare: 0, epic: 0, legendary: 0 }
for (const sk of SKILLS) {
  SKILL_INDEX[sk.id] = sk
  sk.story = STORIES[sk.id] || '' // 技能注记（skills-stories.js，≤40 字）
  sk.power = SKILL_POWER[sk.rarity] || 1
  sk.weight = SKILL_WEIGHT[sk.rarity] || 1
  sk.tier = SKILL_TIER[sk.rarity] || 1
  sk.form = SKILL_FORMS[sk.id] || TAG_FALLBACK_FORM[sk.tag] || 'burst'
  sk.tagLabel = TAG_LABEL[sk.tag] || sk.tag
  SKILL_RARITY_COUNTS[sk.rarity] += 1
}
const SKILL_TOTAL = SKILLS.length

// ============================ 掉落 ============================
const SKILL_DROP_RATE = 0.1 // 每次击败的掉书概率
const SKILL_PITY_LIMIT = 30 // 连续 30 只怪未出"稀有及以上" → 本次必掉一本稀有（兜底，不是主节奏）
const SKILL_RARITY_DROP = { common: 0.55, rare: 0.24, epic: 0.15, legendary: 0.06 }

function pickByRarity(rarity) {
  const pool = []
  for (const sk of SKILLS) if (sk.rarity === rarity) pool.push(sk)
  return pool[Math.floor(Math.random() * pool.length)]
}

function rollSkillRarity(pity) {
  if ((Number(pity) || 0) + 1 >= SKILL_PITY_LIMIT) return 'rare' // 保底：只给"稀有及以上"的稀有档
  const r = Math.random()
  const d = SKILL_RARITY_DROP
  if (r < d.common) return 'common'
  if (r < d.common + d.rare) return 'rare'
  if (r < d.common + d.rare + d.epic) return 'epic'
  return 'legendary'
}

// 每次击败调用一次：pity 按"只数"累计（未拿到稀有及以上就 +1）
// 返回 { skill: 书 | null, pity }；skill 为 null 表示本次没掉书（pity 继续累计）
function rollSkill(pity) {
  const cur = Math.max(0, Number(pity) || 0)
  const next = cur + 1
  if (next >= SKILL_PITY_LIMIT) {
    const skill = pickByRarity('rare')
    return { skill, pity: 0 }
  }
  if (Math.random() >= SKILL_DROP_RATE) return { skill: null, pity: next }
  const rarity = rollSkillRarity(cur)
  const skill = pickByRarity(rarity)
  return { skill, pity: rarity === 'common' ? next : 0 }
}

// ============================ 装配（4 槽） ============================
function emptySlots() {
  return [null, null, null, null]
}

// 归一化槽位：长度补齐到 4；只保留"已拥有"的书；同一 id 只保留第一处
function normalizeSlots(slots, owned) {
  const out = emptySlots()
  const used = {}
  const arr = Array.isArray(slots) ? slots : []
  for (let i = 0; i < 4; i++) {
    const id = arr[i]
    if (!id || !SKILL_INDEX[id] || used[id]) continue
    if (owned && !owned[id]) continue
    out[i] = id
    used[id] = true
  }
  return out
}

// 参与抽签的书（跳过空槽）；0 本 = 普攻
function filledSlots(slots) {
  const out = []
  for (const id of slots || []) if (id && SKILL_INDEX[id]) out.push(SKILL_INDEX[id])
  return out
}

// 期望倍率：按权重加权平均；空槽不参与；4 槽同档加共鸣
function slotExpect(slots) {
  const list = filledSlots(slots)
  if (!list.length) return 1
  let wsum = 0
  let wpow = 0
  for (const sk of list) {
    wsum += sk.weight
    wpow += sk.weight * sk.power
  }
  let e = wpow / wsum
  if (list.length === 4) {
    const r = list[0].rarity
    if (list.every((sk) => sk.rarity === r)) e += RESONANCE.expect[r] || 0
  }
  return Math.round(e * 100) / 100
}

// 已触发的组合（按 COMBOS 顺序）
function combosOf(slots) {
  const tags = {}
  for (const sk of filledSlots(slots)) tags[sk.tag] = true
  return COMBOS.filter((c) => c.tags.every((k) => tags[k]))
}

// 出手抽签（第二刀接入战斗）：从已装的书里按权重随机 1 本；0 本返回 null（= 普攻）
function pickSkillBook(slots) {
  const list = filledSlots(slots)
  if (!list.length) return null
  let total = 0
  for (const sk of list) total += sk.weight
  let r = Math.random() * total
  for (const sk of list) {
    r -= sk.weight
    if (r <= 0) return sk
  }
  return list[list.length - 1]
}

// ============================ 出手（第二刀） ============================
// 出手上下文：抽到哪本 + 生效的标签 + 已触发组合 + 稀有度共鸣
// ⚠️ 组合按"已上阵的 4 本"判定（与抽出哪一本无关，见设计文档第四节）
// 0 槽 = 普攻：book 为 null、power 为 1.00、无标签
function castContext(slots) {
  const list = filledSlots(slots)
  const book = pickSkillBook(slots)
  const tags = {}
  if (book) tags[book.tag] = true
  const combos = combosOf(slots)
  let resonance = 1
  if (list.length === 4) {
    const r = list[0].rarity
    if (list.every((sk) => sk.rarity === r)) resonance = 1 + (RESONANCE.expect[r] || 0)
  }
  const strong = !!(book && (book.rarity === 'epic' || book.rarity === 'legendary'))
  // 表现层（技能特效）要用：抽中那本在 4 槽里的位置（-1 = 普攻），以及「轻/中/重」演出档
  const slot = book ? slots.findIndex((id) => id === book.id) : -1
  const tier = book ? (SKILL_TIER[book.rarity] || 1) : 0
  return { book, tags, combos, resonance, strong, power: book ? book.power : 1, slot, tier }
}

// 标签数值（弱档 = 普通/稀有，强档 = 史诗/传说）
function tagValue(tag, strong) {
  const t = TAG_POWER[tag]
  if (!t) return 0
  return strong ? t.strong : t.weak
}

// 某个组合是否已触发（按 id 判定，供战斗结算使用）
function hasCombo(combos, id) {
  for (const c of combos || []) if (c.id === id) return true
  return false
}

// 一键推荐：在已拥有的书里挑期望最高的一组（含组合加成估值）
// 候选先按倍率降序截断到 12 本，再穷举 C(12,4) = 495 组，结果稳定可复现
function autoSlots(owned) {
  const pool = []
  for (const sk of SKILLS) if (owned && owned[sk.id]) pool.push(sk)
  pool.sort((a, b) => b.power - a.power || (a.id < b.id ? -1 : 1))
  const cand = pool.slice(0, 12)
  const best = { slots: emptySlots(), score: -1 }
  const n = cand.length
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const pick = [cand[a].id, cand[b].id, cand[c].id, cand[d].id]
          const slots = normalizeSlots(pick, owned)
          const score = slotExpect(slots) + combosOf(slots).length * 0.03
          if (score > best.score) {
            best.score = score
            best.slots = slots
          }
        }
      }
    }
  }
  // 不足 4 本时按倍率顺序补满剩余槽
  if (n < 4) {
    const ids = cand.map((sk) => sk.id)
    return normalizeSlots(ids, owned)
  }
  return best.slots
}

// ============================ 素材（与武器同管线） ============================
// mode：true/'full' 填满 24（战斗槽）；'box' 缩放到 17 内框（图鉴网格）；falsy 原始留白
const SPRITE_CACHE = new Map()
function skillSpriteGrid(id, mode) {
  const key = id + '|' + (mode === true ? 'full' : mode || 'raw')
  if (SPRITE_CACHE.has(key)) return SPRITE_CACHE.get(key)
  const data = SKILL_PIXEL_DATA[id]
  let grid = null
  if (data) {
    grid = data.rows.map((row) => [...row].map((ch) => (ch === '.' ? null : data.palette[parseInt(ch, 36)] || null)))
    if (mode === 'box') grid = fitToBox(grid, 17)
    else if (mode) grid = fitToBox(grid, 24)
  }
  SPRITE_CACHE.set(key, grid)
  return grid
}

module.exports = {
  SKILLS, SKILL_INDEX, SKILL_TOTAL, SKILL_RARITY_COUNTS,
  SKILL_POWER, SKILL_WEIGHT, SKILL_TIER, FORM_PRIMITIVES, SKILL_FORMS, TAG_FALLBACK_FORM,
  SKILL_DROP_RATE, SKILL_PITY_LIMIT, SKILL_RARITY_DROP, rollSkill, rollSkillRarity,
  TAG_KEYS, TAG_LABEL, TAG_POWER, TAG_DESC,
  COMBOS, RESONANCE,
  emptySlots, normalizeSlots, filledSlots, slotExpect, combosOf, pickSkillBook, autoSlots,
  castContext, tagValue, hasCombo,
  skillSpriteGrid,
}
