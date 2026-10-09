'use strict'
// nibble IDE 扩展 —— 把像素小生物做成**常驻 UI**（底部面板停靠视图 + 底部状态栏）
//
// 分工：hooks 负责"提问即攻击"的游戏推进（写 save.json），本扩展只负责**显示**（读同一份存档）。
// 因此展示是常驻的、自动动画的，而且**不消耗任何 token**。
// 像素素材与渲染逻辑复用 plugins/nibble/hooks/nibble.js（单一数据源）。

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

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

  // 检测节拍：攻击 → 前冲；击败 → 敌方消散闪烁
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
    statusItem.tooltip =
      'Nibble · Lv' + st.level + '　攻击 ' + st.battles + ' 次　击败 ' + st.defeats + ' 次\n' + st.log +
      '\n（点击显示底部面板）'
  }

  // —— 面板 / 停靠视图 ——
  const targets = [viewWebview, panel && panel.webview].filter(Boolean)
  if (!targets.length) return
  if (st.key !== lastKey) {
    lastKey = st.key
    targets.forEach((w) => post(w, Object.assign({ type: 'state' }, st)))
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
      tick()
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

function activate(context) {
  loadShared()
  const cfg = () => vscode.workspace.getConfiguration('nibble')

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
    vscode.commands.registerCommand('nibble.reset', () => {
      sp.reset()
      lastKey = ''
      tick()
      vscode.window.showInformationMessage('♻️ Nibble 等级/经验/战绩已重置')
    }),
    vscode.commands.registerCommand('nibble.toggleStatusBar', () => {
      if (!statusItem) return
      statusItem.hide()
      statusItem.dispose()
      statusItem = null
    }),
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
