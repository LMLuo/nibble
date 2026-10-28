'use strict'
// scene.js — 战斗场景渲染（像素场景 + 头顶 HUD + 武器格子 + 悬浮菜单）
//
// 为什么是独立文件：
//   pet.js 同时被官网首屏复用（tools/build-site.js 会把它复制进 _site/），
//   所以战场视觉必须放在官网拿不到的新文件里 —— 官网 DOM 里没有 #sceneWrap，
//   本文件第一件事就是取节点失败即静默退出，官网因此完全不受影响。
//
// 画布结构（由远到近）：
//   天空 → 星 → 远山(2 层三角峰) → 远处丘陵 → 水平地面带 → 落影 → 角色 → 前景草
// 硬规矩：一切绘制在「逻辑像素」坐标系里、坐标取整；后备存储 = 逻辑尺寸 × round(S×DPR)。
;(function () {
  var stage = document.getElementById('sceneWrap')
  var cv = document.getElementById('scene')
  if (!stage || !cv) return // 旧面板 / 官网：没有场景节点，直接退出
  var ctx = cv.getContext('2d')
  // 本脚本自己的 URL（带宿主加的 ?v=<version>）：currentScript 只在执行期有效，必须此刻抓下来
  var SELF_SRC = (document.currentScript && document.currentScript.src) || ''

  // ============================================================
  // 三套场景 = 三个 tier（数据来自 state.enemyTier）
  // ============================================================
  var THEMES = {
    common: {
      sky: ['#C2D6E2', '#D9E7EB', '#EEF3F3'],
      star: null, stars: 0, starEvery: 0,
      far: ['#ACBECE', '#96A9BE'],
      hill: '#7C9C58', hillTop: '#93B26C',
      ground: '#8FB061', groundTop: '#A6C674', groundDeep: '#6E8C48',
      grass: '#587A38', grassLit: '#6E9048',
      dash: '#7A9A50', contact: '#6E8C48',
      deco: 'blocks', decoInk: '#8AA0B4', decoLit: '#E4EEF2',
      accent: '#A6C674'
    },
    elite: {
      sky: ['#241E30', '#37304A', '#4C4058'],
      star: '#c8bcd8', stars: 10, starEvery: 4,
      far: ['#322C42', '#3E3850'],
      hill: '#3E4A42', hillTop: '#4E5C50',
      ground: '#46524A', groundTop: '#56645A', groundDeep: '#323A34',
      grass: '#252E28', grassLit: '#38443A',
      dash: '#5A6656', contact: '#323A34',
      deco: 'bubbles', decoInk: '#6E7C70', decoLit: '#8AA898',
      accent: '#8AA898'
    },
    boss: {
      sky: ['#180A0A', '#2C1210', '#48190E'],
      star: '#ff9a5a', stars: 7, starEvery: 3,
      far: ['#381412', '#48180F'],
      hill: '#5A2016', hillTop: '#6E2A1A',
      ground: '#6A2816', groundTop: '#8A3620', groundDeep: '#461A0E',
      grass: '#2A0E06', grassLit: '#48180C',
      dash: '#8A3620', contact: '#461A0E',
      deco: 'sparks', decoInk: '#FF8A3A', decoLit: '#FFC46A',
      accent: '#FF8A3A'
    }
  }

  var state = null
  var tick = { frame: 0, lunge: false, dissolve: false }
  var GRID = 24 // 角色/武器的逻辑格数
  // 连击相关的瞬时状态：超载演出的飞散块剩余帧 / 伤害飘字（值 + 剩余帧）
  var burstFrames = 0
  var dmg = { val: 0, ticks: 0 }
  var lastLunge = false

  // ============================ 小工具 ============================
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0
      var t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function noise1d(W, seg, rnd) {
    var n = Math.ceil(W / seg) + 2, v = new Array(n), i
    for (i = 0; i < n; i++) v[i] = rnd()
    var out = new Array(W)
    for (var x = 0; x < W; x++) {
      var t = x / seg, i0 = Math.floor(t), f = t - i0, s = f * f * (3 - 2 * f)
      out[x] = v[i0] * (1 - s) + v[i0 + 1] * s
    }
    return out
  }

  function hex2rgb(h) {
    var s = String(h).replace('#', '')
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
  }

  function rgba(hex, a) {
    var c = hex2rgb(hex)
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'
  }

  function mixHex(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b), o = '#'
    for (var i = 0; i < 3; i++) o += ('0' + Math.round(A[i] + (B[i] - A[i]) * t).toString(16)).slice(-2)
    return o
  }

  // 三角山峰轮廓：在 baseY 之上叠 count 个等腰尖峰
  function makePeaks(W, baseY, count, minH, maxH, seed) {
    var r = mulberry32(seed)
    var out = new Array(W)
    for (var i = 0; i < W; i++) out[i] = baseY
    for (var k = 0; k < count; k++) {
      var cx = (k + 0.5) * (W / count) + (r() - 0.5) * (W / count) * 0.45
      var h = minH + r() * (maxH - minH)
      var half = h * (0.7 + r() * 0.6)
      var x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(W - 1, Math.round(cx + half))
      for (var x = x0; x <= x1; x++) {
        var t = 1 - Math.abs(x - cx) / half
        if (t <= 0) continue
        var y = baseY - Math.round(t * h)
        if (y < out[x]) out[x] = y
      }
    }
    return out
  }

  var STARS = (function () {
    var r = mulberry32(1001), out = []
    for (var i = 0; i < 26; i++) out.push({ u: r(), v: r() })
    return out
  })()

  // 宿主发来的网格是「24×24 扁平的 hex 颜色数组」，空位是 ''；
  // tint 用于受击反馈：半透明白罩一层（提亮剪影但不盖住命中特效——全白会把特效吃掉）；
  // tintA 可指定透明度（受击闪白按时衰减时用）
  function drawFlat(flat, x0, y0, hidden, tint, tintA) {
    if (!flat || hidden) return
    var n = GRID
    if (tint) ctx.globalAlpha = tintA || 0.5
    for (var i = 0; i < flat.length; i++) {
      var c = flat[i]
      if (!c) continue
      ctx.fillStyle = tint || c
      ctx.fillRect(x0 + (i % n), y0 + ((i / n) | 0), 1, 1)
    }
    if (tint) ctx.globalAlpha = 1
  }

  // 角色帧 → 24×24 扁平 hex 数组（与 state.player 同格式，drawFlat / 罩色逻辑可原样复用）
  // 帧表来自 window.NibbleActorFrames（小屋那份，同一真源）；没加载时回落到 state.player。
  var AF = typeof window !== 'undefined' ? window.NibbleActorFrames : null
  var frameFlats = {}
  function frameFlat(name) {
    if (!AF || !AF.frames || !AF.frames[name]) return null
    if (frameFlats[name]) return frameFlats[name]
    var rows = AF.frames[name]
    var pal = AF.palette || []
    var flat = new Array(GRID * GRID)
    for (var y = 0; y < GRID; y++) {
      var row = rows[y] || ''
      for (var x = 0; x < GRID; x++) {
        var ch = row.charAt ? row.charAt(x) : row[x]
        flat[y * GRID + x] = ch && ch !== '.' ? pal[parseInt(ch, 36)] || '' : ''
      }
    }
    frameFlats[name] = flat
    return flat
  }

  // 庆祝用的 7×6 小爱心（硬边像素，两档暖粉，不引入新色板）
  function drawHeart(x0, y0, a) {
    var P = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...']
    ctx.globalAlpha = a == null ? 1 : a
    for (var y = 0; y < P.length; y++) {
      for (var x = 0; x < 7; x++) {
        if (P[y].charAt(x) !== '#') continue
        ctx.fillStyle = y < 2 ? '#ffd1dc' : '#ff8fa3'
        ctx.fillRect(Math.round(x0) + x, Math.round(y0) + y, 1, 1)
      }
    }
    ctx.globalAlpha = 1
  }

  // 生气符号（💢 的四段弧）：7×7 硬边像素，红；出现在攻击时的头顶右侧
  function drawAnger(x0, y0, now) {
    var P = ['.##.##.', '.#...#.', '..#.#..', '.......', '..#.#..', '.#...#.', '.##.##.']
    // 轻微搏动：每 160ms 在 0/1 之间跳（不加渐变，保持硬边）
    var pulse = Math.floor(now / 160) % 2
    ctx.globalAlpha = pulse ? 1 : 0.78
    for (var y = 1; y < P.length - 1; y++) {
      for (var x = 1; x < 6; x++) {
        if (P[y].charAt(x) !== '#') continue
        ctx.fillStyle = '#E23B2E'
        ctx.fillRect(Math.round(x0) + x, Math.round(y0) + y, 1, 1)
      }
    }
    ctx.globalAlpha = 1
  }

  // 24 格 → 12 格（每格取块内出现最多的非空色）：武器格子图标用，整数倍缩小才不糊
  function downscaleFlat(flat, from, to) {
    var step = from / to, out = new Array(to * to)
    for (var y = 0; y < to; y++) {
      for (var x = 0; x < to; x++) {
        var counts = {}, best = '', bn = 0
        for (var sy = Math.floor(y * step); sy < Math.floor((y + 1) * step); sy++) {
          for (var sx = Math.floor(x * step); sx < Math.floor((x + 1) * step); sx++) {
            var c = flat[sy * from + sx]
            if (!c) continue
            var k = (counts[c] || 0) + 1
            counts[c] = k
            if (k > bn) { bn = k; best = c }
          }
        }
        out[y * to + x] = best
      }
    }
    return out
  }

  // ============================ 主绘制 ============================
  var lastSlots = []

  // 施放管线（第五刀·表现）：宿主推 type:'cast' 起播，之后每个 tick 用 castPhase 报相位
  //   0 起手 → 1 生成 → impactAt(2) 命中 →（有追击）3 追击 →（有反击）末帧 反击；-1 = 没在播
  //   口径：命中帧之前画"出手前的旧值"，命中帧才出受击/飘字/击杀消散
  //   详细画法见 docs/游戏升级规划/10-技能书与技能库设计.md「八·补·五」
  var castFx = null // 本次施放消息（form / fx / 出手前快照）
  var castPhase = -1 // 当前相位
  var castHit = false // 命中帧是否已播（飘字/受击只播一次）
  var hitFlash = 0 // 受击闪白剩余帧（命中剪影提亮）
  var killHold = null // 击杀：命中后继续画"被打死的那只"{ flat, tier }，消散完才让位给新怪
  var killDissolve = 0 // 击杀消散剩余帧
  var killFlyAt = 0 // 击杀打飞起点（命中帧时间戳；0 = 没在打飞）
  var killFrags = [] // 击杀碎裂：从怪物自己的像素里抠出来的碎块 { x, y, vx, vy, c, t0 }
  var killFragsSpawned = false
  var castCol = '#ffd75e'
  // 施放演出的公共色（暖色口径）：暖白热芯 + 重击金（低概率高倍率 = 重击高光的既定金）
  var CORE = '#FFF6D8'
  var GOLD = '#FFD75E'
  // —— 动画时钟（治"攻击过程卡顿"）——
  // 宿主 tick（tickMs 可配置，默认 400）只报"播到哪个相位"；相位内的运动由 rAF 按时间细步推进
  // （坐标仍按格取整、保持硬边，但 60fps 连贯）。tick 间隔在场景里自行估计，用于折算相位内进度。
  var phaseAt = 0 // 当前相位开始的时间戳
  var lastTickAt = 0 // 上一条 tick 的时间戳（估 tickMs 用）
  var tickMsEst = 400 // tick 间隔估计
  var hitFlashAt = -1e9 // 受击闪白起始时间（255ms 内衰减，比按帧数更跟手）
  var playerHitAt = -1e9 // 主角挨打（反击帧）起始时间：暖红罩 + 下压 1 格 + 被打退一步
  // 主角表情/呼吸（0.7.0）：帧表与小屋同一份（actor-frames.js），战斗页只借用"脸"，
  // 位移仍由 playerShift / lunge 算 —— 两套互不干扰。
  var idleSince = 0 // 最近一次"有动作"的时间（用于 25s 后打哈欠）
  var yawnUntil = 0 // 待机哈欠的结束时间（0 = 没在打）
  var victoryAt = 0 // 击杀庆祝起点（holdingKill 结束即收）
  var heartAt = 0 // 庆祝冒心的下一次时间

  var dmgAt = 0 // 飘字弹出时间（上浮按时间推）
  var lungeAt = 0 // 前冲上升沿时间（前冲改"冲出去再收回来"的半波曲线）
  var rafId = 0
  function ensureLoop() {
    if (rafId || !window.requestAnimationFrame) return
    rafId = window.requestAnimationFrame(loopFrame)
  }
  function loopFrame() {
    rafId = 0
    var now = Date.now()
    // 没有活动演出就停表（不空转）；有任何一个在播就整帧重绘
    if (!(castPhase >= 0 || killDissolve > 0 || dmg.ticks > 0 ||
      now - hitFlashAt < 300 || now - playerHitAt < 300)) return
    draw()
    rafId = window.requestAnimationFrame(loopFrame)
  }
  // 标签色：与 10 文档的 9 个标签一一对应（纯表现，不影响任何数值）
  // 招式主色（第五刀·表现）：每个原语自带一套主色，标签色只留给"施放环/标签特效"。
  // 12 个原语共用一套标签色会让人觉得"每个技能都一样"，主色分开后一眼能认出是哪个招式。
  var FORM_COLOR = {
    bolt: '#FFD75E', thrust: '#FFB86B', slash: '#FF8A5C', burst: '#FF9A5C',
    drip: '#7EE08A', stamp: '#7FB0FF', ward: '#7FC8FF', vortex: '#C08AFF',
    stack: '#FFC46B', chars: '#8FE8FF', boomerang: '#FF9EC4', hail: '#9FE8FF',
  }
  // 命中反馈配方：不同原语用不同的反馈件——12 个都套同一套"冲击波 + 余烬 + 碎块"必然显重复
  //   wave 冲击波环 / embers 余烬 / shards 碎块雨 / cracks 地面裂痕
  //   arc 刀光横扫（斩击）/ blocks 方块直落（层叠）/ spots 多点溅射（骤雨）/ push 击退（直刺）
  var HIT_STYLE = {
    bolt: { wave: 1, embers: 1, shards: 0, cracks: 1 },
    thrust: { wave: 0, embers: 0, shards: 1, cracks: 0, push: 1 },
    slash: { wave: 0, embers: 1, shards: 1, cracks: 0, arc: 1 },
    burst: { wave: 1, embers: 1, shards: 1, cracks: 1 },
    drip: { wave: 0, embers: 0, shards: 0, cracks: 0 },
    stamp: { wave: 0, embers: 0, shards: 0, cracks: 1 },
    ward: { wave: 0, embers: 0, shards: 0, cracks: 0 },
    vortex: { wave: 0, embers: 0, shards: 1, cracks: 0 },
    stack: { wave: 0, embers: 0, shards: 1, cracks: 1, blocks: 1 },
    chars: { wave: 0, embers: 0, shards: 1, cracks: 0 },
    boomerang: { wave: 0, embers: 0, shards: 0, cracks: 0 },
    hail: { wave: 0, embers: 0, shards: 0, cracks: 0, spots: 1 },
  }
  // 施法者姿态（第五刀·表现）：每个原语在"起手/生成"两拍的形态都不同——
  // 12 个技能都套同一个"脚下圆环 + 三粒聚能"会显得主角只会一招。
  //   stance: 起手位移（-后撤 / +前压，单位格）；命中拍从站位冲到 dash
  //   dash:   命中冲出的格数（0 = 原地出手：远程/自身增益不该每次都扑出去）
  //   ring:   out 逐拍外扩 / in 向内收束（蓄力感）/ double 双环 / none 不画
  //   charge: 蓄能形态 sky 头顶聚能 / lance 身后夹持 / lift 举印 / blocks 叠块 / drop 身前滴落 /
  //           none（招式自己画）
  var CAST_POSE = {
    bolt: { stance: -1, dash: 0, ring: 'in', charge: 'sky' },
    thrust: { stance: -3, dash: 5, ring: 'none', charge: 'lance' },
    slash: { stance: 1, dash: 3, ring: 'none', charge: 'none' },
    burst: { stance: 0, dash: 1, ring: 'out', charge: 'none' },
    drip: { stance: 0, dash: 0, ring: 'in', charge: 'drop' },
    stamp: { stance: 0, dash: 2, ring: 'none', charge: 'lift' },
    ward: { stance: 0, dash: 0, ring: 'double', charge: 'none' },
    vortex: { stance: 0, dash: 0, ring: 'in', charge: 'none' },
    stack: { stance: 0, dash: 0, ring: 'none', charge: 'blocks' },
    chars: { stance: 1, dash: 3, ring: 'none', charge: 'none' },
    boomerang: { stance: 0, dash: 1, ring: 'none', charge: 'none' },
    hail: { stance: 0, dash: 0, ring: 'out', charge: 'sky' },
  }
  var DEFAULT_POSE = { stance: 0, dash: 1, ring: 'out', charge: 'none' }
  function castPose() {
    return CAST_POSE[(castFx && castFx.form) || 'burst'] || DEFAULT_POSE
  }

  // 主角位移（第五刀·表现）：施放期间按 CAST_POSE 走"起手站位 → 命中冲出"，
  // 前冲从起手拍挪到命中拍（蓄力—出手—命中，才像一记动作）。
  // 普攻（没有 cast 消息）仍走 lunge 的正弦半波，行为不变。
  function playerShift(prog) {
    if (!(castFx && castPhase >= 0)) {
      if (!tick.lunge) return 0
      return Math.round(Math.sin(Math.PI * Math.min(1, (Date.now() - lungeAt) / (3 * tickMsEst))) * 3)
    }
    var pose = castPose()
    var back = pose.stance || 0
    var impact = castFx.impactAt == null ? 2 : castFx.impactAt
    if (castPhase < impact) {
      // 起手 → 生成：逐拍推到站位（后撤 = 蓄力拖拽，前压 = 上步）
      var k = Math.min(1, (castPhase + (prog || 0)) / Math.max(1, impact))
      return Math.round(back * k)
    }
    // 反击帧（仅 countered）：怪物打回来了，主角被打退一步（下一拍自然站回原位）
    var frames = castFx.frames || 3
    if (castFx.countered && castPhase >= frames - 1) return -1
    // 命中：从站位一口气冲出去，拍末收回 0
    var fwd = pose.dash == null ? 1 : pose.dash
    var s = (castPhase - impact) + (prog || 0)
    if (s >= 1) return 0
    return Math.round(back * (1 - s) + fwd * Math.sin(Math.PI * s))
  }
  var CAST_COLORS = {
    crit: '#ffd75e', chase: '#9fe8ff', pierce: '#ffb347', rend: '#ff8a5c',
    aim: '#b6ff9e', leech: '#7ee08a', guard: '#7fc8ff', surge: '#ffd75e', reflect: '#ff9ec4',
  }

  // 掉落飞书（第五刀·表现）：技能书从被打死的那只身上飞向右下角的 4 个技能槽。
  // 纯 DOM + 像素画布：24×24 的书按格移动（位置取整，不做插值过渡），落地炸 4 粒，
  // 然后 postMessage('bookLanded') 通知 pet.js 弹 toast（提示与演出同一拍）。
  var viewMeta = { S: 4, enemy: null } // draw() 每帧更新：CSS 每逻辑格像素数 + 敌方槽位
  var bookPending = null // 掉落先记着，等击杀演出播到"碎开"再起飞
  function launchBookFly(sprite) {
    var done = function () {
      try { window.postMessage({ type: 'bookLanded' }, '*') } catch (e) { /* 老环境忽略 */ }
    }
    var wrap = document.getElementById('kslotWrap')
    var target = wrap ? wrap.getBoundingClientRect() : null
    var src = viewMeta.enemy
    if (!sprite || !target || !target.width || !src) { done(); return }
    var rect = cv.getBoundingClientRect()
    var S = viewMeta.S || 4
    var fromX = rect.left + (src.x + 12) * S
    var fromY = rect.top + (src.y + 8) * S
    var toX = target.left + target.width / 2
    var toY = target.top + target.height / 2
    var el = document.createElement('canvas')
    el.width = GRID
    el.height = GRID
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;image-rendering:pixelated;pointer-events:none'
    var g2 = el.getContext('2d')
    for (var i = 0; i < sprite.length; i++) {
      if (!sprite[i]) continue
      g2.fillStyle = sprite[i]
      g2.fillRect(i % GRID, (i / GRID) | 0, 1, 1)
    }
    document.body.appendChild(el)
    var t0 = Date.now()
    var dur = 700
    var peakY = Math.min(fromY, toY) - 34 // 抛物线顶点：先抬起来再落进槽位
    function step() {
      var t = Math.min(1, (Date.now() - t0) / dur)
      var e = t * t * (3 - 2 * t)
      var x = (1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * ((fromX + toX) / 2) + e * e * toX
      var y = (1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * peakY + e * e * toY
      var px = t < 0.72 ? 2 : 1 // 缩放在 72% 处跳变（硬边口径：不做平滑缩放）
      el.style.width = GRID * px + 'px'
      el.style.height = GRID * px + 'px'
      el.style.left = Math.round(x - GRID * px / 2) + 'px'
      el.style.top = Math.round(y - GRID * px / 2) + 'px'
      if (t >= 1) { landSpark(el, toX, toY); done(); return }
      window.requestAnimationFrame(step)
    }
    window.requestAnimationFrame(step)
  }
  // 落地：同一个画布缩成 9×9 的十字星闪一下再移除（不新增图片/不做 CSS 过渡）
  function landSpark(el, x, y) {
    el.width = 9
    el.height = 9
    el.style.width = '27px'
    el.style.height = '27px'
    el.style.left = Math.round(x - 13) + 'px'
    el.style.top = Math.round(y - 13) + 'px'
    var g3 = el.getContext('2d')
    g3.fillStyle = CORE
    g3.fillRect(4, 0, 1, 9)
    g3.fillRect(0, 4, 9, 1)
    g3.fillRect(3, 3, 3, 3)
    g3.fillStyle = GOLD
    g3.fillRect(1, 1, 1, 1)
    g3.fillRect(7, 7, 1, 1)
    g3.fillRect(7, 1, 1, 1)
    g3.fillRect(1, 7, 1, 1)
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el) }, 220)
  }

  // 击杀碎裂：从怪物自己的像素里稀疏抠出碎块（颜色原样取自身上的像素）——
  // 不是"再撒一把同色渣子"，碎了之后确实少了那几块，颜色也对得上。
  function spawnKillFrags(x0, y0, flat, nowMs) {
    killFrags = []
    if (!flat) return
    for (var i = 0; i < flat.length; i++) {
      if (!flat[i] || i % 11 !== 0) continue
      killFrags.push({
        x: x0 + (i % GRID),
        y: y0 + ((i / GRID) | 0),
        c: flat[i],
        t0: nowMs,
        vx: 0.018 + (i % 5) * 0.004, // 整体顺着"打飞"的方向往右
        vy: -0.03 + (i % 3) * 0.004, // 先往上抛
      })
    }
  }

  function draw() {
    var rect = stage.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) return
    if (!state) return

    // 击杀演出期间：主题跟着"被打死的那只"走（新怪可能是另一个 tier，不能提前换皮）
    var holdingKill = !!(killHold && (castPhase >= 0 || killDissolve > 0))
    var T = THEMES[holdingKill ? killHold.tier : state.enemyTier] || THEMES.common
    // 逻辑网格必须装得下「角色 24 格 + 头顶 HUD 5 格 + 地面」≈ 48×132 格。
    // 宽高要一起判：底部面板常常是"很宽但很矮"，只看宽度会把矮面板判成大格。
    var S = 4
    while (S > 2 && (rect.width / S < 132 || rect.height / S < 48)) S--
    var dpr = window.devicePixelRatio || 1
    var scale = Math.max(1, Math.round(S * dpr))
    var W = Math.max(40, Math.ceil(rect.width / S))
    var H = Math.max(28, Math.ceil(rect.height / S))

    if (cv.width !== W * scale || cv.height !== H * scale) {
      cv.width = W * scale
      cv.height = H * scale
    }
    cv.style.width = W * S + 'px'
    cv.style.height = H * S + 'px'
    // 窄栏：给 HUD 条腾地方（次要数值收起，保证日志与按钮不被挤扁）
    stage.classList.toggle('s3', S <= 3)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, W, H)

    // 菜单选中色跟随主题
    var nav = document.getElementById('nav')
    if (nav) nav.style.setProperty('--accent', T.accent || '#d8c08a')

    // 地面带上沿 = 角色的脚底基准线；保底 30 给角色(24格)＋头顶 HUD(约5格)留空间
    var amp = Math.max(2, Math.min(5, Math.round(H / 15)))
    var groundY = Math.max(Math.round(H * 0.56), 30 + amp)

    // —— 1. 天空（硬边色带）——
    for (var i = 0; i < T.sky.length; i++) {
      var sy0 = Math.round((groundY + 2) * (i / T.sky.length))
      var sy1 = Math.round((groundY + 2) * ((i + 1) / T.sky.length))
      ctx.fillStyle = T.sky[i]
      ctx.fillRect(0, sy0, W, sy1 - sy0)
    }

    // —— 2. 星 ——
    if (T.stars > 0 && T.star) {
      for (var s = 0; s < Math.min(T.stars, STARS.length); s++) {
        var st = STARS[s]
        var sx = Math.floor(st.u * (W - 2))
        var sy = Math.floor(st.v * (groundY - 16))
        var big = T.starEvery > 0 && s % T.starEvery === 0
        ctx.fillStyle = big ? T.star : mixHex(T.star, T.sky[0], 0.5)
        ctx.fillRect(sx, sy, big ? 2 : 1, 1)
      }
    }

    // —— 3. 远山：两层三角峰 ——
    var mtnBase = groundY - 2
    var farMax = Math.max(6, Math.round(H * 0.2))
    var p1 = makePeaks(W, mtnBase - 3, Math.max(2, Math.round(W / 48)), Math.round(farMax * 0.7), farMax, 111)
    var p2 = makePeaks(W, mtnBase, Math.max(3, Math.round(W / 36)), Math.round(farMax * 0.5), Math.round(farMax * 0.8), 222)
    ctx.fillStyle = T.far[0]
    for (var m1 = 0; m1 < W; m1++) ctx.fillRect(m1, p1[m1], 1, mtnBase - p1[m1])
    ctx.fillStyle = T.far[1]
    for (var m2 = 0; m2 < W; m2++) ctx.fillRect(m2, p2[m2], 1, mtnBase - p2[m2])

    // —— 4. 远处丘陵 ——
    var nr = mulberry32(333)
    var nh = noise1d(W, Math.max(30, W / 5), nr)
    var hillAmp = Math.max(2, Math.min(4, Math.round(H / 18)))
    var hillY = new Array(W)
    ctx.fillStyle = T.hill
    for (var h1 = 0; h1 < W; h1++) {
      hillY[h1] = groundY - 4 - Math.round((nh[h1] - 0.5) * hillAmp * 2)
      ctx.fillRect(h1, hillY[h1], 1, groundY - hillY[h1] + 1)
    }
    ctx.fillStyle = T.hillTop
    for (var h2 = 0; h2 < W; h2++) ctx.fillRect(h2, hillY[h2], 1, 1)

    // —— 5. 地面带 ——
    ctx.fillStyle = T.ground
    ctx.fillRect(0, groundY, W, H - groundY)
    ctx.fillStyle = T.groundTop
    ctx.fillRect(0, groundY, W, 1)

    // —— 6. 地平线虚线 ——
    ctx.fillStyle = T.dash
    for (var dx = 3; dx < W - 3; dx += 7) ctx.fillRect(dx, groundY + 3, 3, 1)

    // —— 7. 场景特色装饰（按 tier 换）——
    drawDeco(T, W, H, groundY)

    // —— 8. 角色：站在地面上（脚底贴地面带，只陷 2 格）——
    // 站位两侧各向中间收 0.06：原来 0.20/0.74 摆得太开，宽栏里中间空一大块
    var slots = []
    // 击杀演出期间继续画"被打死的那只"（state.enemy 已换成新怪，命中帧之前不能提前换）
    var defs = [{ key: 'player', u: 0.26, flat: state.player, hud: 'hudPlayer' },
                { key: 'enemy', u: 0.68, flat: holdingKill ? killHold.flat : state.enemy, hud: 'hudEnemy' }]
    for (var d = 0; d < defs.length; d++) {
      if (!defs[d].flat) continue
      var px = Math.max(1, Math.min(W - GRID - 1, Math.round(W * defs[d].u) - 12))
      slots.push({ key: defs[d].key, hud: defs[d].hud, x: px, y: groundY - 22, flat: defs[d].flat })
    }
    // 掉落飞书要用：本帧的像素档位 + 敌方槽位（书从尸体位置起飞）
    viewMeta.S = S
    viewMeta.enemy = null
    for (var vm = 0; vm < slots.length; vm++) if (slots[vm].key === 'enemy') viewMeta.enemy = slots[vm]

    // 落影先画（落在脚下地面上）
    ctx.fillStyle = T.contact
    for (var c = 0; c < slots.length; c++) {
      ctx.fillRect(slots[c].x + 4, groundY + 1, 16, 1)
      ctx.fillRect(slots[c].x + 6, groundY + 2, 12, 1)
    }

    // 连击光环：画在角色与草之前（角色站在光里，光从草里透出）；<10 连不出现
    var pslot = null
    for (var pi = 0; pi < slots.length; pi++) if (slots[pi].key === 'player') pslot = slots[pi]
    if (pslot && state.streakTier > 0) drawAura(T, pslot, state.streakTier, groundY)

    // 反击帧（管线的最后一拍，仅 countered 的施放有）：怪物朝玩家倾 2 格
    var now = Date.now()

    // —— 主角表情（只用帧换"脸"，位移仍由 playerShift / lunge 负责）——
    //   待机：stand→breathe→stand→stand 四拍循环（1.6s 一次呼吸，不改全局 400ms 节拍）
    //   施放：命中拍及后一拍张嘴（≈800ms）
    //   挨打：闭眼 2 拍（红罩仍 180ms 淡出）
    //   击杀：闭眼 + 两下小跳 + 冒心，新怪出现即收
    //   待机 >25s：打一个哈欠
    var impactP = castFx && castFx.impactAt != null ? castFx.impactAt : 2
    var busy = !!tick.lunge || castPhase >= 0 || now - playerHitAt < 800 || holdingKill
    if (busy) {
      idleSince = now
      yawnUntil = 0
    } else if (!idleSince) {
      idleSince = now
    }
    if (!busy && !yawnUntil && now - idleSince > 25000) yawnUntil = now + 800
    if (yawnUntil && now > yawnUntil) {
      yawnUntil = 0
      idleSince = now
    }
    var beat = Math.floor(now / 400) % 4
    var pFrame = 'stand'
    if (holdingKill) pFrame = 'happy'
    else if (now - playerHitAt < 800) pFrame = 'happy'
    else if (castFx && castPhase >= impactP && castPhase <= impactP + 1) pFrame = 'angry2' // 喊招：龇牙 + 压头
    else if (tick.lunge) pFrame = 'angry' // 普攻前冲：龇牙
    else if (yawnUntil) pFrame = Math.floor(now / 400) % 2 ? 'yawn2' : 'yawn1'
    else if (beat === 1) pFrame = 'breathe'
    var pFlat = frameFlat(pFrame)
    // 庆祝：holdingKill 期间算 victory；新怪出现（holdingKill 结束）立刻收
    if (holdingKill && !victoryAt) {
      victoryAt = now
      heartAt = 0
    } else if (!holdingKill && victoryAt) {
      victoryAt = 0
    }
    var counterAt = castFx && castFx.countered ? (castFx.frames || 3) - 1 : -1
    var enemyOx = castPhase === counterAt ? -2 : 0
    // 相位内进度（0..0.95）：rAF 把相位内的运动摊到 60fps（位置仍按格取整）
    var prog = castPhase >= 0 ? Math.min(0.95, Math.max(0, (now - phaseAt) / tickMsEst)) : 0
    for (var a = 0; a < slots.length; a++) {
      var isP = slots[a].key === 'player'
      // 主角位移：施放期按 CAST_POSE 摆姿态（起手后撤/前压，命中拍冲出去）；
      // 普攻仍走 lunge 正弦半波（冲出去再收回来，宽度 ≈ 3 拍）/ 待机隔帧下沉 1 格 / 击败隔帧消散
      var ox = isP ? playerShift(prog) : enemyOx
      // 直刺的专属反馈：命中瞬间把敌人往后推 2 格（冲击力落在"推"上，不是"炸一下"）
      if (!isP && castFx && castFx.form === 'thrust' && castHit && now - hitFlashAt < 200) ox += 2
      var oy = isP ? (tick.lunge || !tick.frame ? 0 : 1) : 0
      if (!isP && castHit && now - hitFlashAt < 140) oy += 1 // 命中顿帧：被打的那一瞬往下压 1 格
      if (isP && now - playerHitAt < 160) oy += 1 // 主角挨打：同样下压 1 格的顿帧
      // 击杀庆祝：600ms 一下、共两下小跳（只有 holdingKill 期间，新怪出现即停）
      if (isP && holdingKill && victoryAt) {
        var vt = ((now - victoryAt) % 600) / 600
        oy -= Math.round(Math.sin(vt * Math.PI) * 2)
      }
      // 击杀打飞：命中帧起 1 拍内被打出去（右移 12 格 + 抬空 5 格，先快后慢），
      // 随后在空里继续沿用老的"隔帧闪烁"消散——打飞与闪烁是叠加，不是替换
      if (!isP && holdingKill && killFlyAt) {
        var flyT = Math.min(1, (now - killFlyAt) / Math.max(200, tickMsEst))
        var flyEase = 1 - (1 - flyT) * (1 - flyT)
        ox += Math.round(flyEase * 12)
        oy -= Math.round(Math.sin(flyT * Math.PI / 2) * 5)
        if (!killFragsSpawned) {
          killFragsSpawned = true
          spawnKillFrags(slots[a].x, slots[a].y, slots[a].flat, now)
        }
      }
      // 击杀消散由管线接管（命中后才开始）；宿主的 dissolve 标志只兜底"普攻击杀"（无 cast 消息）
      var hide = !isP && (holdingKill
        ? killDissolve > 0 && tick.frame % 2 === 0
        : tick.dissolve && tick.frame % 2 === 0)
      // 主角用帧（呼吸/张嘴/闭眼），敌人仍用一张图；两边的罩色路径完全一样
      var bodyFlat = isP && pFlat ? pFlat : slots[a].flat
      drawFlat(bodyFlat, slots[a].x + ox, slots[a].y + oy, hide)
      // 受击闪白：命中后 255ms 内整格提亮并衰减（特效画在闪白之上，太亮太久会把特效吃掉）
      if (!isP && now - hitFlashAt < 255) {
        drawFlat(bodyFlat, slots[a].x + ox, slots[a].y + oy, hide, CORE, 0.55 * (1 - (now - hitFlashAt) / 255))
      }
      // 主角挨打（反击帧）：暖红罩 180ms 衰减——白 = 敌人在掉血，红 = 我在掉血，一眼分得开
      // （0.42 而不是敌方的 0.55：整格罩色会把角色压成一个橙块，主角的脸/轮廓得留住）
      if (isP && now - playerHitAt < 180) {
        drawFlat(bodyFlat, slots[a].x + ox, slots[a].y + oy, hide, '#ff7043', 0.42 * (1 - (now - playerHitAt) / 180))
      }
      // 生气符号：普攻前冲 / 施放命中时挂在头顶右侧（与 pFrame 的撇嘴同步）
      if (isP && (tick.lunge || (castFx && castPhase >= impactP && castPhase <= impactP + 1))) {
        drawAnger(slots[a].x + ox + 15, slots[a].y + oy + 1, now)
      }
      // 庆祝时在头顶冒一颗心（纯表现，跟着跳）
      if (isP && holdingKill && victoryAt && now - heartAt > 480) {
        heartAt = now
      }
      if (isP && holdingKill && victoryAt) {
        drawHeart(slots[a].x + ox + 9, slots[a].y + oy - 5 - (((now - victoryAt) / 22) % 10), 1)
      }
    }

    // —— 8b. 击杀碎裂：碎块按时间走抛物线（重力 0.00005 格/ms²），落回地面或超时就灭 ——
    if (killFrags.length) {
      var rest = []
      for (var kf = 0; kf < killFrags.length; kf++) {
        var fr = killFrags[kf]
        var ft = now - fr.t0
        var fy = fr.y + fr.vy * ft + 0.00005 * ft * ft
        if (ft > 900 || fy > groundY + 1) continue
        var fx = fr.x + fr.vx * ft
        if (fx < -2 || fx > W + 2) continue
        ctx.globalAlpha = ft > 640 ? Math.max(0, 1 - (ft - 640) / 260) : 1
        ctx.fillStyle = fr.c
        ctx.fillRect(Math.round(fx), Math.round(fy), 1, 1)
        rest.push(fr)
      }
      ctx.globalAlpha = 1
      killFrags = rest
    }

    // 掉落飞书：怪物被打飞、碎开（约 420ms）之后才起飞——书从尸体位置飞向技能槽。
    // 还在等击杀演出（cast 里带 killed 但还没到命中帧）时不起飞，避免书先飞、人还没死。
    if (bookPending) {
      var stillWaiting = castFx && castFx.killed && !killFlyAt
      if (!stillWaiting && (!killFlyAt || now - killFlyAt > 420)) {
        var bm = bookPending
        bookPending = null
        launchBookFly(bm.sprite)
      }
    }

    // —— 9. 前景草带：锯齿上沿 + 不规则草叶，压住角色脚踝 ——
    var grassY = groundY + 4
    ctx.fillStyle = T.grassLit
    for (var g1 = 0; g1 < W; g1++) {
      var jag = g1 % 6 < 3 ? 0 : 1
      ctx.fillRect(g1, grassY + 2 - jag, 1, H - grassY - 2 + jag)
    }
    ctx.fillStyle = T.grass
    ctx.fillRect(0, grassY + 5, W, H - grassY - 5)
    // 草叶：间距拉开、高度压到 1~2 格 —— 太密会连成"网格"而不是草地
    var rGrass = mulberry32(555)
    ctx.fillStyle = T.grassLit
    for (var g2 = 1; g2 < W; g2 += 5 + Math.floor(rGrass() * 7)) {
      var gh = 1 + Math.floor(rGrass() * 2)
      ctx.fillRect(g2, grassY + 5 - gh, 1, gh)
    }

    // —— 超载演出：飞散数据块（叠在最上层，一次约 5 帧）——
    var eslot = null
    for (var ei = 0; ei < slots.length; ei++) if (slots[ei].key === 'enemy') eslot = slots[ei]
    if (burstFrames > 0 && eslot) drawBurst(eslot, 5 - burstFrames)

    // —— 技能施放（第五刀·施放管线）：招式原语 + 标签特效（叠在最上层，与飞散块同层）——
    if (castPhase >= 0 && pslot) drawCast(pslot, eslot, castPhase, groundY, prog)

    lastSlots = slots
    positionHud(slots, S)
    syncWeaponSlot(S)
    updateDmg(eslot, S)
    updateBadge(T)
  }

  // 头顶连击徽标（玩家名字后）：<10 连隐藏（跳变）；低档随主题色、高档亮金
  function updateBadge(T) {
    var el = document.getElementById('comboBadge')
    if (!el) return
    var tier = state.streakTier || 0
    if (!tier) {
      el.classList.add('hidden')
      return
    }
    el.classList.remove('hidden')
    el.textContent = '×' + state.streak
    el.style.setProperty('--comboBg', tier >= 2 ? '#FFD75E' : mixHex(T.accent || '#d8c08a', '#FFFFFF', 0.72))
    el.classList.toggle('hot', tier >= 2)
  }

  // ============================================================
  // 连击（Combo）视觉 —— 详细口径见 docs/游戏升级规划/09-连击系统设计.md
  //   光环：低档 = 主题色提亮版（+深色衬底，否则在浅色草地上会隐形）；高档 = 亮金 + 弧顶白高光
  //   演出：≥50 连时由宿主推 burst，飞散块随帧向外扩散（纯程序化，零素材）
  // ============================================================
  function drawAura(T, slot, tier, groundY) {
    var cx = slot.x + 12
    var cy = groundY + 2 // 脚底
    var gold = tier >= 2
    var col = gold ? '#FFD75E' : mixHex(T.accent || '#d8c08a', '#FFFFFF', 0.72)
    var ink = gold ? '#5A3406' : mixHex(T.accent || '#d8c08a', '#000000', 0.75)
    var lit = '#FFF6D8'
    var RX = gold ? 15 : 13
    var RY = gold ? 4 : 3.6
    var dx, t, yy, y
    var dot = function (x, y2, c) {
      ctx.fillStyle = ink
      ctx.fillRect(x, y2 + 1, 1, 1)
      ctx.fillStyle = c
      ctx.fillRect(x, y2, 1, 1)
    }
    // 上弧：逐列满弧
    for (dx = -RX; dx <= RX; dx++) {
      t = dx / RX
      yy = Math.sqrt(Math.max(0, 1 - t * t))
      y = cy - Math.round(yy * RY)
      dot(cx + dx, y, col)
      if (gold && yy > 0.72) { // 弧顶白高光（硬边点，不衬底以免盖掉主色点）
        ctx.fillStyle = lit
        ctx.fillRect(cx + dx, y - 1, 1, 1)
      }
    }
    // 下弧：只补两侧（正下方被脚和草挡住；画满会变「魔法阵」）
    for (dx = -RX; dx <= RX; dx++) {
      if (Math.abs(dx) / RX < 0.45) continue
      t = dx / RX
      yy = Math.sqrt(Math.max(0, 1 - t * t))
      y = cy + Math.max(1, Math.round(yy * 1.8))
      dot(cx + dx, y, col)
    }
    // 上升粒子：两侧各 2 个（左高右低；动画用 2 帧跳变，这里按 tick.frame 取一相位）
    var hi = tick.frame ? 1 : 0
    var parts = gold
      ? [[-11, 6 + hi, col], [-14, 11, lit], [11, 5, lit], [14, 10 + hi, col]]
      : [[-10, 5 + hi, col], [10, 7, col]]
    for (var i = 0; i < parts.length; i++) dot(cx + parts[i][0], cy - parts[i][1], parts[i][2])
  }

  // 超载演出：怪物周围飞散的数据块 + 像素十字星，随 phase（0→4）向外扩散
  function drawBurst(slot, phase) {
    var cx = slot.x + 12
    var cy = slot.y + 8
    var r = mulberry32(9001)
    var cols = ['#FFD75E', '#FFF6D8', '#FFB347']
    var spread = 4 + phase * 4
    var i, a, d, x, y, s
    for (i = 0; i < 10; i++) {
      a = r() * Math.PI * 2
      d = 8 + r() * 16 + spread
      x = Math.round(cx + Math.cos(a) * d)
      y = Math.round(cy + Math.sin(a) * d * 0.7)
      s = 1 + Math.round(r() * 2)
      ctx.fillStyle = cols[i % cols.length]
      ctx.fillRect(x, y, s, s)
    }
    star4(cx - 14 - spread, cy - 6, '#FFF6D8')
    star4(cx + 16 + spread, cy + 8, '#FFD75E')
  }

  // 像素「米」字星（四向 + 四角点）
  function star4(x, y, col) {
    ctx.fillStyle = col
    ctx.fillRect(x - 2, y, 5, 1)
    ctx.fillRect(x, y - 2, 1, 5)
    ctx.fillRect(x - 1, y - 1, 1, 1)
    ctx.fillRect(x + 1, y - 1, 1, 1)
    ctx.fillRect(x - 1, y + 1, 1, 1)
    ctx.fillRect(x + 1, y + 1, 1, 1)
  }

  // 像素线（整数步进，硬边）：落雷/直刺/斩痕共用
  function pline(x0, y0, x1, y1, col) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    var err = dx - dy
    for (;;) {
      ctx.fillStyle = col
      ctx.fillRect(x0, y0, 1, 1)
      if (x0 === x1 && y0 === y1) break
      var e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 < dx) { err += dx; y0 += sy }
    }
  }

  // 方块轮廓（dashed = 隔 1 空 1 的虚线边）：层叠/印戳/回旋补丁共用
  function pbox(x, y, w, h, col, dashed) {
    for (var i = 0; i < w; i++) {
      if (dashed && i % 2) continue
      ctx.fillStyle = col
      ctx.fillRect(x + i, y, 1, 1)
      ctx.fillRect(x + i, y + h - 1, 1, 1)
    }
    for (var j = 1; j < h - 1; j++) {
      if (dashed && j % 2) continue
      ctx.fillStyle = col
      ctx.fillRect(x, y + j, 1, 1)
      ctx.fillRect(x + w - 1, y + j, 1, 1)
    }
  }

  // 每发施放固定种子的伪随机：余烬/碎屑的落点逐帧一致（不闪），不同施放之间又不重样
  function srand(i) {
    var seed = (castFx && castFx.at) || 7
    var s = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
    return s - Math.floor(s)
  }

  // 施放阵（脚下法阵）：四种形态——out 外扩 / in 收束 / double 双环 / none 不画
  // 点都先落一层暗描边再点主色：环贴在角色脚下，不描边就跟暖黄的身体糊成一片
  function drawCastRing(kind, cx, cy, fp, mc, heavy) {
    if (kind === 'none') return
    var bump = heavy ? 2 : 0
    var dark = mixHex(mc, '#000000', 0.72)
    function dot(x, y) {
      ctx.fillStyle = dark
      ctx.fillRect(x, y + 1, 1, 1)
      ctx.fillStyle = mc
      ctx.fillRect(x, y, 1, 1)
    }
    if (kind === 'in') {
      // 收束：环从外往里吸（起手 10 格 → 命中前 4 格），圈内白点向中心跑 = 蓄满
      var rIn = Math.max(4, Math.round(10 + bump - fp * 2.5))
      for (var dx = -rIn; dx <= rIn; dx++) {
        var dy = Math.round((rIn - Math.abs(dx)) * 0.5)
        dot(cx + dx, cy - dy)
        if (dx % 4 === 0) { ctx.fillStyle = CORE; ctx.fillRect(cx + dx, cy - dy - 1, 1, 1) }
      }
      var r2 = Math.max(2, Math.round(5 - fp))
      ctx.fillStyle = CORE
      for (var a2 = 0; a2 < 6; a2++) {
        var ang = a2 * Math.PI / 3 + fp * 0.6
        ctx.fillRect(Math.round(cx + Math.cos(ang) * r2), Math.round(cy - 2 + Math.sin(ang) * r2 * 0.5), 1, 1)
      }
      return
    }
    if (kind === 'double') {
      // 双环：外圈实线逐拍外扩，内圈虚线反向转 = 护盾在成型
      var ra = 5 + Math.min(fp, 2) * 2 + bump
      var rb = Math.max(3, ra - 2)
      for (var da = -ra; da <= ra; da++) dot(cx + da, cy - Math.round((ra - Math.abs(da)) * 0.5))
      for (var db = -rb; db <= rb; db++) {
        if ((db + Math.floor(fp * 3)) % 2) continue
        ctx.fillStyle = CORE
        ctx.fillRect(cx + db, cy - Math.round((rb - Math.abs(db)) * 0.5) - 1, 1, 1)
      }
      return
    }
    // 外扩（默认）：逐拍扩出去，命中拍停住
    var R = 6 + Math.min(fp, 2) * 2 + bump
    for (var ex = -R; ex <= R; ex++) {
      var ey = Math.round((R - Math.abs(ex)) * 0.5)
      dot(cx + ex, cy - ey)
      if (ex % 3 === 0) { ctx.fillStyle = CORE; ctx.fillRect(cx + ex, cy - ey - 1, 1, 1) }
    }
  }

  // 蓄能形态：sky 头顶聚能 / lance 身后夹持 / lift 举印 / blocks 叠块 / drop 身前滴落 /
  //           none 不画（交给招式自己）
  function drawCastCharge(kind, cx, cy, fp, phase, mc) {
    if (!kind || kind === 'none') return
    var i, t, gx, gy
    if (kind === 'sky') {
      // 头顶聚能：3 粒从上方落进光核，核逐拍变大（落雷/滴落/骤雨都是"从天上来"）
      var hy = cy - 26
      for (i = 0; i < 3; i++) {
        t = (fp * 1.6 + i * 0.34) % 1
        gx = Math.round(cx + 6 - t * 12)
        gy = Math.round(hy - 12 + t * 12)
        ctx.fillStyle = i === 1 ? CORE : mc
        ctx.fillRect(gx, gy, 1, 1)
      }
      var rr = 1 + Math.min(fp, 3)
      ctx.fillStyle = CORE
      ctx.fillRect(cx - rr, hy, rr * 2 + 1, 1)
      ctx.fillRect(cx, hy - rr, 1, rr * 2 + 1)
      ctx.fillStyle = mc
      ctx.fillRect(cx - rr - 1, hy, 1, 1); ctx.fillRect(cx + rr + 1, hy, 1, 1)
      return
    }
    if (kind === 'lance') {
      // 身后夹持：长枪收在身侧，3 粒点拖在枪杆上往里收；身前的虚线指住突刺方向
      var ly = cy - 14
      for (i = 0; i < 3; i++) {
        var ld = 5 + i * 4 + ((fp * 5 + i) % 4)
        ctx.fillStyle = i === 0 ? CORE : mc
        ctx.fillRect(cx - 5 - ld, ly, 2, 1)
      }
      ctx.fillStyle = CORE
      ctx.fillRect(cx - 4, ly, 1, 1)
      ctx.fillStyle = mixHex(mc, '#000000', 0.4)
      for (var lx = cx + 3; lx < cx + 17; lx += 3) ctx.fillRect(lx, ly, 1, 1)
      return
    }
    if (kind === 'lift') {
      // 举印：头顶托起一枚印，逐拍抬高 2 格，四角带白点（印戳 = 先举后砸）
      var py = cy - 26 - Math.min(fp, 2) * 2
      ctx.fillStyle = mixHex(mc, '#000000', 0.35) // 托举的手：印下方两条短竖
      ctx.fillRect(cx - 2, py + 5, 1, 3)
      ctx.fillRect(cx + 2, py + 5, 1, 3)
      pbox(cx - 4, py, 9, 5, mc)
      ctx.fillStyle = CORE
      ctx.fillRect(cx - 3, py + 1, 1, 1); ctx.fillRect(cx + 3, py + 1, 1, 1)
      ctx.fillRect(cx, py + 2, 1, 1)
      return
    }
    if (kind === 'blocks') {
      // 叠块：身前一层层码起来（每拍加一块，最新那块闪白）——层叠越码越高
      var n = 1 + Math.min(2, Math.floor(fp))
      for (i = 0; i < n; i++) {
        var by = cy - 4 - i * 4
        var fresh = i === n - 1 && phase > 0
        ctx.fillStyle = fresh ? CORE : mc
        ctx.fillRect(cx + 8, by, 7, 2)
        ctx.fillStyle = mixHex(mc, '#000000', 0.5) // 块缝：一眼看得出是"码起来的"
        ctx.fillRect(cx + 8, by + 2, 7, 1)
        ctx.fillStyle = mixHex(mc, '#000000', 0.3)
        ctx.fillRect(cx + 8, by, 1, 2); ctx.fillRect(cx + 14, by, 1, 2)
      }
      return
    }
    if (kind === 'drop') {
      // 滴落：手心凝一颗水珠，逐拍掉到地上，地面留一小滩（越滴越宽）
      var t2 = fp % 1
      var py2 = Math.round(cy - 16 + t2 * 14)
      ctx.fillStyle = mixHex(mc, '#000000', 0.3)
      ctx.fillRect(cx + 6, py2 + 2, 2, 1)
      ctx.fillStyle = mc
      ctx.fillRect(cx + 6, py2, 2, 2)
      ctx.fillStyle = CORE
      ctx.fillRect(cx + 6, py2, 1, 1)
      var pool = 1 + Math.min(3, Math.floor(fp))
      ctx.fillStyle = mixHex(mc, '#000000', 0.2)
      ctx.fillRect(cx + 6 - pool, cy, pool * 2 + 1, 1)
      return
    }
  }

  // 施放管线（第五刀·表现）：相位驱动的招式演出。
  //   0 起手（施法者处蓄力）→ 1 生成（招式成形/飞行）→ ≥impactAt 命中（受击反馈）→
  //   追击帧（第二击）→ 反击帧（怪物回击，仅 countered）。
  // 房规照 09 连击：纯程序化、硬边、按帧跳变（不加圆角/模糊/过渡，零新素材）。
  // 配色口径（暖色 · 游戏感）：col = 标签色 / CORE = 暖白热芯 / 金 = 重击 / 橙火 = 受击余烬。
  function drawCast(p, e, phase, groundY, prog) {
    var msg = castFx || {}
    var f = msg.fx || {}
    var col = castCol
    // 招式主色：施放阵与命中反馈跟主色走（标签色只留给标签特效与横幅），每个原语一眼可辨
    var mc = FORM_COLOR[msg.form] || col
    var heavy = (msg.tier || 1) >= 3
    var impact = msg.impactAt == null ? 2 : msg.impactAt
    // 施法者站位随姿态动：法阵画在他脚下、蓄能长在他身上，不能留在原地
    var shift = playerShift(prog)
    var cx = p.x + 12 + shift
    var cy = groundY + 2
    var ex = e ? e.x + 12 : p.x + 38
    var ey = e ? e.y + 10 : cy - 14
    var hit = phase >= impact
    var since = phase - impact
    var sinceF = since + (prog || 0) // 相位内进度也折进运动（rAF 摊到 60fps）
    var fp = phase + (prog || 0)
    var pose = castPose()
    // ① 施放阵 + 蓄能：形态按 CAST_POSE 分（12 个技能都套同一个环与同一把聚能 = 只会一招）
    var R = 6 + Math.min(fp, 2) * 2 + (heavy ? 2 : 0)
    if (phase < impact) {
      drawCastRing(pose.ring, cx, cy, fp, mc, heavy)
      drawCastCharge(pose.charge, cx, cy, fp, phase, mc)
    }
    // ② 招式原语（12 选 1，逐本指派；缺省回落 burst，保证任何一本都能画出效果）
    // 起手点跟着站位走：后撤蓄力时，招式要从他真正站的地方长出来
    drawForm(msg.form || 'burst', { x: p.x + shift }, e, phase, impact, groundY, col, heavy, prog)
    // ③ 命中反馈：按招式取"配方"（见 HIT_STYLE）——不同原语的反馈件不同，避免每个技能都"炸一下"
    var hs = HIT_STYLE[msg.form] || HIT_STYLE.burst
    if (hit && sinceF <= 2.4) {
      // 冲击波环：只有"重击型"原语有（落雷/爆发/层叠等）
      if (hs.wave) {
        var wr2 = 3 + sinceF * 3
        for (var wdx = -wr2; wdx <= wr2; wdx++) {
          var wdy = wr2 - Math.abs(wdx)
          ctx.fillStyle = since === 0 ? CORE : mc
          ctx.fillRect(ex + wdx, ey - 5 - wdy, 1, 1)
          ctx.fillRect(ex + wdx, ey - 5 + Math.round(wdy * 0.6), 1, 1)
        }
      }
      // 余烬：火焰系（落雷/斩击/爆发）
      if (hs.embers) {
        for (var em = 0; em < 8; em++) {
          var ea = em * Math.PI / 4 + (srand(1) - 0.5)
          var ed = 5 + sinceF * 3 + srand(em + 2) * 3
          ctx.fillStyle = em % 3 === 0 ? CORE : (em % 3 === 1 ? GOLD : '#ffb347')
          ctx.fillRect(Math.round(ex + Math.cos(ea) * ed), Math.round(ey - 5 + Math.sin(ea) * ed * 0.7), 1, 1)
        }
      }
      // 碎块雨：物理系（直刺/斩击/爆发/漩涡/层叠/字块）——命中点抛出小方块走抛物线落地
      if (hs.shards || hs.blocks) {
        for (var sh = 0; sh < 6; sh++) {
          var st2 = Math.min(1, sinceF / 2 + srand(sh + 20) * 0.3)
          var sx2 = Math.round(ex + (srand(sh + 30) - 0.5) * 22 * st2)
          // 层叠是"塌落"：只往下掉；其余是抛物线外抛
          var sy2 = hs.blocks
            ? Math.round(ey - 12 + st2 * st2 * 18)
            : Math.round(ey - 6 - srand(sh + 40) * 6 + st2 * st2 * 14)
          ctx.fillStyle = sh % 3 === 0 ? CORE : (sh % 3 === 1 ? mc : GOLD)
          ctx.fillRect(sx2, sy2, 1 + (sh % 2), 1 + (sh % 2))
        }
      }
      // 刀光横扫：斩击专属——一整条斜向白光扫过敌人（比"炸一下"更像刀）
      if (hs.arc) {
        var ax2 = Math.round(sinceF * 26)
        var arcCol = sinceF < 1.2 ? CORE : mc
        pline(ex - 16 + ax2, ey - 20, ex - 2 + ax2, ey + 6, arcCol)
        pline(ex - 15 + ax2, ey - 19, ex - 1 + ax2, ey + 7, mixHex(mc, '#000000', 0.35))
      }
      // 多点溅射：骤雨专属——三个落点各自炸开小星
      if (hs.spots) {
        var spotX = [-7, 0, 7]
        for (var sp2 = 0; sp2 < spotX.length; sp2++) {
          var sxp = ex + spotX[sp2]
          var syp = ey - 4 + ((srand(sp2 + 5) - 0.5) * 4)
          var sd = sinceF * 2
          ctx.fillStyle = sp2 === 1 ? CORE : mc
          ctx.fillRect(sxp - Math.round(sd), syp - Math.round(sd), 1, 1)
          ctx.fillRect(sxp + Math.round(sd), syp - Math.round(sd), 1, 1)
          ctx.fillRect(sxp, syp + Math.round(sd), 1, 1)
        }
      }
    }
    // 地面痕迹：按配方决定要不要留（打击系留焦痕，法术/自增益不留）
    if (hit && hs.cracks) {
      ctx.fillStyle = mixHex(mc, '#000000', 0.6)
      ctx.fillRect(ex - 4, groundY + 1, 9, 1)
      ctx.fillRect(ex - 6, groundY + 2, 3, 1)
      ctx.fillRect(ex + 4, groundY + 2, 3, 1)
    }
    // 重击白闪：命中一瞬全场景罩一层暖白（前 1/3 拍）——"这一击很重"的分量感
    if (heavy && hit && since === 0 && (prog || 0) < 0.35) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = 'rgba(255, 246, 216, 0.13)'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.restore()
    }
    // ④ 标签特效（只画"本次实际生效"的）：增益从起手画，指向敌人的命中后才画
    if (f.guard) {
      // 护盾：身前一圈蓝弧 + 弧上两粒白点随相位转（随相位外扩 1 格）
      var gr = 9 + (phase % 2)
      for (var g = -gr; g <= gr; g++) {
        if (Math.abs(g) < gr * 0.5) continue
        var gy2 = Math.round(Math.sqrt(Math.max(0, gr * gr - g * g)) * 0.9)
        ctx.fillStyle = '#7fc8ff'
        ctx.fillRect(cx + g, cy - 14 + gy2 - 5, 1, 2)
      }
      ctx.fillStyle = CORE
      ctx.fillRect(cx - gr + 2, cy - 18, 1, 1)
      ctx.fillRect(cx + gr - 2, cy - 18, 1, 1)
    }
    if (f.surge) {
      // 连击增幅：脚底再叠两圈金点（外圈实线 + 内圈虚线，提亮既有连击光环）
      ctx.fillStyle = GOLD
      for (var sg = -R - 4; sg <= R + 4; sg += 2) ctx.fillRect(cx + sg, cy, 1, 1)
      for (var sg2 = -R - 1; sg2 <= R + 1; sg2 += 4) ctx.fillRect(cx + sg2, cy - 2, 1, 1)
    }
    if (f.aim && phase <= impact) {
      // 精准：敌人头顶准星（画到命中拍为止——它标的就是"将要命中的那只"），四角加折角
      ctx.fillStyle = '#b6ff9e'
      ctx.fillRect(ex - 5, ey - 14, 11, 1)
      ctx.fillRect(ex, ey - 19, 1, 11)
      ctx.fillRect(ex - 6, ey - 15, 1, 1); ctx.fillRect(ex + 6, ey - 15, 1, 1)
      ctx.fillRect(ex - 6, ey - 8, 1, 1); ctx.fillRect(ex + 6, ey - 8, 1, 1)
    }
    if (hit) {
      if (f.crit) {
        // 必暴：敌人身上的大十字星（重档再加一颗 + 两粒斜向星尘）
        star4(ex, ey - 6, CORE)
        star4(ex - 1, ey - 7, GOLD)
        if (heavy) star4(ex + 7, ey + 3, GOLD)
        ctx.fillStyle = CORE
        ctx.fillRect(ex - 6, ey - 2, 1, 1); ctx.fillRect(ex + 5, ey - 12, 1, 1)
      }
      if (f.chase) {
        // 追击：主角与敌人之间的残影虚线（第二击，4 段 + 白热亮段）
        for (var c2 = 0; c2 < 4; c2++) {
          ctx.fillStyle = c2 === 1 ? CORE : '#9fe8ff'
          ctx.fillRect(cx + 15 + c2 * 6, cy - 16 - (phase % 2), 4, 1)
        }
      }
      if (f.pierce) {
        // 贯穿：命中后仍留在敌人身上的双股硬线 + 命中点十字星
        ctx.fillStyle = '#ffb347'
        for (var b = cx + 14; b < ex - 2; b += 2) { ctx.fillRect(b, cy - 12, 1, 1); ctx.fillRect(b, cy - 11, 1, 1) }
        star4(ex, cy - 12, CORE)
      }
      if (f.rend > 0) {
        // 破甲：敌人周围飞散的甲片（6 片，逐帧外飞，横竖交替像碎片翻滚）
        for (var k = 0; k < 6; k++) {
          var ka = k * Math.PI / 3 + 0.5
          var kd = 6 + since * 2
          ctx.fillStyle = k % 2 ? '#ff8a5c' : '#ffb347'
          if (k % 2) ctx.fillRect(Math.round(ex + Math.cos(ka) * kd), Math.round(ey - 4 + Math.sin(ka) * kd * 0.7), 2, 1)
          else ctx.fillRect(Math.round(ex + Math.cos(ka) * kd), Math.round(ey - 4 + Math.sin(ka) * kd * 0.7), 1, 2)
        }
      }
      if (f.leech) {
        // 回复：5 粒绿点从敌人飞回玩家（弧线抬升，尾部带 1 格淡尾）；真回血时玩家身上再补一颗星
        for (var l = 0; l < 5; l++) {
          var t = (((phase - impact) + l * 0.22) % 2) / 2
          var lx = Math.round(ex + (cx - ex) * t)
          var ly = Math.round(ey + (cy - 10 - ey) * t) - Math.round(Math.sin(t * Math.PI) * 5)
          ctx.fillStyle = '#7ee08a'
          ctx.fillRect(lx, ly, 2, 2)
          ctx.fillStyle = mixHex('#7ee08a', '#000000', 0.45)
          ctx.fillRect(lx - 1, ly, 1, 1)
        }
        if (f.heal > 0) { star4(cx, cy - 20, '#b6ff9e'); star4(cx + 4, cy - 23, CORE) }
      }
    }
    // ⑤ 反击帧：怪物回击的火花（4 粒 + 各带 1 格尾）飞向玩家；反震的粉点跟着回弹
    var counterAt = msg.countered ? (msg.frames || 3) - 1 : -1
    if (phase === counterAt) {
      for (var i = 0; i < 4; i++) {
        var t3 = 0.25 + i * 0.22
        var sx = Math.round(ex + (cx - ex) * t3)
        var sy = Math.round(ey + 6 + (cy - 14 - ey) * t3)
        ctx.fillStyle = i % 2 ? '#ff8a5c' : GOLD
        ctx.fillRect(sx, sy, 2, 2)
        ctx.fillStyle = mixHex('#ff8a5c', '#000000', 0.4)
        ctx.fillRect(sx - 1, sy + 1, 1, 1)
      }
      // ⑥ 接收端：火花打在身上那一下——胸口白热一点 + 2 粒暖红碎点被震开（往远离敌人的一侧），
      //    脚下压一圈小弧把"挨了一下"坐实（身位位移/红罩在下方的角色绘制里，这里只画受击件）
      var hitY = cy - 13
      ctx.fillStyle = CORE
      ctx.fillRect(cx + 1, hitY, 2, 2)
      ctx.fillStyle = '#ff8a5c'
      ctx.fillRect(cx + 2, hitY - 1, 1, 1)
      var kick = Math.min(1, prog * 1.6)
      for (var hc = 0; hc < 3; hc++) {
        var hx = cx + 1 - Math.round((2 + hc * 2) * kick)
        var hy = hitY - Math.round((hc % 2 ? 2 : -1) * kick)
        ctx.fillStyle = hc % 2 ? '#ffd9a0' : '#ff7a4a'
        ctx.fillRect(hx, hy, 1, 1)
      }
      var ar = 5 + Math.round(kick * 2)
      ctx.fillStyle = '#ff8a5c'
      for (var ac = -ar; ac <= ar; ac++) {
        if (ac % 2) continue
        ctx.fillRect(cx + ac, cy + 2 - Math.round((ar - Math.abs(ac)) * 0.4), 1, 1)
      }
    }
    if (f.reflect > 0 && phase >= Math.max(impact, counterAt)) {
      // 反震：从敌人回弹到主角的 4 粒粉点（带 1 格尾）
      for (var rf = 0; rf < 4; rf++) {
        var t2 = ((phase - Math.max(impact, counterAt) + rf * 0.28) % 2) / 2
        var rx = Math.round(ex + (cx - ex) * t2)
        var ry = Math.round(ey + 6 - t2 * 12)
        ctx.fillStyle = '#ff9ec4'
        ctx.fillRect(rx, ry, 2, 2)
        ctx.fillStyle = mixHex('#ff9ec4', '#000000', 0.4)
        ctx.fillRect(rx - 1, ry + 1, 1, 1)
      }
    }
  }

  // 招式原语（第五刀·表现）：12 个共享原语，逐本指派（纯表现，不参与任何数值结算）。
  // 画法约定：起手(0)在施法者处蓄力 → 生成(1)招式成形/飞行 → 命中(≥impactAt)在敌人处结算。
  // 颜色 = 标签色（col）+ 白热核心（core）；重档（史诗/传说）命中时外围撒金点。
  function drawForm(form, p, e, phase, impact, groundY, col, heavy, prog) {
    var hit = phase >= impact
    var since = phase - impact
    var sinceF = since + (prog || 0) // 相位内进度折进运动（60fps 细步；一次性元素仍按整拍门控）
    var fp = phase + (prog || 0)
    var core = CORE
    var gold = GOLD
    // 招式主色：主体一律用原语自己的颜色（标签色只留给施放环/标签特效），
    // 否则同标签的不同书看起来就是"同一个技能换了个名字"
    col = FORM_COLOR[form] || col
    var fire = '#ffb347'
    var cx = p.x + 12
    var cy = groundY + 2
    var ex = e ? e.x + 12 : cx + 26
    var ey = e ? e.y + 10 : cy - 14
    if (form === 'bolt') {
      // 单点落雷：云层提示+蓄力亮点 → 双股锯齿主干带分叉与白热内芯 → 命中星 + 金边焦痕 + 跳电火花
      if (!hit) {
        ctx.fillStyle = mixHex(col, '#000000', 0.35)
        ctx.fillRect(ex - 4, ey - 22, 9, 1)
        pdot(ex, ey - 18, col)
        pdot(cx + 14, cy - 22, core)
      } else {
        var zx = ex
        var zxEnd = ex
        for (var y = ey - 18; y <= ey - 4; y++) {
          if (y % 3 === 0) zx += (y % 6 === 0 ? 2 : -2)
          ctx.fillStyle = col
          ctx.fillRect(zx, y, 2, 1)
          if ((y + Math.floor(fp * 3)) % 2 === 0) { ctx.fillStyle = core; ctx.fillRect(zx, y, 1, 1) }
          if (y === ey - 14 || y === ey - 9) {
            // 分叉：从主干向斜下劈 4 格
            var bx3 = zx + 2
            for (var bf = 0; bf < 4; bf++) {
              ctx.fillStyle = bf % 2 ? col : mixHex(col, '#000000', 0.35)
              ctx.fillRect(bx3, y + bf, 1, 1)
              bx3 += bf % 2 ? -1 : 1
            }
          }
          zxEnd = zx
        }
        // 电弧残影：命中 1 拍后主干位置留一道金热余像（闪电"熄灭"前的余光）
        if (since >= 1) {
          ctx.fillStyle = GOLD
          ctx.fillRect(zxEnd + 2, ey - 16, 1, 9)
        }
        star4(ex, ey - 6, core)
        star4(ex - 6, ey - 1, gold)
        ctx.fillStyle = mixHex(col, '#000000', 0.6)
        ctx.fillRect(ex - 3, groundY + 1, 7, 1)
        ctx.fillStyle = gold
        ctx.fillRect(ex - 4, groundY + 1, 1, 1)
        ctx.fillRect(ex + 4, groundY + 1, 1, 1)
        ctx.fillStyle = core
        ctx.fillRect(ex + 6, ey - 12 + (phase % 2) * 2, 1, 1)
        ctx.fillRect(ex - 7, ey - 8 - (phase % 2), 1, 1)
      }
    } else if (form === 'thrust') {
      // 直刺：蓄力亮点+夹持速度线 → 三股刺线（暗/标签色/白芯）贯穿 + 尾端速度线 → 菱形命中尖 + 白星
      if (!hit) {
        pdot(cx + 13, groundY - 12, col)
        ctx.fillStyle = mixHex(col, '#000000', 0.4)
        ctx.fillRect(cx + 9, groundY - 14, 2, 1)
        ctx.fillRect(cx + 9, groundY - 10, 2, 1)
      } else {
        pline(cx + 12, groundY - 13, ex - 2, ey - 5, mixHex(col, '#000000', 0.35))
        pline(cx + 12, groundY - 12, ex - 2, ey - 4, col)
        pline(cx + 12, groundY - 11, ex - 2, ey - 3, core)
        ctx.fillStyle = col
        ctx.fillRect(cx + 14, groundY - 12, 3, 1)
        ctx.fillRect(cx + 19, groundY - 12, 2, 1)
        ctx.fillStyle = core
        ctx.fillRect(ex - 1, ey - 6, 1, 1)
        ctx.fillRect(ex + 1, ey - 6, 1, 1)
        ctx.fillRect(ex, ey - 7, 1, 1)
        ctx.fillRect(ex, ey - 5, 1, 1)
        star4(ex - 1, ey - 4, core)
      }
    } else if (form === 'slash') {
      // 斩击：身前双股斜弧 → 三道月牙弧（暗影线+标签色+白芯）+ 切口白闪 + 甲屑外飞
      if (!hit) {
        pline(cx + 7, cy - 17, cx + 13, cy - 11, col)
        pline(cx + 8, cy - 16, cx + 12, cy - 12, core)
      } else {
        pline(ex - 6, ey - 15, ex + 9, ey - 1, mixHex(col, '#000000', 0.35))
        pline(ex - 9, ey - 13, ex - 2, ey - 9, col)
        pline(ex - 2, ey - 9, ex + 6, ey - 8, col)
        pline(ex - 8, ey - 12, ex - 2, ey - 9, core)
        pline(ex - 2, ey - 9, ex + 5, ey - 9, core)
        pline(ex - 8, ey - 7, ex + 8, ey + 4, mixHex(col, '#000000', 0.35))
        if (since <= 1) {
          ctx.fillStyle = core
          ctx.fillRect(ex - 2, ey - 10, 5, 1)
          ctx.fillRect(ex, ey - 12, 1, 5)
        }
        for (var ch2 = 0; ch2 < 4; ch2++) {
          var ca = ch2 * Math.PI / 2 + 0.7
          ctx.fillStyle = ch2 % 2 ? fire : col
          ctx.fillRect(Math.round(ex + Math.cos(ca) * (6 + Math.max(0, since) * 2)), Math.round(ey - 6 + Math.sin(ca) * (5 + Math.max(0, since) * 2)), 2, 1)
        }
      }
    } else if (form === 'burst') {
      // 爆发：聚能球（环点收缩 + 白热弹芯）→ 弹体带拖尾飞出 → 大爆炸（10 粒三色飞散 + 双环 + 白十字闪 + 焦痕）
      if (!hit) {
        var rr = Math.max(2, 8 - phase * 3)
        for (var b = 0; b < 8; b++) {
          var a2 = b * Math.PI / 4 + 0.4
          ctx.fillStyle = b % 2 ? col : core
          ctx.fillRect(Math.round(cx + 14 + Math.cos(a2) * rr), Math.round(cy - 14 + Math.sin(a2) * rr * 0.7), 1, 1)
        }
        ctx.fillStyle = core
        ctx.fillRect(cx + 13, cy - 15, 2, 2)
      } else {
        var d3 = 4 + sinceF * 3
        for (var b2 = 0; b2 < 10; b2++) {
          var a3 = b2 * Math.PI / 5 + 0.4
          ctx.fillStyle = b2 % 3 === 0 ? core : (b2 % 3 === 1 ? col : gold)
          ctx.fillRect(Math.round(ex + Math.cos(a3) * d3), Math.round(ey - 4 + Math.sin(a3) * d3 * 0.8), 2, 2)
        }
        for (var rdx = -d3; rdx <= d3; rdx++) {
          var rdy = d3 - Math.abs(rdx)
          ctx.fillStyle = col
          ctx.fillRect(ex + rdx, ey - 4 - Math.round(rdy * 0.6), 1, 1)
          if (d3 > 5) { ctx.fillStyle = core; ctx.fillRect(ex + rdx, ey - 4 + Math.round(rdy * 0.6), 1, 1) }
        }
        if (since <= 1) {
          ctx.fillStyle = core
          ctx.fillRect(ex - 1, ey - 9, 2, 9)
          ctx.fillRect(ex - 4, ey - 6, 8, 2)
        }
        ctx.fillStyle = mixHex(col, '#000000', 0.6)
        ctx.fillRect(ex - 3, groundY + 1, 7, 1)
      }
    } else if (form === 'drip') {
      // 液滴：五滴聚顶带尾 → 三滴下落 → 液花王冠（弧+溅点）+ 地面液洼 + 绿星
      if (!hit) {
        for (var d5 = 0; d5 < 5; d5++) {
          var dx5 = ex - 6 + d5 * 3
          var dy5 = ey - 24 + (d5 % 2) * 2 + (phase === 1 ? 2 : 0)
          ctx.fillStyle = d5 === 2 ? core : col
          ctx.fillRect(dx5, dy5, 2, 2)
          ctx.fillStyle = mixHex(col, '#000000', 0.4)
          ctx.fillRect(dx5, dy5 + 2, 1, 2)
        }
      } else {
        for (var d4 = 0; d4 < 3; d4++) {
          var dy4 = (sinceF * 3 + d4 * 2) % 12
          ctx.fillStyle = d4 === 1 ? core : col
          ctx.fillRect(ex - 4 + d4 * 4, ey - 18 + dy4, 2, 2)
        }
        ctx.fillStyle = col
        ctx.fillRect(ex - 5, ey - 3, 11, 1)
        ctx.fillRect(ex - 6, ey - 4, 1, 1)
        ctx.fillRect(ex + 6, ey - 4, 1, 1)
        ctx.fillStyle = core
        ctx.fillRect(ex - 3, ey - 5, 1, 1)
        ctx.fillRect(ex + 4, ey - 5, 1, 1)
        ctx.fillStyle = mixHex(col, '#000000', 0.45)
        ctx.fillRect(ex - 3, groundY + 1, 7, 1)
        star4(ex, ey - 8, '#b6ff9e')
      }
    } else if (form === 'stamp') {
      // 印戳：大印（Z 字 + 印底警示条）带随高度伸缩的投影 → 下压 → 双层印痕 + 两侧抖动线 + 尘土
      var sy5 = phase === 0 ? ey - 24 : hit ? ey - 12 : ey - 18
      var shw = 7 + Math.round((sy5 - (ey - 24)) * 0.3)
      ctx.fillStyle = mixHex(col, '#000000', 0.5)
      ctx.fillRect(ex - Math.round(shw / 2), groundY + 1, shw, 1)
      pbox(ex - 6, sy5, 13, 10, col, false)
      ctx.fillStyle = core
      ctx.fillRect(ex - 3, sy5 + 2, 1, 6)
      ctx.fillRect(ex - 2, sy5 + 2, 4, 1)
      ctx.fillRect(ex + 1, sy5 + 4, 2, 1)
      ctx.fillRect(ex - 2, sy5 + 6, 4, 1)
      ctx.fillStyle = fire
      ctx.fillRect(ex - 4, sy5 + 9, 9, 1)
      if (hit) {
        ctx.fillStyle = col
        ctx.fillRect(ex - 8, ey + 1, 17, 1)
        ctx.fillStyle = mixHex(col, '#000000', 0.4)
        ctx.fillRect(ex - 8, ey + 2, 17, 1)
        ctx.fillRect(ex - 10, ey - 2, 3, 1)
        ctx.fillRect(ex + 8, ey - 2, 3, 1)
        ctx.fillStyle = '#c9b28a'
        ctx.fillRect(ex - 9, ey - 1, 2, 2)
        ctx.fillRect(ex + 8, ey - 1, 2, 2)
        ctx.fillRect(ex - 11, ey + 1, 1, 1)
        ctx.fillRect(ex + 11, ey + 1, 1, 1)
      }
    } else if (form === 'ward') {
      // 法阵：双弧 + 4 粒旋转点 + 内圈虚线 → 中柱 → 命中光柱（白芯双轨）+ 顶星
      var wr = 8 + Math.min(phase, impact)
      for (var w2 = -wr; w2 <= wr; w2++) {
        if (Math.abs(w2) < wr * 0.4) continue
        var wy = Math.round(Math.sqrt(Math.max(0, wr * wr - w2 * w2)) * 0.35)
        pdot(cx + w2, cy - wy, hit ? core : col)
      }
      for (var wp = 0; wp < 4; wp++) {
        var wa = phase * 1.6 + wp * Math.PI / 2
        ctx.fillStyle = wp % 2 ? core : col
        ctx.fillRect(Math.round(cx + Math.cos(wa) * (wr - 3)), Math.round(cy - 2 + Math.sin(wa) * 1.5), 1, 1)
      }
      ctx.fillStyle = mixHex(col, '#000000', 0.4)
      for (var wd = -wr + 2; wd <= wr - 2; wd += 3) ctx.fillRect(cx + wd, cy - 1, 1, 1)
      if (hit) {
        for (var w3 = -6; w3 <= 6; w3++) {
          var wyy = Math.round(Math.sqrt(Math.max(0, 36 - w3 * w3)) * 0.8)
          ctx.fillStyle = w3 % 3 ? col : core
          ctx.fillRect(cx + w3, cy - 6 - Math.round(wyy * 0.5), 1, 2)
        }
        if (since <= 1) {
          ctx.fillStyle = core
          ctx.fillRect(cx - 1, cy - 24, 2, 16)
          ctx.fillStyle = col
          ctx.fillRect(cx - 3, cy - 22, 1, 12)
          ctx.fillRect(cx + 3, cy - 22, 1, 12)
        }
        star4(cx, cy - 26, core)
      }
    } else if (form === 'vortex') {
      // 漩涡：六粒点螺旋拖尾（白芯领头 + 渐暗尾）→ 收束 → 漩涡眼闭合 + 两侧金点崩出
      if (!hit) {
        for (var v = 0; v < 6; v++) {
          var ang = phase * 1.9 - v * 0.5
          var rad = Math.max(1, 16 - phase * 6 - v * 1.5)
          var vs = v > 3 ? 1 : 2
          ctx.fillStyle = v === 0 ? core : (v % 2 ? col : mixHex(col, '#000000', 0.35))
          ctx.fillRect(Math.round(cx + 14 + Math.cos(ang) * rad), Math.round(cy - 12 + Math.sin(ang) * rad * 0.6), vs, vs)
        }
      } else {
        for (var v2 = 0; v2 < 4; v2++) {
          var a4 = sinceF * 1.8 + v2 * Math.PI / 2
          var r4 = Math.max(1, 8 - sinceF * 3)
          ctx.fillStyle = v2 % 2 ? col : core
          ctx.fillRect(Math.round(ex + Math.cos(a4) * r4), Math.round(ey - 6 + Math.sin(a4) * r4), 1, 1)
        }
        star4(ex, ey - 6, core)
        ctx.fillStyle = gold
        ctx.fillRect(ex - 9, ey - 6, 1, 1)
        ctx.fillRect(ex + 9, ey - 6, 1, 1)
      }
    } else if (form === 'stack') {
      // 层叠：三层虚线方块 + 侧边行号点 → 整体压到敌人头顶 → 白横条压扁 + 两侧尘土
      for (var s5 = 0; s5 <= Math.min(phase + 1, 3); s5++) {
        var ly = ey - 21 + s5 * 4 + (hit ? Math.min(4, Math.round(sinceF * 4)) : 0)
        pbox(ex - 7 + (s5 % 2), ly, 14, 5, s5 === 2 ? core : col, true)
        ctx.fillStyle = fire
        ctx.fillRect(ex - 10 + (s5 % 2), ly + 2, 2, 1)
      }
      if (hit) {
        ctx.fillStyle = core
        ctx.fillRect(ex - 5, ey - 4, 11, 1)
        ctx.fillStyle = '#c9b28a'
        ctx.fillRect(ex - 9, ey - 3, 2, 1)
        ctx.fillRect(ex + 8, ey - 3, 2, 1)
      }
    } else if (form === 'chars') {
      // 字块：三块引号弹出（大小错落 + 暗色拖尾）→ 命中处贴大字块（7×7 框 + 双引号）→ 碎裂四粒
      if (!hit) {
        ctx.fillStyle = col
        ctx.fillRect(cx + 13, cy - 21, 5, 5)
        ctx.fillRect(cx + 19, cy - 16, 4, 4)
        ctx.fillRect(cx + 17, cy - 23, 3, 3)
        ctx.fillStyle = core
        ctx.fillRect(cx + 14, cy - 20, 1, 3)
        ctx.fillRect(cx + 20, cy - 15, 1, 2)
        ctx.fillStyle = mixHex(col, '#000000', 0.35)
        ctx.fillRect(cx + 11, cy - 15, 1, 1)
        ctx.fillRect(cx + 18, cy - 11, 1, 1)
      } else {
        pbox(ex - 3, ey - 13, 7, 7, col, false)
        ctx.fillStyle = core
        ctx.fillRect(ex - 1, ey - 11, 1, 3)
        ctx.fillRect(ex + 1, ey - 11, 1, 3)
        if (since >= 1) {
          ctx.fillStyle = col
          ctx.fillRect(ex - 6, ey - 10, 2, 1)
          ctx.fillRect(ex + 5, ey - 9, 2, 1)
          ctx.fillRect(ex - 4, ey - 4, 1, 2)
          ctx.fillRect(ex + 4, ey - 5, 1, 2)
        }
      }
    } else if (form === 'boomerang') {
      // 回旋补丁：弧线三残影（渐暗）+ 旋转感（inner dot 随帧走位）→ 命中拍贴住白闪 → 回程残影
      var back = phase > impact
      var t6 = back ? Math.max(0, 1 - sinceF * 0.5) : 1
      var bx = Math.round(cx + 14 + (ex - cx - 14) * t6)
      var by = Math.round(cy - 18 + (ey - 8 - (cy - 18)) * t6) - (back ? 0 : 3) + (back ? Math.round(Math.sin(t6 * Math.PI) * 2) : 0)
      for (var gh = 1; gh <= 3; gh++) {
        var gt6 = Math.max(0, t6 - gh * 0.12)
        var gx2 = Math.round(cx + 14 + (ex - cx - 14) * gt6)
        var gy2 = Math.round(cy - 18 + (ey - 8 - (cy - 18)) * gt6) - (back ? 0 : 3)
        ctx.fillStyle = mixHex(col, '#000000', 0.25 + gh * 0.15)
        ctx.fillRect(gx2 - 1, gy2 - 1, 3, 3)
      }
      pbox(bx - 2, by - 2, 5, 5, col, false)
      ctx.fillStyle = core
      ctx.fillRect(bx - 1 + (Math.floor(fp * 3) % 3), by - 1 + (Math.floor(fp * 2) % 2), 1, 1)
      if (hit && since <= 1) {
        ctx.fillStyle = core
        ctx.fillRect(bx - 4, by - 1, 1, 3)
        ctx.fillRect(bx + 4, by - 1, 1, 3)
      }
    } else {
      // hail 多点骤雨：乌云块（命中后仍悬着）→ 八条雨丝（白芯相间）→ 三处溅星 + 地面湿痕
      ctx.fillStyle = mixHex(col, '#000000', 0.3)
      ctx.fillRect(ex - 9, ey - 24, 7, 2)
      ctx.fillRect(ex - 1, ey - 25, 8, 2)
      ctx.fillRect(ex - 5, ey - 22, 6, 2)
      if (!hit) {
        ctx.fillStyle = col
        ctx.fillRect(ex - 6, ey - 20, 3, 1)
        ctx.fillRect(ex + 2, ey - 21, 3, 1)
      } else {
        for (var h7 = 0; h7 < 8; h7++) {
          var hy = ey - 18 + (sinceF * 4 + h7 * 3) % 16
          ctx.fillStyle = h7 % 3 === 0 ? core : col
          ctx.fillRect(ex - 9 + Math.round(h7 * 2.4), hy, 1, 3)
        }
        star4(ex - 5, ey - 2, core)
        star4(ex + 5, ey + 2, core)
        star4(ex, ey - 8, col)
        ctx.fillStyle = mixHex(col, '#000000', 0.45)
        ctx.fillRect(ex - 6, groundY + 1, 13, 1)
      }
    }
    // 重档（史诗/传说）：命中拍+1 帧在命中点外围撒 8 粒金点 + 2 粒白热（低概率高倍率 = 重击高光）
    if (heavy && hit) {
      ctx.fillStyle = gold
      for (var gi = 0; gi < 8; gi++) {
        ctx.fillRect(ex - 11 + Math.floor(srand(gi + 3) * 23), ey - 15 + Math.floor(srand(gi + 11) * 17), 1, 1)
      }
      ctx.fillStyle = core
      ctx.fillRect(ex - 12, ey - 2, 1, 1)
      ctx.fillRect(ex + 12, ey - 8, 1, 1)
    }
  }

  // 硬边像素点（2×2 + 1 格深色衬底：浅色草地上也不糊）
  function pdot(x, y, col) {
    ctx.fillStyle = mixHex(col, '#000000', 0.65)
    ctx.fillRect(x + 1, y + 1, 2, 2)
    ctx.fillStyle = col
    ctx.fillRect(x, y, 2, 2)
  }

  // 伤害飘字：上浮按时间推（rAF 每帧重算，140ms 一格、最多 3 格——不再跟 tick 一跳一跳）
  function updateDmg(eslot, S) {
    var el = document.getElementById('dmg')
    if (!el) return
    if (!eslot || dmg.ticks <= 0) {
      el.classList.add('hidden')
      return
    }
    el.classList.remove('hidden')
    el.textContent = '-' + dmg.val
    el.classList.toggle('hot', !!(state && state.streakTier >= 2))
    // 技能出手（第五刀·表现）：飘字按标签色描边（普攻保持原样）；必暴那一击放大加金
    el.classList.toggle('cast', castPhase >= 0)
    el.classList.toggle('crit', !!(castFx && castFx.fx && castFx.fx.crit))
    el.style.setProperty('--dmgc', castCol)
    el.style.left = (eslot.x + 14) * S + 'px'
    el.style.top = (eslot.y + 2 - Math.min(3, Math.floor((Date.now() - dmgAt) / 140))) * S + 'px'
  }

  // 超载演出 DOM（闪白 + COMBO 横幅）：显示 1.6 秒后跳变消失
  var fxTimer = null
  function showFx(combo) {
    var fx = document.getElementById('comboFx')
    var flash = document.getElementById('flash')
    var num = document.getElementById('comboNum')
    if (num && combo) num.textContent = '×' + combo
    if (fx) fx.classList.remove('hidden')
    if (flash) flash.classList.remove('hidden')
    if (fxTimer) clearTimeout(fxTimer)
    fxTimer = setTimeout(function () {
      if (fx) fx.classList.add('hidden')
      if (flash) flash.classList.add('hidden')
    }, 1600)
  }

  // 场景特色装饰：每个 tier 一套，纯程序化，不新增素材
  function drawDeco(T, W, H, groundY) {
    var r = mulberry32(7788)
    var i, n
    if (T.deco === 'blocks') {
      // 数据原野：天上飘着几个像素数据块（暗示"这是代码世界"）
      n = Math.max(3, Math.round(W / 58))
      for (i = 0; i < n; i++) {
        var bx = Math.floor(r() * (W - 5))
        var by = Math.max(2, groundY - 12 - Math.floor(r() * H * 0.22))
        var bs = 3 + Math.floor(r() * 2)
        ctx.fillStyle = mixHex(T.decoInk, '#000000', 0.4)
        ctx.fillRect(bx, by, bs, bs)
        ctx.fillStyle = T.decoInk
        ctx.fillRect(bx + 1, by + 1, bs - 2, bs - 2)
        ctx.fillStyle = T.decoLit
        ctx.fillRect(bx, by, bs, 1)
      }
    } else if (T.deco === 'bubbles') {
      // 缓冲区沼泽：地面水面反光 + 空中上升气泡
      n = Math.max(2, Math.round(W / 70))
      for (i = 0; i < n; i++) {
        var lx = Math.floor(r() * (W - 20))
        ctx.fillStyle = T.decoLit
        ctx.fillRect(lx, groundY + 1 + Math.floor(r() * 4), 8 + Math.floor(r() * 12), 1)
      }
      n = Math.max(3, Math.round(W / 46))
      for (i = 0; i < n; i++) {
        var cx = Math.floor(r() * W)
        var cy = Math.max(2, groundY - 6 - Math.floor(r() * H * 0.2))
        ctx.fillStyle = T.decoInk
        ctx.fillRect(cx, cy, 1, 1)
        ctx.fillStyle = T.decoLit
        ctx.fillRect(cx + 1, cy + 1, 1, 1)
      }
    } else if (T.deco === 'sparks') {
      // 内核熔炉：上升火星 + 地面折线熔岩裂纹
      n = Math.max(5, Math.round(W / 34))
      for (i = 0; i < n; i++) {
        ctx.fillStyle = r() < 0.5 ? T.decoInk : T.decoLit
        ctx.fillRect(Math.floor(r() * W), Math.max(2, groundY - 3 - Math.floor(r() * H * 0.3)), 1, 1)
      }
      n = Math.max(2, Math.round(W / 80))
      for (i = 0; i < n; i++) {
        var kx = Math.floor(r() * (W - 40))
        var ky = groundY + 1 + Math.floor(r() * 3)
        var seg = 8 + Math.floor(r() * 8)
        ctx.fillStyle = T.decoInk
        ctx.fillRect(kx, ky, seg, 1)
        ctx.fillRect(kx + seg, ky + 1, seg, 1)
        ctx.fillStyle = T.decoLit
        ctx.fillRect(kx + 2, ky, 4, 1)
        ctx.fillRect(kx + seg + 3, ky + 1, 4, 1)
      }
    }
  }

  // 头顶 HUD 跟着角色的逻辑坐标走（内容由 pet.js 填）
  function positionHud(slots, S) {
    for (var i = 0; i < slots.length; i++) {
      var el = document.getElementById(slots[i].hud)
      if (!el) continue
      el.style.left = (slots[i].x + 12) * S + 'px'
      el.style.top = (slots[i].y - 3) * S + 'px'
    }
  }

  // 武器格子：尺寸跟着角色同一套逻辑像素档位；图标 canvas 保持 24 格，CSS 用整数倍放大
  function syncWeaponSlot(S) {
    var wrap = document.getElementById('wslotWrap')
    if (!wrap) return
    wrap.style.setProperty('--slot', (S >= 4 ? 62 : 34) + 'px')
    wrap.style.setProperty('--icon', (S >= 4 ? 48 : 24) + 'px')
  }

  // ============================ 悬浮菜单 ============================
  ;(function bindNav() {
    var btn = document.getElementById('navBtn')
    var menu = document.getElementById('navMenu')
    if (!btn || !menu) return
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      menu.classList.toggle('open')
    })
    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target)) menu.classList.remove('open')
    })
    // 菜单项本身的切换交给 pet.js（它管视图），这里只负责收起
    menu.addEventListener('click', function () { menu.classList.remove('open') })
  })()

  // ============================ 数据入口 ============================
  // 菜单里的进度数字：已收集数从 state 拿，总数从全量数据拿（首次可能还空着，收到就补）
  var counts = { wOwned: 0, wTotal: 0, eSeen: 0, eTotal: 0 }

  function syncNavCounts() {
    var w = document.getElementById('navWpn')
    var e = document.getElementById('navEnemy')
    if (w) w.textContent = counts.wOwned + '/' + (counts.wTotal || '?')
    if (e) e.textContent = counts.eSeen + '/' + (counts.eTotal || '?')
  }

  function onMessage(msg) {
    if (!msg) return
    if (msg.type === 'state') {
      state = msg
      if (msg.arsenal) {
        counts.wOwned = msg.arsenal.owned || 0
        counts.wTotal = msg.arsenal.total || counts.wTotal
      }
      if (msg.bestiary) counts.eSeen = msg.bestiary.seen || 0
      syncNavCounts()
      draw()
    } else if (msg.type === 'tick') {
      tick = msg
      // —— 动画时钟埋点：估 tick 间隔、记相位/闪白/飘字/前冲的时间戳（rAF 折算进度用）——
      var nowMs = Date.now()
      if (lastTickAt) tickMsEst = Math.min(1000, Math.max(120, nowMs - lastTickAt))
      lastTickAt = nowMs
      phaseAt = nowMs
      // 帧递减（先减旧的，再按新事件置满）：飘字 3 帧、演出飞散块 5 帧、受击闪白 2 帧
      if (dmg.ticks > 0) dmg.ticks--
      if (burstFrames > 0) burstFrames--
      if (hitFlash > 0) hitFlash--
      // 施放管线：相位由宿主报（-1 = 播完了）
      var ph = typeof msg.castPhase === 'number' ? msg.castPhase : -1
      var impact = castFx && castFx.impactAt != null ? castFx.impactAt : 2
      if (ph >= 0) {
        castPhase = ph
        // 命中帧：弹伤害飘字 + 受击闪白（一次施放只播一次；数值取最近一次 state.lastDmg，0 = 未命中跳过）
        if (!castHit && castFx && ph >= impact) {
          castHit = true
          if (state && state.lastDmg > 0) {
            dmg.val = state.lastDmg
            dmg.ticks = 3
            dmgAt = nowMs
          }
          hitFlash = 1 // 只闪 1 帧：整格提亮太久会把命中特效盖掉（特效画在闪白之上）
          hitFlashAt = nowMs
          // 这一击把它打死了 → 打完飞（碎裂在 draw 里按打飞起点弹一次）
          if (castFx && castFx.killed) killFlyAt = nowMs
        }
        // 追击帧：第二击再闪一下（残影二连击的"第二下"）
        if (castFx && castFx.fx && castFx.fx.chase && ph === impact + 1) {
          hitFlash = Math.max(hitFlash, 1)
          hitFlashAt = nowMs
        }
        // 反击帧：主角挨打（暖红罩 + 下压 1 格；被打退一步在 playerShift 里）
        if (castFx && castFx.countered && ph === (castFx.frames || 3) - 1) playerHitAt = nowMs
      } else if (castPhase >= 0) {
        // 管线播完：击杀的怪从这一拍开始消散（消散完才让位给新怪）
        castPhase = -1
        castFx = null
        if (killHold) killDissolve = 6
      }
      if (killDissolve > 0 && --killDissolve <= 0) {
        killHold = null
        killFlyAt = 0
        killFrags = []
        killFragsSpawned = false
      }
      // 攻击上升沿 → 弹伤害飘字（普攻没有 cast 消息，仍走这条路；带管线的施放交给命中帧）
      if (msg.lunge && !lastLunge) {
        lungeAt = nowMs
        if (state && state.lastDmg > 0 && castPhase < 0) {
          dmg.val = state.lastDmg
          dmg.ticks = 3
          dmgAt = nowMs
        }
      }
      lastLunge = !!msg.lunge
      if (state) draw()
      ensureLoop()
    } else if (msg.type === 'cast') {
      // 技能施放（第五刀·施放管线）：场景招式/标签特效（横幅与 4 槽高亮在 pet.js）
      castFx = msg
      castPhase = 0
      castHit = false
      hitFlash = 0
      killDissolve = 0
      killFlyAt = 0
      killFrags = []
      killFragsSpawned = false
      phaseAt = Date.now() // 相位时钟从收到 cast 这一拍起算
      killHold = msg.killed && msg.killedEnemy
        ? { flat: msg.killedEnemy.sprite || (state && state.enemy), tier: msg.killedEnemy.tier || 'common' }
        : null
      castCol = CAST_COLORS[msg.tag] || '#ffd75e'
      draw()
      ensureLoop()
    } else if (msg.type === 'burst') {
      // 超载演出（≥50 连）：闪白 + 横幅 + 飞散块，1.6 秒后跳变消失
      burstFrames = 5
      showFx(msg.combo)
      draw()
    } else if (msg.type === 'drop') {
      // 技能书掉落：先记着，等击杀演出把怪物打飞、碎开再起飞（见 draw 里的起飞检查）；
      // 武器掉落不飞书（toast 照旧由 pet.js 直接弹）
      if (msg.kind === 'skill') bookPending = { sprite: msg.sprite || null, name: msg.name }
      draw()
      ensureLoop()
    } else if (msg.type === 'arsenalData' && msg.list) {
      counts.wTotal = msg.list.length
      syncNavCounts()
    } else if (msg.type === 'bestiaryData' && msg.list) {
      counts.eTotal = msg.list.length
      syncNavCounts()
    }
  }

  // 本地预览页用 __NIBBLE_MOCK__ 注入首帧状态（与 pet.js 同一份）。
  // 它在脚本顺序上排在 scene.js 之后，所以要等 load 再取一次；真机里没有 mock，
  // 数据全靠宿主 postMessage 推过来，这里自然什么都不做。
  function boot() {
    if (state) return
    var mock = typeof window !== 'undefined' ? window.__NIBBLE_MOCK__ : null
    if (!mock) return
    state = mock
    if (mock.arsenal) {
      counts.wOwned = mock.arsenal.owned || 0
      counts.wTotal = mock.arsenal.total || 0
    }
    if (mock.bestiary) counts.eSeen = mock.bestiary.seen || 0
    var msgs = window.__NIBBLE_MOCK_MSGS__ || []
    msgs.forEach(onMessage)
    syncNavCounts()
    draw()
  }
  if (document.readyState === 'complete') boot()
  else window.addEventListener('load', boot)

  window.addEventListener('message', function (e) { onMessage(e.data || {}) })
  // 调试句柄（对齐 pet.js 的 __nibbleDemo）：自动化核对施放管线用，只读
  window.__nibbleScene = {
    // 本脚本从哪个版本加载的（扩展给资源加了 ?v=<version>）：用来区分"新版没生效"与"特效没画出来"
    get build() {
      var m = /[?&]v=([^&]+)/.exec(SELF_SRC)
      return m ? decodeURIComponent(m[1]) : 'dev'
    },
    get phase() { return castPhase },
    get hasFx() { return !!castFx },
    get hitDone() { return castHit },
    get killHold() { return !!killHold },
    get killDissolve() { return killDissolve },
    // 击杀演出进度（ms）：-1 = 没在打飞；碎块数一并报，核对"打飞→碎裂"用
    get killFly() { return killFlyAt ? Date.now() - killFlyAt : -1 },
    get killFragCount() { return killFrags.length },
    // 主角当前位移（格）：核对"起手后撤 / 命中冲出"这类姿态用，不参与任何逻辑
    get shift() {
      if (castPhase < 0) return 0
      return playerShift(Math.min(0.95, Math.max(0, (Date.now() - phaseAt) / tickMsEst)))
    },
    draw: draw,
    cast: function (m) { onMessage(m) },
  }
  if (window.ResizeObserver) new ResizeObserver(function () { draw() }).observe(stage)
  window.addEventListener('resize', draw)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { draw() })
  draw()
})()
