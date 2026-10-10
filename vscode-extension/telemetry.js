'use strict'
// telemetry.js —— Nibble 的**匿名激活统计**（唯一一处会联网的代码）
//
// 透明度承诺（与 CHANGELOG.md / README.md 的说明一字对应）：
//   ✅ 只发送两个字段：`id`（本地随机生成的匿名 UUID）+ `v`（扩展版本号）
//   ❌ 不发送：代码、文件内容、文件路径、项目名、提示词、账号、邮箱、机器名、操作系统
//   ✅ 每台机器**每天最多 1 次**（当天首次启动时发送一次；版本升级后立即补发一次）
//   ✅ 三处开关可随时关掉：设置 `nibble.telemetry=false` / IDE 全局遥测关闭 / 环境变量 NIBBLE_NO_TELEMETRY=1
//   ✅ 命令「Nibble: 关于匿名统计」里能看到当前状态、发什么、以及一键关闭 / 重置匿名 ID
//
// ENDPOINT 留空或仍是占位符（含 REPLACE_ME）时，本模块**不会发出任何网络请求**。

const https = require('https')
const crypto = require('crypto')

// 部署 telemetry-worker/ 后把 /ping 地址填到这里（见 telemetry-worker/README.md）
const ENDPOINT = 'https://nibble-stats.lmluo.workers.dev/ping'

const KEY_ID = 'nibble.anonId'
const KEY_LAST = 'nibble.lastPing' // { day: 'YYYY-MM-DD', version: '0.2.0' }
const TIMEOUT_MS = 5000

const endpoint = () => process.env.NIBBLE_TELEMETRY_ENDPOINT || ENDPOINT

const configured = () => {
  const url = endpoint()
  return /^https:\/\/[^\s<>"']+$/i.test(url) && url.indexOf('REPLACE_ME') === -1
}

const utcDay = () => new Date().toISOString().slice(0, 10)

const randomId = () => {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '')
  } catch { /* 老 Node 没有 randomUUID，走下面的兜底 */ }
  return crypto.randomBytes(16).toString('hex')
}

// 匿名 ID 存在 IDE 的 globalState 里（不落项目目录、不随存档同步）
function anonId(context) {
  try {
    let id = context.globalState.get(KEY_ID)
    if (!id || typeof id !== 'string') {
      id = randomId()
      context.globalState.update(KEY_ID, id)
    }
    return id
  } catch {
    return null
  }
}

const lastPing = (context) => {
  try {
    const v = context.globalState.get(KEY_LAST)
    return v && typeof v === 'object' && v.day ? v : null
  } catch {
    return null
  }
}

const rememberPing = (context, version) => {
  try {
    context.globalState.update(KEY_LAST, { day: utcDay(), version })
  } catch { /* 记不住就下次再发，不影响功能 */ }
}

// 判断"现在能不能发"，返回 null = 可以发；否则返回人类可读的原因
function blockedReason(opts) {
  const { vscode, context, getConfig } = opts
  if (process.env.NIBBLE_NO_TELEMETRY) return '环境变量 NIBBLE_NO_TELEMETRY 已设置'
  if (!configured()) return '统计端点未配置（扩展作者尚未填入地址）'
  if (!context || !context.globalState) return '当前环境不支持 globalState'
  try {
    if (getConfig && getConfig('telemetry', true) === false) return '设置 nibble.telemetry 已关闭'
  } catch { /* 读不到配置就按默认开启 */ }
  try {
    if (vscode && vscode.env && vscode.env.isTelemetryEnabled === false) {
      return 'IDE 全局遥测已关闭（telemetry.telemetryLevel / telemetry.enabled）'
    }
  } catch { /* 老版本 IDE 没有这个字段 */ }
  return null
}

// 给命令「关于匿名统计」用的现状描述
function describe(opts) {
  const reason = blockedReason(opts)
  return {
    enabled: !reason,
    reason,
    endpoint: endpoint(),
    configured: configured(),
    last: lastPing(opts.context),
    id: opts.context && opts.context.globalState ? opts.context.globalState.get(KEY_ID) || null : null,
  }
}

function resetAnonId(context) {
  try {
    context.globalState.update(KEY_ID, randomId())
    context.globalState.update(KEY_LAST, undefined)
    return true
  } catch {
    return false
  }
}

// 一次极简 POST：请求体越小越好，失败一律静默（扩展绝不能因为统计而打扰用户）
function post(url, payload) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      const body = JSON.stringify(payload)
      const u = new URL(url)
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: (u.pathname || '/') + (u.search || ''),
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'nibble-extension',
          },
        },
        (res) => {
          res.resume() // 丢弃响应体
          done(res.statusCode || 0)
        },
      )
      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy()
        done(0)
      })
      req.on('error', () => done(0))
      req.end(body)
    } catch {
      done(0)
    }
  })
}

// 对外主入口：满足条件才发，且每天最多一次（版本变化时立即补发）
async function maybePing(opts) {
  const { context, version } = opts
  const reason = blockedReason(opts)
  if (reason) return { sent: false, reason }
  try {
    const last = lastPing(context)
    if (last && last.day === utcDay() && last.version === version) {
      return { sent: false, reason: '今天已上报过' }
    }
    const id = anonId(context)
    if (!id) return { sent: false, reason: '无法生成匿名 ID' }
    const status = await post(endpoint(), { id, v: version })
    const ok = status >= 200 && status < 300
    if (ok) rememberPing(context, version)
    return { sent: ok, status, reason: ok ? null : '上报失败（静默忽略）' }
  } catch (err) {
    return { sent: false, reason: '异常：' + ((err && err.message) || err) }
  }
}

module.exports = { ENDPOINT, endpoint, configured, maybePing, describe, resetAnonId, blockedReason }
