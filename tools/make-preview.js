#!/usr/bin/env node
'use strict'
// make-preview.js — 从 media/panel.html 生成 media/preview.html（本地预览用）
//
// preview.html 与 panel.html 结构完全一致，只多了一段 mock 数据脚本：
//   window.__NIBBLE_MOCK__      → 战斗页假状态（主角 + 一只精英 + 一把武器）
//   window.__NIBBLE_MOCK_MSGS__ → 怪物库全量数据（走与宿主相同的 onMessage 逻辑）
// 因此本地打开 preview.html 即可核验战斗页 / 武器库 / 怪物库三种视图的布局。
//
// 用法：node tools/make-preview.js
// 注意：preview.html 是开发辅助产物（可再生），改 panel.html 后重跑本脚本即可。

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const media = path.join(root, 'vscode-extension', 'media')
const sp = require(path.join(root, 'plugins', 'nibble', 'hooks', 'nibble.js'))

const flat = (grid) => {
  const out = []
  const n = grid.length
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out.push((grid[r] && grid[r][c]) || '')
  return out
}

// —— 战斗页：拿一只精英（竞态幽灵）当对手，并挂一把稀有武器 ——
const currentId = sp.ENEMY_INDEX.race_condition ? 'race_condition' : sp.ENEMIES[0].id
const info = sp.enemyInfo(currentId)
const wpn = sp.WEAPON_INDEX.refactor_blade || sp.WEAPONS[0]
const state = {
  player: flat(sp.decodeGrid('player').grid),
  enemy: flat(sp.enemyGrid(currentId, 'epic', false)),
  level: 12,
  exp: 96,
  xpNeed: sp.xpNeed(12),
  hp: 74,
  maxHp: 168,
  enemyType: currentId,
  enemyName: info.name,
  enemyTier: info.tier,
  enemyTierLabel: info.tierLabel,
  enemyMech: info.mechText,
  rarityLabel: '史诗',
  rarity: 'epic',
  rarityColor: sp.RARITY_COLOR.epic,
  battles: 128,
  defeats: 41,
  log: 'Nibble 攻击！' + info.name + ' -14 HP（×12 连击）',
  // 连击演示值：预览页直接能看到「脚下光环 + 头顶徽标」（真机由扩展按存档推送）
  streak: 12,
  streakTier: 1,
  streakBonus: 12,
  lastDmg: 14,
  arsenal: sp.arsenalSummary({ level: 12, arsenal: { owned: { [wpn.id]: 1 }, pity: 13 }, lastDrop: null, equipped: null }),
  weaponSprite: flat(sp.weaponSpriteGrid(wpn.id, true)),
  weaponName: wpn.name,
  weaponRarity: wpn.rarity,
  weaponPower: wpn.power,
  weaponColor: sp.RARITY_COLOR[wpn.rarity],
  // 风险层（第三刀）：预览页给一组玩家血量，好核对数值区与状态栏口径
  playerHp: 62,
  playerMaxHp: sp.playerMaxHp(12),
}

// —— 怪物库：造出一半进度，覆盖"未遭遇 / 已遭遇未击败 / 已击败"三种格子状态 ——
const seen = {}
const defeated = {}
sp.ENEMIES.forEach((e, i) => {
  if (i % 3 === 2) return // 约 1/3 未遭遇
  seen[e.id] = { first: 1760000000000 - (40 - i) * 3600000, count: 1 + (i % 4) }
  if (i % 4 !== 3) defeated[e.id] = 1 + (i % 3) // 一部分只遭遇未击败
})
const sprites = {}
for (const e of sp.ENEMIES) sprites[e.id] = flat(sp.enemyGrid(e.id, 'common', false))
const bestiaryData = {
  type: 'bestiaryData',
  seen,
  defeated,
  current: currentId,
  list: sp.ENEMIES.map((e) => ({
    id: e.id,
    name: e.name,
    tier: e.tier,
    minLv: e.minLv,
    story: e.story || '',
    mechText: sp.mechSummary(e),
  })),
  sprites,
}

// 武器库 mock：造一批已收集（覆盖"已收集 / 未收集"两种格子）
const ownedMock = {}
sp.WEAPONS.forEach((w, i) => {
  if (i % 3 !== 1) ownedMock[w.id] = 1 + (i % 3)
})
ownedMock[wpn.id] = 1 // 当前携带的那把必然已拥有（否则详情卡会自相矛盾）

// 技能书 mock：约 2/3 已收集 + 4 槽已上阵（含组合），覆盖"未收集 / 已收集 / 已上阵"三种格子状态
const skillOwned = {}
sp.SKILLS.forEach((sk, i) => {
  if (i % 3 !== 2) skillOwned[sk.id] = 1 + (i % 2)
})
const slotIds = ['crit_focus', 'combo_finisher', 'stack_trace', 'shield_aura'].filter((id) => sp.SKILL_INDEX[id])
const skillSlots = [null, null, null, null]
slotIds.forEach((id, i) => {
  skillOwned[id] = Math.max(1, skillOwned[id] || 0)
  if (i < 4) skillSlots[i] = id
})
const skillSprites = {}
for (const sk of sp.SKILLS) {
  const g = sp.skillSpriteGrid(sk.id, 'box')
  skillSprites[sk.id] = g ? flat(g) : null
}
const skillData = {
  type: 'skillData',
  owned: skillOwned,
  pity: sp.SKILL_PITY_LIMIT - 4,
  pityLimit: sp.SKILL_PITY_LIMIT,
  slots: skillSlots,
  expect: sp.slotExpect(skillSlots),
  combos: sp.combosOf(skillSlots).map((c) => ({ id: c.id, name: c.name, desc: c.desc })),
  guide: false,
  list: sp.SKILLS.map((sk) => ({
    id: sk.id, name: sk.name, rarity: sk.rarity, tag: sk.tag, tagLabel: sk.tagLabel,
    power: sk.power, weight: sk.weight, story: sk.story || '',
  })),
  sprites: skillSprites,
  tags: sp.TAG_LABEL,
  tagDesc: sp.TAG_DESC,
  combosAll: sp.COMBOS,
}

// 技能施放样张（预览页轮播）：直接取真实书名/标签/配色，与技能库页面自洽（不给假书名）。
// 第五刀起轮播**12 个招式原语各一发**（每个原语挑一本真实书），顺带覆盖 9 个标签的特效字段。
const FX_SAMPLE = {
  crit: { crit: true }, chase: { chase: true }, pierce: { pierce: true }, rend: { rend: 2 },
  aim: { aim: true }, leech: { leech: true, heal: 6 }, guard: { guard: 'half' },
  surge: { surge: true }, reflect: { reflect: 9 },
}
const seenForms = {}
const castSamples = []
for (const sk of sp.SKILLS) {
  if (castSamples.length >= 12) break
  if (seenForms[sk.form]) continue
  seenForms[sk.form] = true
  castSamples.push({
    id: sk.id,
    slot: castSamples.length % 4,
    dmg: 20 + (castSamples.length * 7) % 27,
    fx: FX_SAMPLE[sk.tag] || { crit: true },
  })
}
const previewCasts = castSamples.map((s) =>
  Object.assign({
    id: s.id,
    name: (sp.SKILL_INDEX[s.id] || { name: s.id }).name,
    tag: (sp.SKILL_INDEX[s.id] || {}).tag || 'crit',
    tagLabel: (sp.SKILL_INDEX[s.id] || {}).tagLabel || '',
    rarity: (sp.SKILL_INDEX[s.id] || {}).rarity || 'common',
    color: sp.RARITY_COLOR[(sp.SKILL_INDEX[s.id] || {}).rarity] || '#ffd75e',
    tier: sp.SKILL_TIER[(sp.SKILL_INDEX[s.id] || {}).rarity] || 1,
    power: (sp.SKILL_INDEX[s.id] || {}).power || 1,
    form: (sp.SKILL_INDEX[s.id] || {}).form || 'burst',
    icon: skillSprites[s.id] || null, // 施放横幅的书图标（与真机 cast 消息同字段）
    combos: [],
  }, s),
)

// 生成预览页：panel.html 结构 + mock 数据脚本
function buildPreview() {
  const html = fs.readFileSync(path.join(media, 'panel.html'), 'utf8')
  // 80 把武器的 sprites 共享同一张网格（只序列化一次），否则 preview.html 会膨胀到几百 KB
  const inject =
    '<script>(function(){' +
    'var wp=' + JSON.stringify(flat(sp.weaponSpriteGrid(wpn.id, true))) + ';' +
    'var ids=' + JSON.stringify(sp.WEAPONS.map((w) => w.id)) + ';' +
    'var sprites={};ids.forEach(function(id){sprites[id]=wp});' +
    'var arsenal={type:"arsenalData",owned:' + JSON.stringify(ownedMock) +
    ',pity:13,pityLimit:' + sp.PITY_LIMIT +
    ',equipped:null,shown:{id:' + JSON.stringify(wpn.id) + ',name:' + JSON.stringify(wpn.name) +
    ',rarity:' + JSON.stringify(wpn.rarity) + ',power:' + wpn.power + '}' +
    ',atkBase:' + state.arsenal.atkBase + ',atkTotal:' + state.arsenal.atkTotal +
    ',list:' + JSON.stringify(sp.WEAPONS) + ',sprites:sprites};' +
    'window.__NIBBLE_MOCK__=' + JSON.stringify(state) + ';' +
    'window.__NIBBLE_MOCK_MSGS__=[' + JSON.stringify(bestiaryData) + ',arsenal,' + JSON.stringify(skillData) + '];' +
    // 技能施放样张：预览页每 2.6 秒轮播一发，展示横幅 / 4 槽高亮 / 场景光环与标签特效
    'window.__NIBBLE_PREVIEW_CASTS__=' + JSON.stringify(previewCasts) + ';' +
    '})();</script>\n' +
    '<script src="pet.js"></script>\n'
  const out = path.join(media, 'preview.html')
  // 新面板里的占位符：本地预览换成相对路径（真机由 extension.js 换成 asWebviewUri）
  const filled = html
    .replace('<!--SCENE_CSS-->', '<link rel="stylesheet" href="scene.css">')
    .replace('<!--SCENE_JS-->', '<script src="scene.js"></script>')
    .replace('</body>', inject + '</body>')
  fs.writeFileSync(out, filled, 'utf8')
  console.log('✓ 已生成 ' + out + '（' + sp.ENEMY_TOTAL + ' 只怪物 mock）')
  return out
}

module.exports = { buildPreview }
if (require.main === module) buildPreview()
