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
  log: 'Nibble 攻击！' + info.name + ' -14 HP（闪避）',
  arsenal: sp.arsenalSummary({ level: 12, arsenal: { owned: { [wpn.id]: 1 }, pity: 13 }, lastDrop: null, equipped: null }),
  weaponSprite: flat(sp.weaponSpriteGrid(wpn.id, true)),
  weaponName: wpn.name,
  weaponRarity: wpn.rarity,
  weaponPower: wpn.power,
  weaponColor: sp.RARITY_COLOR[wpn.rarity],
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
    'window.__NIBBLE_MOCK_MSGS__=[' + JSON.stringify(bestiaryData) + ',arsenal];' +
    '})();</script>\n' +
    '<script src="pet.js"></script>\n'
  const out = path.join(media, 'preview.html')
  fs.writeFileSync(out, html.replace('</body>', inject + '</body>'), 'utf8')
  console.log('✓ 已生成 ' + out + '（' + sp.ENEMY_TOTAL + ' 只怪物 mock）')
  return out
}

module.exports = { buildPreview }
if (require.main === module) buildPreview()
