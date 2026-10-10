#!/usr/bin/env node
'use strict'
// install-extension.js — 把 IDE 扩展装进 CodeBuddy 的**真实**扩展目录，并生成可视化预览页
//
// 踩坑记录：CodeBuddy 的 userData 是 %APPDATA%\CodeBuddy CN（放日志/缓存），
// 但**用户扩展目录**是 %USERPROFILE%\.codebuddycn\extensions（不是 ~/.codebuddy/extensions）。
// 这里直接从扫描缓存 extensions.user.cache 里读出真实路径，避免再次装错。
//
// 用法: node tools/install-extension.js

const fs = require('fs')
const os = require('os')
const path = require('path')

const marketRoot = path.resolve(__dirname, '..')
const srcDir = path.join(marketRoot, 'vscode-extension')
const sharedJs = path.join(marketRoot, 'plugins', 'nibble', 'hooks', 'nibble.js')
const EXT_ID = 'nibble.nibble'
// 版本号从扩展的 package.json 读取，避免升版后忘记同步（曾写死 0.1.0）
const VERSION = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8')).version
const FOLDER = EXT_ID + '-' + VERSION + '-universal'
// 历史版本（2026-10-09 由 spinlings 更名为 nibble），安装时顺手清掉，避免残留两份
const LEGACY_IDS = ['spinlings.spinlings']
const LEGACY_FOLDERS = ['spinlings.spinlings-0.1.0-universal', 'spinlings.spinlings-0.1.0']

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const userData = path.join(appData, 'CodeBuddy CN')
const cacheFile = path.join(userData, 'CachedProfilesData', '__default__profile__', 'extensions.user.cache')

// '/c:/Users/x/.codebuddycn/extensions/extensions.json' → 'C:\Users\x\.codebuddycn\extensions\extensions.json'
function uriPathToWin(p) {
  const m = /^\/([a-zA-Z]):\/(.*)$/.exec(p)
  return m ? m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\') : null
}

function resolveExtDir() {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    const manifest = cache && cache.input && cache.input.location && cache.input.location.path
    const win = manifest && uriPathToWin(manifest)
    if (win) {
      const dir = path.dirname(win)
      console.log('🔎 从扫描缓存解析到扩展目录: ' + dir)
      return dir
    }
  } catch { /* 没缓存就走兜底 */ }
  const guess = path.join(os.homedir(), '.codebuddycn', 'extensions')
  console.log('🔎 缓存不可用，使用探测路径: ' + guess)
  return guess
}

const extDir = resolveExtDir()
const destDir = path.join(extDir, FOLDER)

// ---------- 0. 同步自包含副本（lib/），让发布版不依赖工作区路径 ----------
require('./sync-lib')()
console.log('📦 已同步自包含副本 → vscode-extension/lib/')

// ---------- 1. 拷进扩展目录 ----------
// 先整体清空目标目录：避免上次安装残留（例如 Open VSX 版的 .vsixmanifest）或拷贝中断造成的半残状态
if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true, force: true })
  console.log('🧹 已清空旧的目标目录: ' + destDir)
}
fs.mkdirSync(destDir, { recursive: true })
fs.cpSync(srcDir, destDir, {
  recursive: true,
  force: true,
  filter: (src) => !/[\\/]icon-src([\\/]|$)/.test(src),
})
fs.writeFileSync(
  path.join(destDir, 'config.json'),
  JSON.stringify({ pluginRoot: marketRoot.replace(/\\/g, '/') }, null, 2) + '\n',
  'utf8',
)
console.log('✅ 已安装扩展 → ' + destDir)

// ---------- 2. 登记到真实扩展目录的 extensions.json ----------
const manifestPath = path.join(extDir, 'extensions.json')
let list = []
if (fs.existsSync(manifestPath)) {
  const raw = fs.readFileSync(manifestPath, 'utf8')
  fs.writeFileSync(manifestPath + '.bak-' + Date.now(), raw, 'utf8')
  try {
    list = JSON.parse(raw)
    if (!Array.isArray(list)) list = []
  } catch {
    list = []
  }
}
list = list.filter(
  (e) => !(e && e.identifier && (e.identifier.id === EXT_ID || LEGACY_IDS.includes(e.identifier.id))),
)
list.push({
  identifier: { id: EXT_ID },
  version: VERSION,
  location: {
    $mid: 1,
    path: '/' + destDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':'),
    scheme: 'file',
  },
  relativeLocation: FOLDER,
  metadata: {
    isApplicationScoped: false,
    isMachineScoped: false,
    isBuiltin: false,
    installedTimestamp: Date.now(),
    pinned: false,
    source: 'local',
    targetPlatform: 'universal',
    updated: false,
    private: false,
    isPreReleaseVersion: false,
    hasPreReleaseVersion: false,
    preRelease: false,
  },
})
fs.writeFileSync(manifestPath, JSON.stringify(list), 'utf8')
console.log('✅ 已登记 ' + manifestPath + '（共 ' + list.length + ' 个扩展）')

// ---------- 3. 丢掉扫描缓存，强制重新扫盘 ----------
try {
  if (fs.existsSync(cacheFile)) {
    fs.copyFileSync(cacheFile, cacheFile + '.bak-' + Date.now())
    fs.unlinkSync(cacheFile)
    console.log('🧹 已清除扫描缓存 extensions.user.cache（下次启动会重新扫描）')
  }
} catch (err) {
  console.log('⚠️  清除缓存失败（不影响，可忽略）: ' + err.message)
}

// ---------- 3b. 移除历史版本目录（改名前的 spinlings.*）----------
for (const name of LEGACY_FOLDERS) {
  const folder = path.join(extDir, name)
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true })
    console.log('🧹 已移除历史版本目录: ' + name)
  }
}

// ---------- 4. 清掉之前装错位置的那份 ----------
const wrongDir = path.join(os.homedir(), '.codebuddy', 'extensions')
try {
  const wrongFolder = path.join(wrongDir, EXT_ID + '-' + VERSION)
  if (fs.existsSync(wrongFolder)) {
    fs.rmSync(wrongFolder, { recursive: true, force: true })
    console.log('🧹 已删除装错位置的副本: ' + wrongFolder)
  }
  const wrongManifest = path.join(wrongDir, 'extensions.json')
  if (fs.existsSync(wrongManifest)) {
    const cur = JSON.parse(fs.readFileSync(wrongManifest, 'utf8'))
    if (Array.isArray(cur) && cur.some((e) => e && e.identifier && e.identifier.id === EXT_ID)) {
      fs.writeFileSync(wrongManifest, JSON.stringify(cur.filter((e) => e.identifier.id !== EXT_ID)), 'utf8')
      console.log('🧹 已还原 ~/.codebuddy/extensions/extensions.json')
    }
  }
} catch { /* 忽略清理问题 */ }

// ---------- 5. 生成可视化预览页（真实素材，浏览器直接可看）----------
const sp = require(sharedJs)
const flat = (grid) => {
  const out = []
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid.length; c++) out.push(grid[r][c] || '')
  return out
}
const s = sp.reloadSave()
const mock = {
  player: flat(sp.decodeGrid('player').grid),
  enemy: flat(sp.enemyGrid(s.enemy.type, s.enemy.rarity, false)),
  level: s.level,
  exp: s.exp,
  hp: s.enemy.hp,
  maxHp: s.enemy.maxHp,
  enemyName: sp.ENEMY_NAMES[s.enemy.type],
  rarityLabel: sp.RARITY_LABEL[s.enemy.rarity],
  rarity: s.enemy.rarity,
  rarityColor: sp.RARITY_COLOR[s.enemy.rarity],
  log: s.lastLog || 'Nibble 待命中…（向 CodeBuddy 提问即可发动攻击）',
}
let html = fs.readFileSync(path.join(srcDir, 'media', 'panel.html'), 'utf8')
html = html.replace(
  '<!--PET_JS-->',
  '<script>window.__NIBBLE_MOCK__=' + JSON.stringify(mock) + ';</script>\n<script src="pet.js"></script>',
)
html = html.replace('<title>Nibble</title>', '<title>Nibble · 预览</title>')
const previewPath = path.join(srcDir, 'media', 'preview.html')
fs.writeFileSync(previewPath, html, 'utf8')
console.log('✅ 已生成预览页 → ' + previewPath)
console.log('')
console.log('👉 现在重启 IDE 或运行 “Developer: Reload Window”，状态栏与面板就会出现。')
