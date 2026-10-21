#!/usr/bin/env node
'use strict'
// test-extension.js — 在 Node 里用 stub 跑一遍扩展的 activate()/tick()，提前暴露错误
// 用法: node tools/test-extension.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

// 自检不得联网：激活阶段的上报一律跳过（与 CI 里的机器环境无关，只影响本进程）
process.env.NIBBLE_NO_TELEMETRY = '1'

// ⚠️ 存档隔离：自检会真的调用 attack() 并写盘，必须钉到临时目录，绝不碰真实进度。
// 变量名以 plugins/nibble/hooks/nibble.js 的 dataDir() 为准：CODEBUDDY_PLUGIN_DATA（无第二个 D），
// 兜底 CLAUDE_PLUGIN_DATA —— 写错名字时钩子会回落到 ~/.codebuddy/plugins/data/nibble（真实存档）。
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nibble-test-'))
process.env.CODEBUDDY_PLUGIN_DATA = TEST_DATA
process.env.CLAUDE_PLUGIN_DATA = TEST_DATA

const calls = { statusText: null, webviewHtml: null, registered: [], viewHtml: null }

function fakeWebview(target) {
  return {
    options: {},
    asWebviewUri: (u) => u,
    postMessage: () => {},
    onDidReceiveMessage: () => ({ dispose() {} }),
    set html(v) { target.html = v },
    get html() { return target.html },
  }
}

const viewHolder = {}
const panelHolder = {}

const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Beside: -2 },
  ConfigurationTarget: { Global: 1 },
  env: { appName: 'Stub IDE', isTelemetryEnabled: true },
  Uri: {
    file: (p) => ({ fsPath: p, toString: () => 'file://' + p.replace(/\\/g, '/') }),
    joinPath: (u, p) => ({ fsPath: path.join(u.fsPath, p), toString: () => 'file://' + path.join(u.fsPath, p).replace(/\\/g, '/') }),
  },
  window: {
    createStatusBarItem: () => ({
      set text(v) { calls.statusText = v },
      get text() { return calls.statusText },
      tooltip: '',
      command: '',
      show() {},
      hide() {},
      dispose() {},
    }),
    createWebviewPanel: () => ({
      webview: fakeWebview(panelHolder),
      reveal() {},
      onDidDispose: () => ({ dispose() {} }),
      dispose() {},
    }),
    registerWebviewViewProvider: (id, provider) => {
      calls.registered.push('viewProvider:' + id)
      provider.resolveWebviewView({
        webview: fakeWebview(viewHolder),
        onDidDispose: () => ({ dispose() {} }),
      })
      return { dispose() {} }
    },
    showInformationMessage: (m) => console.log('   [info] ' + m),
    setStatusBarMessage: (m) => console.log('   [status] ' + m),
  },
  commands: {
    registerCommand: (id) => (calls.registered.push(id), { dispose() {} }),
    executeCommand: () => Promise.resolve(),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
  },
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub
  return origLoad.apply(this, arguments)
}

const ext = require(path.join(__dirname, '..', 'vscode-extension', 'extension.js'))
const store = {}
const context = {
  subscriptions: [],
  extension: { packageJSON: { version: '0.0.0-test' } },
  globalState: {
    get: (k) => store[k],
    update: (k, v) => {
      if (v === undefined) delete store[k]
      else store[k] = v
      return Promise.resolve()
    },
  },
}

console.log('1) activate() …')
ext.activate(context)
console.log('   已注册: ' + calls.registered.join(', '))
console.log('   状态栏文本: ' + calls.statusText)

console.log('2) 停靠视图 HTML …')
const vHtml = viewHolder.html || ''
// 战斗视图已从「两块角色小画布」换成「一整块场景画布 + 独立场景模块（scene.js）」
const okView = vHtml.includes('<canvas id="scene"') && vHtml.includes('pet.js') &&
  vHtml.includes('scene.js') && vHtml.includes('class="in-view"')
console.log('   含场景 canvas: ' + vHtml.includes('<canvas id="scene"'))
console.log('   已注入 pet.js: ' + vHtml.includes('pet.js'))
console.log('   已注入 scene.js（新场景模块）: ' + vHtml.includes('scene.js'))
console.log('   body 带 in-view（紧凑尺寸）: ' + vHtml.includes('class="in-view"'))

console.log('3) 等待 tick（含一次攻击）…')
const sp = require(path.join(__dirname, '..', 'plugins', 'nibble', 'hooks', 'nibble.js'))
const before = sp.loadSave().battles
sp.attack(sp.loadSave())
sp.saveSave()
setTimeout(() => {
  console.log('   状态栏文本: ' + calls.statusText)
  console.log('   攻击次数 ' + before + ' → ' + sp.loadSave().battles)
  ext.deactivate()

  console.log('4) 匿名统计 …')
  const tel = require(path.join(__dirname, '..', 'vscode-extension', 'telemetry.js'))
  const telOpts = { vscode: vscodeStub, context, version: '0.0.0-test', getConfig: (k, d) => d }
  const skipped = tel.describe(telOpts)
  console.log('   端点已配置: ' + skipped.configured)
  console.log('   自检环境跳过原因: ' + skipped.reason)

  // 放开跳过开关，指向一个必然连不上的本地端口：验证"联网失败也不抛错、不阻塞"
  delete process.env.NIBBLE_NO_TELEMETRY
  process.env.NIBBLE_TELEMETRY_ENDPOINT = 'https://127.0.0.1:1/ping'
  tel
    .maybePing(telOpts)
    .then((r) => {
      const okTel = r && r.sent === false
      console.log('   上报失败时静默返回: ' + JSON.stringify(r))
      console.log('   匿名 ID 已生成: ' + Boolean(context.globalState.get('nibble.anonId')))

      // 5) 技能书原语指派（第五刀）：50 本必须全显式指派、原语合法、**同标签内不重复**。
      //    加新书时若忘了填 SKILL_FORMS，这里会拦下来（否则它会悄悄回落成标签默认招式）。
      console.log('5) 技能书原语指派 …')
      const sk = require(path.join(__dirname, '..', 'plugins', 'nibble', 'hooks', 'skills.js'))
      const formProblems = []
      const perTag = {}
      for (const book of sk.SKILLS) {
        if (!sk.SKILL_FORMS[book.id]) formProblems.push(book.name + '(' + book.id + ') 未显式指派')
        if (sk.FORM_PRIMITIVES.indexOf(book.form) < 0) formProblems.push(book.name + ' 原语非法: ' + book.form)
        perTag[book.tag] = (perTag[book.tag] || []).concat([book.form])
      }
      let dupTag = 0
      for (const tag of Object.keys(perTag)) {
        const dup = perTag[tag].filter((f, i) => perTag[tag].indexOf(f) !== i)
        if (dup.length) {
          dupTag++
          formProblems.push(sk.TAG_LABEL[tag] + ' 内重复原语: ' + Array.from(new Set(dup)).join('/'))
        }
      }
      console.log('   50 本全显式指派: ' + (sk.SKILLS.every((b) => Boolean(sk.SKILL_FORMS[b.id])) ? 'true' : 'false'))
      console.log('   同标签内不重复: ' + (dupTag === 0))
      for (const p of formProblems) console.log('   ❌ ' + p)

      // 6) lastCast 跨进程还原：hooks 写盘 → 扩展读盘 → 推 type:'cast'。
      //    漏了 loadSave() 里的还原，面板会永远没有施放特效（只有官网演示有），而数值全都正常。
      console.log('6) lastCast 跨进程还原 …')
      const s6 = sp.loadSave()
      s6.lastCast = {
        id: 'print_debug', name: '打印大法', rarity: 'common', tag: 'aim', tier: 1,
        slot: 0, form: 'chars', enemyType: 'race_condition', enemyRarity: 'common',
        power: 1, combos: [], hpBefore: 10, maxHpBefore: 20, playerHpBefore: 30,
        killed: false, countered: false, at: Date.now(), dmg: 12,
      }
      sp.saveSave()
      const back = sp.reloadSave()
      const okCast = Boolean(back.lastCast && back.lastCast.id === 'print_debug' && back.lastCast.form === 'chars')
      console.log('   写盘后能读回: ' + okCast)
      if (!okCast) console.log('   ❌ lastCast 在 loadSave() 里被丢了：面板收不到施放消息')
      console.log('')
      const ok = okView && okTel && formProblems.length === 0 && okCast
      console.log(ok ? '✅ 扩展自检通过' : '❌ 扩展自检失败：视图 HTML / 匿名统计 / 技能书原语指派 / lastCast 还原 有不正确项')
      process.exit(ok ? 0 : 1)
    })
    .catch((err) => {
      console.log('   ❌ 匿名统计抛出异常：' + err)
      process.exit(1)
    })
}, 1300)
