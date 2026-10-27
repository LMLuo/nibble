'use strict'
// nibble IDE 扩展 —— 把像素小生物做成**常驻 UI**（底部面板停靠视图 + 底部状态栏）
//
// 分工：hooks 负责"提问即攻击"的游戏推进（写 save.json），本扩展只负责**显示**（读同一份存档）。
// 因此展示是常驻的、自动动画的，而且**不消耗任何 token**。
// 像素素材与渲染逻辑复用 plugins/nibble/hooks/nibble.js（单一数据源）。

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const telemetry = require('./telemetry')

const VIEW_ID = 'nibble.petView'
const MEDIA = () => path.join(__dirname, 'media')

let sp = null
let panel = null // 编辑器标签页版
let viewWebview = null // 底部面板停靠版
let statusItem = null
let timer = null
let frame = 0
let lungeTicks = 0
let dissolveTicks = 0
let lastBattles = -1
let lastDefeats = -1
let lastStreakTier = -1
let lastKey = ''
let lastDropAt = -1
let lastSkillDropAt = -1
let lastKnockbackAt = -1
let lastArsenalDefeats = -1
let lastBestiaryKey = ''
let lastSkillKey = ''
let lastCastAt = -1 // 技能出手（第四刀·表现）：本次施放的唯一时间戳，用于去重推 type:'cast'
let castPipe = null // 施放管线（第五刀·表现）：{ frames, phase } —— 相位时钟在宿主这边走（tickMs 可配置）

// 定位素材/渲染模块。顺序：
//   1) config.json 指向的工作区插件目录（本地开发时用，保持单一数据源）
//   2) 扩展自带的 lib/nibble.js（打包发布用，构建时由 install-extension.js 同步）
function loadShared() {
  if (sp) return sp
  const files = []
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
    if (cfg && cfg.pluginRoot) {
      files.push(path.join(cfg.pluginRoot, 'plugins', 'nibble', 'hooks', 'nibble.js'))
    }
  } catch { /* 没有 config.json（发布版）就用自带副本 */ }
  files.push(path.join(__dirname, 'lib', 'nibble.js'))
  files.push(path.join(__dirname, '..', 'plugins', 'nibble', 'hooks', 'nibble.js'))
  files.push(path.join(__dirname, '..', '..', 'plugins', 'nibble', 'hooks', 'nibble.js'))
  for (const file of files) {
    if (fs.existsSync(file)) {
      sp = require(file)
      return sp
    }
  }
  throw new Error('找不到 nibble.js（扩展缺少 lib/ 且 config.json 未指向插件目录）')
}

const flat = (grid) => {
  const out = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid.length; c++) out.push(grid[r][c] || '')
  }
  return out
}

function buildState() {
  const s = sp.reloadSave()
  const arsenal = sp.arsenalSummary(s)
  const skills = sp.skillSummary(s) // 技能书：收集 + 4 槽装配 + 出手倍率（标签效果见 10 文档 3.2.1）
  const sk = sp.streakState(s) // 连击（超 10 分钟窗口 = 0）
  const shown = sp.equippedWeapon(s) // 战斗页展示即生效：手动装备 → 否则自动取最高战力
  const weaponSprite = shown ? sp.weaponSpriteGrid(shown.id, true) : null
  const info = sp.enemyInfo(s.enemy.type)
  return {
    player: flat(sp.decodeGrid('player').grid),
    enemy: flat(sp.enemyGrid(s.enemy.type, s.enemy.rarity, false)),
    level: s.level,
    exp: s.exp,
    xpNeed: sp.xpNeed(s.level),
    hp: s.enemy.hp,
    maxHp: s.enemy.maxHp,
    enemyType: s.enemy.type,
    enemyName: info.name,
    enemyTier: info.tier,
    enemyTierLabel: info.tierLabel,
    enemyMech: info.mechText,
    bestiary: sp.bestiarySummary(s),
    rarityLabel: sp.RARITY_LABEL[s.enemy.rarity],
    rarity: s.enemy.rarity,
    rarityColor: sp.RARITY_COLOR[s.enemy.rarity],
    battles: s.battles,
    defeats: s.defeats,
    log: s.lastLog || 'Nibble 待命中…（向 CodeBuddy 提问即可发动攻击）',
    // 连击（面板光环/徽标用）：count 含窗口校验，过期自动回 0
    streak: sk.count,
    streakTier: sk.tier,
    streakBonus: sk.bonus,
    lastDmg: Math.max(0, Number(s.lastDmg) || 0), // 伤害飘字数值（0 = 未命中）
    // 换武器 / 最高战力变化也要触发推送，故把生效武器一并计入 key；连击数同理（徽标实时更新）
    // 技能书：收集数与 4 槽装配变化同样并入 key
    key: s.enemy.type + '|' + s.enemy.rarity + '|' + s.enemy.maxHp + '|' + s.battles +
      '|' + (s.equipped || '') + '|' + (shown ? shown.id : '') + '|' + sk.count +
      '|' + skills.owned + '|' + skills.slots.join(','),
    arsenal,
    skills,
    weaponSprite: weaponSprite ? flat(weaponSprite) : null,
    weaponName: shown ? shown.name : null,
    weaponRarity: shown ? shown.rarity : null,
    weaponPower: shown ? shown.power : 0, // 战力（百分比攻击加成）
    weaponColor: shown ? sp.RARITY_COLOR[shown.rarity] : null,
    // 风险层（第三刀）：玩家血量 / 被击退时间戳（归零 = 换新怪 + 断连击，零惩罚）
    playerHp: sp.playerHpOf(s),
    playerMaxHp: sp.playerMaxHp(s.level),
    knockbackAt: Number(s.knockbackAt) || 0,
    // 技能出手（第四刀·表现）：本次施放了哪本书 + 标签实际生效结果（at 去重后推 type:'cast'）
    lastCast: s.lastCast || null,
  }
}

// 武器库全量数据（80 把：清单 + 素材 + 收集进度），仅在掉落/收集变化时推送
function buildArsenalData(arsenal) {
  const sprites = {}
  for (const w of sp.WEAPONS) {
    const g = sp.weaponSpriteGrid(w.id, 'box') // 图鉴用统一内框，细长剑与胖锤视觉重量一致
    sprites[w.id] = g ? flat(g) : null
  }
  return {
    type: 'arsenalData',
    owned: arsenal.ownedMap,
    pity: arsenal.pity,
    pityLimit: arsenal.pityLimit,
    equipped: arsenal.equipped,
    shown: arsenal.shown,
    atkBase: arsenal.atkBase,
    atkTotal: arsenal.atkTotal,
    list: sp.WEAPONS,
    sprites,
  }
}

// 技能书全量数据（50 本：清单 + 素材 + 收集进度 + 4 槽），仅在收集/装配变化时推送
function buildSkillData(sum) {
  const sprites = {}
  for (const sk of sp.SKILLS) {
    // 技能书图鉴**不跟武器统一**：用满格 24 内框（作者定档，2026-10-14），
    // 24×24 的纹章在武器那套 17 内框下会糊，技能书的辨识度比"视觉重量一致"更重要
    const g = sp.skillSpriteGrid(sk.id, true)
    sprites[sk.id] = g ? flat(g) : null
  }
  return {
    type: 'skillData',
    owned: sum.ownedMap,
    pity: sum.pity,
    pityLimit: sum.pityLimit,
    slots: sum.slots,
    expect: sum.expect,
    combos: sum.combos,
    guide: sum.guide,
    list: sp.SKILLS.map((sk) => ({
      id: sk.id,
      name: sk.name,
      rarity: sk.rarity,
      tag: sk.tag,
      tagLabel: sk.tagLabel,
      power: sk.power,
      weight: sk.weight,
      story: sk.story || '',
    })),
    sprites,
    tags: sp.TAG_LABEL,
    tagDesc: sp.TAG_DESC,
    combosAll: sp.COMBOS,
  }
}

// 怪物库全量数据（40 只：清单 + 素材 + 遭遇/击败双状态），仅在收集状态变化时推送
function buildBestiaryData(sum, currentId) {
  const sprites = {}
  for (const e of sp.ENEMIES) sprites[e.id] = flat(sp.enemyGrid(e.id, 'common', false))
  return {
    type: 'bestiaryData',
    seen: sum.seenMap,
    defeated: sum.defeatedMap,
    current: currentId || null,
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
}

const post = (webview, msg) => {
  try {
    if (webview) webview.postMessage(msg)
  } catch { /* webview 可能已销毁 */ }
}

function tick() {
  if (!sp) return
  let st
  try {
    st = buildState()
  } catch {
    return
  }
  frame = (frame + 1) % 2

  // 检测节拍：攻击 → 前冲；击败 → 敌方消散闪烁 + 战利品提示
  if (lastBattles !== -1 && st.battles > lastBattles) lungeTicks = 3
  if (lastDefeats !== -1 && st.defeats > lastDefeats) dissolveTicks = 6
  lastBattles = st.battles
  lastDefeats = st.defeats
  if (lungeTicks > 0) lungeTicks--
  if (dissolveTicks > 0) dissolveTicks--
  // 超载演出：连击档位「跨入 ≥50」的那一次推一条 burst（断连后重新攒到会再触发一次）
  const burst = lastStreakTier >= 0 && lastStreakTier < 3 && st.streakTier >= 3
  lastStreakTier = st.streakTier

  // —— 状态栏（常驻，随攻击实时变化）——
  if (statusItem) {
    // 心形条 = 玩家 HP（第三刀改口径：敌人血量在面板血条与 tooltip 里看）
    const filled = Math.max(0, Math.min(8, Math.round((Math.max(0, st.playerHp) / st.playerMaxHp) * 8)))
    statusItem.text =
      '$(heart) Lv' + st.level + ' ' + '█'.repeat(filled) + '░'.repeat(8 - filled) +
      ' ' + st.playerHp + '/' + st.playerMaxHp + ' ' + st.enemyName
    const last = st.arsenal.last
    statusItem.tooltip =
      'Nibble · Lv' + st.level + '　攻击 ' + st.battles + ' 次　击败 ' + st.defeats + ' 次' +
      (st.streak >= sp.STREAK_T1 ? '　连击 ×' + st.streak + '（攻击 +' + st.streakBonus + '%）' : '') + '\n' + st.log +
      '\n玩家 HP ' + st.playerHp + '/' + st.playerMaxHp + '　敌方 HP ' + st.hp + '/' + st.maxHp +
      '\n⚔ 武器库 ' + st.arsenal.owned + '/' + st.arsenal.total + '　保底 ' + st.arsenal.pity + '/' + st.arsenal.pityLimit +
      '\n📖 技能书 ' + st.skills.owned + '/' + st.skills.total + '　已上阵 ' + st.skills.filled + '/4' +
      (st.skills.expect > 1 ? '（倍率 ×' + st.skills.expect.toFixed(2) + '）' : '') +
      (st.skills.guide ? '　← 有书未上阵，去「技能书」页装配' : '') +
      (last ? '\n最近获得：' + sp.RARITY_LABEL[last.rarity] + '·' + last.name : '') +
      '\n（点击显示底部面板）'
  }

  // —— 面板 / 停靠视图 ——
  const targets = [viewWebview, panel && panel.webview].filter(Boolean)
  if (!targets.length) return
  // 技能出手（第五刀·施放管线）：面板据此播"施放"反馈——4 槽高亮 + 施放横幅 + 场景光环/招式特效。
  // 只在真抽到书时推（普攻 lastCast 为 null），at 去重保证一次施放只推一次。
  // ⚠️ 必须**先推 cast、再推 state**：面板收到 cast 就冻结"命中前的旧值"，
  //    顺序反了会先闪一帧"血已经掉了 / 怪已经换了"。
  const cast = st.lastCast
  if (cast && cast.id && cast.at && cast.at !== lastCastAt) {
    lastCastAt = cast.at
    const fx = {
      crit: !!cast.crit, chase: !!cast.chase, pierce: !!cast.pierce, aim: !!cast.aim,
      rend: Number(cast.rend) || 0, guard: cast.guard || null, leech: !!cast.leech,
      surge: !!cast.surge, heal: Number(cast.heal) || 0, reflect: Number(cast.reflect) || 0,
    }
    // 击杀时把"被打死的那只"一并带上：命中帧之前面板要继续画它，不能提前换成新怪
    let killedEnemy = null
    if (cast.killed && cast.enemyType) {
      const kInfo = sp.enemyInfo(cast.enemyType)
      killedEnemy = {
        type: cast.enemyType,
        tier: kInfo.tier, // 场景主题也跟着冻结（新怪可能是另一个 tier）
        rarity: cast.enemyRarity,
        rarityLabel: sp.RARITY_LABEL[cast.enemyRarity] || '',
        color: sp.RARITY_COLOR[cast.enemyRarity] || null,
        name: kInfo.name,
        tierLabel: kInfo.tierLabel,
        sprite: flat(sp.enemyGrid(cast.enemyType, cast.enemyRarity, false)),
      }
    }
    // 施放管线（第五刀）：起手 → 生成 → 命中 →（有追击才加）追击 →（有反击才加）反击
    const frames = 3 + (cast.chase ? 1 : 0) + (cast.countered ? 1 : 0)
    targets.forEach((w) => post(w, {
      type: 'cast',
      id: cast.id,
      name: cast.name,
      rarity: cast.rarity,
      color: sp.RARITY_COLOR[cast.rarity],
      icon: flat(sp.skillSpriteGrid(cast.id, true)), // 施放横幅上的书图标（满格 24，与图鉴同口径）
      tier: cast.tier,
      tag: cast.tag,
      tagLabel: (sp.TAG_LABEL && sp.TAG_LABEL[cast.tag]) || cast.tag,
      slot: cast.slot,
      power: cast.power,
      form: cast.form || '', // 招式原语（第五刀）：12 选 1
      dmg: Number(cast.dmg) || 0,
      combos: (cast.combos || []).map((id) => {
        const c = (sp.COMBOS || []).filter((x) => x.id === id)[0]
        return c ? c.name : id
      }),
      frames,
      impactAt: 2,
      countered: !!cast.countered, // 未死 → 末帧是"怪物反击"拍（玩家 HP 在这一拍才解冻）
      // 出手前快照：命中帧之前，面板与场景冻结显示这些旧值
      hpBefore: Number(cast.hpBefore) || 0,
      maxHpBefore: Number(cast.maxHpBefore) || 0,
      playerHpBefore: Number(cast.playerHpBefore) || 0,
      killed: !!cast.killed,
      killedEnemy,
      fx,
    }))
    // 相位时钟：本 tick 的 tick 消息带 phase 0，之后每 tick +1，播完即清
    castPipe = { frames, phase: 0 }
  }
  if (st.key !== lastKey) {
    lastKey = st.key
    targets.forEach((w) => post(w, Object.assign({ type: 'state' }, st)))
  }
  // 超载演出（场景闪白 + COMBO 横幅 + 数据块飞散）
  if (burst) targets.forEach((w) => post(w, { type: 'burst', combo: st.streak }))
  // 掉落瞬间：推战利品消息（面板弹 toast，史诗以上带特效）
  const lastDrop = st.arsenal.last
  if (lastDrop && lastDrop.at && lastDrop.at !== lastDropAt) {
    lastDropAt = lastDrop.at
    // 图标必须是「这把新掉的武器」，不能复用 st.weaponSprite（那是当前装备/最高战力那把）
    const dropGrid = sp.weaponSpriteGrid(lastDrop.id, true)
    const msg = {
      type: 'drop',
      name: lastDrop.name,
      rarity: lastDrop.rarity,
      color: sp.RARITY_COLOR[lastDrop.rarity],
      rarityLabel: sp.RARITY_LABEL[lastDrop.rarity],
      story: lastDrop.story,
      sprite: dropGrid ? flat(dropGrid) : null,
    }
    targets.forEach((w) => post(w, msg))
  }
  // 被击退（第三刀）：闪白 + 敌人消散帧（一次性演出），不弹 toast（日志里已有整句）
  if (st.knockbackAt && st.knockbackAt !== lastKnockbackAt) {
    lastKnockbackAt = st.knockbackAt
    targets.forEach((w) => post(w, { type: 'knockback' }))
  }
  // 技能书掉落：与武器 toast 共用通道（用 kind 区分文案）
  const skillDrop = st.skills.last
  if (skillDrop && skillDrop.at && skillDrop.at !== lastSkillDropAt) {
    lastSkillDropAt = skillDrop.at
    const grid = sp.skillSpriteGrid(skillDrop.id, true)
    targets.forEach((w) => post(w, {
      type: 'drop',
      kind: 'skill',
      name: skillDrop.name,
      rarity: skillDrop.rarity,
      color: sp.RARITY_COLOR[skillDrop.rarity],
      rarityLabel: sp.RARITY_LABEL[skillDrop.rarity],
      story: skillDrop.story,
      sprite: grid ? flat(grid) : null,
    }))
  }
  // 武器库数据：击败数变化（=新掉落入库）时推送全量
  if (lastArsenalDefeats !== st.defeats) {
    lastArsenalDefeats = st.defeats
    const data = buildArsenalData(st.arsenal)
    targets.forEach((w) => post(w, data))
  }
  // 技能书数据：收集数 / 4 槽装配变化时推送全量
  const skillKey = st.skills.owned + '|' + st.skills.slots.join(',')
  if (skillKey !== lastSkillKey) {
    lastSkillKey = skillKey
    const data = buildSkillData(st.skills)
    targets.forEach((w) => post(w, data))
  }
  // 怪物库数据：遭遇/击败状态变化时推送全量
  const bestiaryKey = st.bestiary.seen + '|' + st.bestiary.totalDefeats
  if (bestiaryKey !== lastBestiaryKey) {
    lastBestiaryKey = bestiaryKey
    const data = buildBestiaryData(st.bestiary, st.enemyType)
    targets.forEach((w) => post(w, data))
  }
  const t = {
    type: 'tick',
    frame,
    lunge: lungeTicks > 0,
    blink: (st.rarity === 'rare' || st.rarity === 'legendary') && frame === 0,
    dissolve: dissolveTicks > 0,
    hp: st.hp,
    maxHp: st.maxHp,
    level: st.level,
    log: st.log,
    // 风险层（第三刀）：面板把玩家 HP 显示在数值区，敌人血条继续用上方的 hp/maxHp
    playerHp: st.playerHp,
    playerMaxHp: st.playerMaxHp,
    // 施放管线（第五刀·表现）：本 tick 播到第几帧（0 = 起手，-1 = 没有在播）。
    // 相位时钟必须由宿主走：tickMs 是可配置的，面板自己数帧会跟节拍脱钩。
    castPhase: castPipe ? castPipe.phase : -1,
    // 小屋（家园）：只在面板切换视图时用一次。体积很小（6 件家具 × 3 个数字），
    // 跟着 tick 走比单开一条请求-响应通道简单。
    home: st.home || null,
  }
  // 相位推进放在"装好这条 tick 消息之后"：本 tick 推出去的相位要是**当前**这一帧
  if (castPipe && ++castPipe.phase >= castPipe.frames) castPipe = null
  targets.forEach((w) => post(w, t))
}

function buildHtml(webview, inView) {
  // 资源 URL 带版本号：webview 对 file:// 有磁盘缓存，换版本后旧脚本可能继续跑
  // （0.6.0 装机后"没攻击特效"就是这一类，加 ?v= 让每次换版强制重新拉取）
  const v = '?v=' + encodeURIComponent(require('./package.json').version)
  const petJs = String(webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), 'pet.js')))) + v
  // 战斗场景是独立模块（scene.css / scene.js）：官网不加载它们，所以官网面板保持原样
  const sceneCss = String(webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), 'scene.css')))) + v
  const sceneJs = String(webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), 'scene.js')))) + v
  // 小屋（家园）：脚本有严格顺序（像素数据 → 数据 → 逻辑 → 图集 → 后端 → 装配），不能打乱
  // furniture-pixels.js 是构建期产物，home-atlas.js 要用它；缺失时图集会回退到程序化绘制。
  const homeCss = String(webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), 'home.css')))) + v
  const homeJs = ['furniture-pixels.js', 'home-data.js', 'home-scene.js', 'home-atlas.js', 'home-gl.js', 'home-2d.js', 'home-view.js']
    .map((name) => '<script src="' + String(webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), name)))) + v + '"></script>')
    .join('\n')
  let html = fs.readFileSync(path.join(MEDIA(), 'panel.html'), 'utf8')
  html = html.replace('<!--PET_JS-->', '<script src="' + petJs + '"></script>')
  html = html.replace('<!--SCENE_CSS-->', '<link rel="stylesheet" href="' + sceneCss + '">')
  html = html.replace('<!--SCENE_JS-->', '<script src="' + sceneJs + '"></script>')
  html = html.replace('<!--HOME_CSS-->', '<link rel="stylesheet" href="' + homeCss + '">')
  html = html.replace('<!--HOME_JS-->', homeJs)
  if (inView) html = html.replace('<body>', '<body class="in-view">')
  return html
}

function wireMessages(webview) {
  webview.onDidReceiveMessage((msg) => {
    if (!msg) return
    if (msg.type === 'ready') {
      lastKey = ''
      tick()
    } else if (msg.type === 'attack') {
      doAttack(true)
    } else if (msg.type === 'reset') {
      sp.reset()
      lastKey = ''
      lastArsenalDefeats = -1
      lastBestiaryKey = ''
      lastSkillKey = ''
      lastSkillDropAt = -1
      lastKnockbackAt = -1
      lastStreakTier = -1
      lastCastAt = -1
      castPipe = null // 重置后旧档的 lastCast 不该再播一遍
      tick()
    } else if (msg.type === 'equip') {
      try {
        sp.equipWeapon(msg.id || null) // null = 回到"跟随最近获得"
        lastKey = ''
        lastArsenalDefeats = -1
        tick()
      } catch { /* 存档读写失败时静默忽略 */ }
    } else if (msg.type === 'skillEquip') {
      // 4 槽手动装配：id 为 null 时表示清空该槽
      try {
        sp.equipSkill(msg.id || null, msg.slot)
        lastKey = ''
        lastSkillKey = ''
        tick()
      } catch { /* 存档读写失败时静默忽略 */ }
    } else if (msg.type === 'skillAuto') {
      try {
        sp.autoEquipSkills()
        lastKey = ''
        lastSkillKey = ''
        tick()
      } catch { /* 存档读写失败时静默忽略 */ }
    } else if (msg.type === 'homeSave') {
      // 只在松手 / 换套装时收到一条，不在拖动过程中连续写盘
      try {
        sp.saveHome(msg.home)
        lastKey = ''
      } catch { /* 存档读写失败时静默忽略 */ }
    } else if (msg.type === 'expand') {
      openEditorPanel()
    }
  })
}

// —— 底部面板停靠视图 ——
class PetViewProvider {
  resolveWebviewView(view) {
    viewWebview = view.webview
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(MEDIA())],
    }
    view.webview.html = buildHtml(view.webview, true)
    wireMessages(view.webview)
    view.onDidDispose(() => {
      viewWebview = null
    })
    lastKey = ''
    tick()
  }
}

// —— 编辑器标签页版（可选，面板里点“在标签页打开”或走命令）——
function openEditorPanel() {
  if (panel) {
    panel.reveal(undefined, true)
    return
  }
  panel = vscode.window.createWebviewPanel('nibble', 'Nibble · 像素小生物', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(MEDIA())],
  })
  panel.webview.html = buildHtml(panel.webview, false)
  wireMessages(panel.webview)
  panel.onDidDispose(() => {
    panel = null
  })
  lastKey = ''
  tick()
}

// 手动推进一次攻击（供 onSave 模式 / 「攻击一次」命令 / 面板按钮使用）
function doAttack(announce) {
  if (!sp) return
  try {
    const s = sp.reloadSave()
    const log = sp.attack(s)
    sp.saveSave()
    lastKey = ''
    tick()
    if (announce) vscode.window.setStatusBarMessage('⚔ ' + log, 3000)
  } catch { /* 存档读写失败时静默忽略，不影响编辑器 */ }
}

function focusView() {
  return vscode.commands.executeCommand(VIEW_ID + '.focus')
}

function extensionVersion(context) {
  try {
    return String(context.extension.packageJSON.version)
  } catch {
    return 'unknown'
  }
}

// 「关于匿名统计」——把"发了什么、发到哪、怎么关"直接摆在用户面前
async function showTelemetryInfo(opts) {
  const info = telemetry.describe(opts)
  const text = [
    'Nibble 匿名统计：' + (info.enabled ? '已开启' : '未发送（' + info.reason + '）'),
    '',
    '只发送 2 个字段：匿名 ID（本机随机生成，与账号/机器无关）+ 扩展版本号 v' + opts.version + '。',
    '不发送：代码 / 文件 / 路径 / 项目名 / 提问内容 / 账号 / 邮箱 / 机器名 / 操作系统；服务端不保存 IP。',
    '频率：每台机器每天最多 1 次（当天首次打开 IDE 时）。',
    info.last && info.last.day ? '上次上报：' + info.last.day + '（v' + info.last.version + '）' : '本机尚未上报过。',
    '',
    '统计端点：' + (info.configured ? info.endpoint : '未配置，不会发出任何请求'),
    '完整说明见扩展页面的「更新日志」与 README「隐私」一节。',
  ].join('\n')
  const pick = await vscode.window.showInformationMessage(text, '重置匿名 ID', '关闭统计')
  if (pick === '重置匿名 ID') {
    telemetry.resetAnonId(opts.context)
    vscode.window.showInformationMessage('Nibble：已生成新的匿名 ID，之后的统计不再与之前关联。')
  } else if (pick === '关闭统计') {
    try {
      await vscode.workspace
        .getConfiguration('nibble')
        .update('telemetry', false, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage('Nibble：已关闭匿名统计，之后不会再发出任何请求。')
    } catch {
      vscode.window.showInformationMessage('Nibble：自动关闭失败，请在设置里把 nibble.telemetry 改为 false。')
    }
  }
}

function activate(context) {
  loadShared()
  const cfg = () => vscode.workspace.getConfiguration('nibble')

  // 匿名统计的入参集中在这里，方便「关于匿名统计」命令复用同一份配置
  const telOpts = () => ({
    vscode,
    context,
    version: extensionVersion(context),
    getConfig: (k, d) => cfg().get(k, d),
  })

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, new PetViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  if (cfg().get('statusBar', true)) {
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000)
    statusItem.command = 'nibble.openPanel'
    statusItem.text = '$(heart) Nibble'
    statusItem.show()
    context.subscriptions.push(statusItem)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('nibble.openPanel', () => focusView()),
    vscode.commands.registerCommand('nibble.attack', () => doAttack(true)),
    vscode.commands.registerCommand('nibble.openInEditor', () => openEditorPanel()),
    vscode.commands.registerCommand('nibble.openArsenal', () => {
      openEditorPanel()
      post(panel && panel.webview, { type: 'view', view: 'arsenal' })
    }),
    vscode.commands.registerCommand('nibble.openBestiary', () => {
      openEditorPanel()
      post(panel && panel.webview, { type: 'view', view: 'bestiary' })
    }),
    vscode.commands.registerCommand('nibble.openSkill', () => {
      openEditorPanel()
      post(panel && panel.webview, { type: 'view', view: 'skill' })
    }),
    vscode.commands.registerCommand('nibble.openHome', () => {
      openEditorPanel()
      post(panel && panel.webview, { type: 'view', view: 'home' })
    }),
    // 调试：本地一次性解锁全部家具 / 恢复开局进度。正式玩法靠掉落，这两个只是看效果用。
    vscode.commands.registerCommand('nibble.unlockAllHome', () => {
      const n = sp.unlockAllHome()
      lastKey = ''
      tick()
      vscode.window.showInformationMessage('已解锁全部家具（' + n + ' 件，仅本地存档）')
    }),
    vscode.commands.registerCommand('nibble.resetHomeOwned', () => {
      const n = sp.resetHomeOwned()
      lastKey = ''
      tick()
      vscode.window.showInformationMessage('家具进度已恢复开局（' + n + ' 件）')
    }),
    vscode.commands.registerCommand('nibble.reset', () => {
      sp.reset()
      lastKey = ''
      lastArsenalDefeats = -1
      lastBestiaryKey = ''
      lastSkillKey = ''
      lastSkillDropAt = -1
      lastKnockbackAt = -1
      lastStreakTier = -1
      lastCastAt = -1
      castPipe = null
      tick()
      vscode.window.showInformationMessage('♻️ Nibble 等级/经验/战绩已重置')
    }),
    vscode.commands.registerCommand('nibble.toggleStatusBar', () => {
      if (!statusItem) return
      statusItem.hide()
      statusItem.dispose()
      statusItem = null
    }),
    vscode.commands.registerCommand('nibble.telemetryInfo', () => showTelemetryInfo(telOpts())),
  )

  // 触发模式：hook（配套 CodeBuddy hooks 推进）/ onSave（保存文件即攻击）/ manual（只在手动时攻击）
  const mode = String(cfg().get('triggerMode', 'hook'))
  if (mode === 'onSave') {
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => doAttack(false)))
  }

  if (cfg().get('autoOpenPanel', true)) focusView()

  const ms = Math.max(150, Number(cfg().get('tickMs', 400)) || 400)
  timer = setInterval(tick, ms)
  tick()

  // —— 匿名激活统计（唯一联网点）：每天最多一次、不阻塞启动、失败静默 ——
  // 只发送「随机匿名 ID + 扩展版本号」，详见 telemetry.js 顶部说明与 CHANGELOG.md
  Promise.resolve()
    .then(() => telemetry.maybePing(telOpts()))
    .catch(() => {})

  context.subscriptions.push({
    dispose: () => {
      if (timer) clearInterval(timer)
    },
  })
}

function deactivate() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = { activate, deactivate }
