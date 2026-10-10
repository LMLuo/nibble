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
let lastKey = ''
let lastDropAt = -1
let lastArsenalDefeats = -1

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
  const shown = sp.equippedWeapon(s) // 战斗页展示：已装备 → 否则最近获得
  const weaponSprite = shown ? sp.weaponSpriteGrid(shown.id, true) : null
  return {
    player: flat(sp.decodeGrid('player').grid),
    enemy: flat(sp.enemyGrid(s.enemy.type, s.enemy.rarity, false)),
    level: s.level,
    exp: s.exp,
    xpNeed: sp.xpNeed(s.level),
    hp: s.enemy.hp,
    maxHp: s.enemy.maxHp,
    enemyName: sp.ENEMY_NAMES[s.enemy.type],
    rarityLabel: sp.RARITY_LABEL[s.enemy.rarity],
    rarity: s.enemy.rarity,
    rarityColor: sp.RARITY_COLOR[s.enemy.rarity],
    battles: s.battles,
    defeats: s.defeats,
    log: s.lastLog || 'Nibble 待命中…（向 CodeBuddy 提问即可发动攻击）',
    key: s.enemy.type + '|' + s.enemy.rarity + '|' + s.enemy.maxHp + '|' + s.battles,
    arsenal,
    weaponSprite: weaponSprite ? flat(weaponSprite) : null,
    weaponName: shown ? shown.name : null,
    weaponRarity: shown ? shown.rarity : null,
    weaponColor: shown ? sp.RARITY_COLOR[shown.rarity] : null,
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
    list: sp.WEAPONS,
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

  // —— 状态栏（常驻，随攻击实时变化）——
  if (statusItem) {
    const filled = Math.max(0, Math.min(8, Math.round((Math.max(0, st.hp) / st.maxHp) * 8)))
    statusItem.text =
      '$(heart) Lv' + st.level + ' ' + '█'.repeat(filled) + '░'.repeat(8 - filled) +
      ' ' + st.hp + '/' + st.maxHp + ' ' + st.enemyName
    const last = st.arsenal.last
    statusItem.tooltip =
      'Nibble · Lv' + st.level + '　攻击 ' + st.battles + ' 次　击败 ' + st.defeats + ' 次\n' + st.log +
      '\n⚔ 武器库 ' + st.arsenal.owned + '/' + st.arsenal.total + '　保底 ' + st.arsenal.pity + '/' + st.arsenal.pityLimit +
      (last ? '\n最近获得：' + sp.RARITY_LABEL[last.rarity] + '·' + last.name : '') +
      '\n（点击显示底部面板）'
  }

  // —— 面板 / 停靠视图 ——
  const targets = [viewWebview, panel && panel.webview].filter(Boolean)
  if (!targets.length) return
  if (st.key !== lastKey) {
    lastKey = st.key
    targets.forEach((w) => post(w, Object.assign({ type: 'state' }, st)))
  }
  // 掉落瞬间：推战利品消息（面板弹 toast，史诗以上带特效）
  const lastDrop = st.arsenal.last
  if (lastDrop && lastDrop.at && lastDrop.at !== lastDropAt) {
    lastDropAt = lastDrop.at
    const msg = {
      type: 'drop',
      name: lastDrop.name,
      rarity: lastDrop.rarity,
      color: sp.RARITY_COLOR[lastDrop.rarity],
      rarityLabel: sp.RARITY_LABEL[lastDrop.rarity],
      story: lastDrop.story,
      sprite: st.weaponSprite,
    }
    targets.forEach((w) => post(w, msg))
  }
  // 武器库数据：击败数变化（=新掉落入库）时推送全量
  if (lastArsenalDefeats !== st.defeats) {
    lastArsenalDefeats = st.defeats
    const data = buildArsenalData(st.arsenal)
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
  }
  targets.forEach((w) => post(w, t))
}

function buildHtml(webview, inView) {
  const petJs = webview.asWebviewUri(vscode.Uri.file(path.join(MEDIA(), 'pet.js')))
  let html = fs.readFileSync(path.join(MEDIA(), 'panel.html'), 'utf8')
  html = html.replace('<!--PET_JS-->', '<script src="' + petJs + '"></script>')
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
      tick()
    } else if (msg.type === 'equip') {
      try {
        sp.equipWeapon(msg.id || null) // null = 回到"跟随最近获得"
        lastKey = ''
        lastArsenalDefeats = -1
        tick()
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
    vscode.commands.registerCommand('nibble.reset', () => {
      sp.reset()
      lastKey = ''
      lastArsenalDefeats = -1
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
