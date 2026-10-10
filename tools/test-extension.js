#!/usr/bin/env node
'use strict'
// test-extension.js — 在 Node 里用 stub 跑一遍扩展的 activate()/tick()，提前暴露错误
// 用法: node tools/test-extension.js

const path = require('path')
const Module = require('module')

// 自检不得联网：激活阶段的上报一律跳过（与 CI 里的机器环境无关，只影响本进程）
process.env.NIBBLE_NO_TELEMETRY = '1'

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
const okView = vHtml.includes('<canvas id="player"') && vHtml.includes('pet.js') && vHtml.includes('class="in-view"')
console.log('   含 canvas: ' + vHtml.includes('<canvas id="player"'))
console.log('   已注入 pet.js: ' + vHtml.includes('pet.js'))
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
      console.log('')
      const ok = okView && okTel
      console.log(ok ? '✅ 扩展自检通过' : '❌ 扩展自检失败：视图 HTML 或匿名统计行为不正确')
      process.exit(ok ? 0 : 1)
    })
    .catch((err) => {
      console.log('   ❌ 匿名统计抛出异常：' + err)
      process.exit(1)
    })
}, 1300)
