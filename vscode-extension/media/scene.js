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

  // 宿主发来的网格是「24×24 扁平的 hex 颜色数组」，空位是 ''
  function drawFlat(flat, x0, y0, hidden) {
    if (!flat || hidden) return
    var n = GRID
    for (var i = 0; i < flat.length; i++) {
      var c = flat[i]
      if (!c) continue
      ctx.fillStyle = c
      ctx.fillRect(x0 + (i % n), y0 + ((i / n) | 0), 1, 1)
    }
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

  function draw() {
    var rect = stage.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) return
    if (!state) return

    var T = THEMES[state.enemyTier] || THEMES.common
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
    var defs = [{ key: 'player', u: 0.26, flat: state.player, hud: 'hudPlayer' },
                { key: 'enemy', u: 0.68, flat: state.enemy, hud: 'hudEnemy' }]
    for (var d = 0; d < defs.length; d++) {
      if (!defs[d].flat) continue
      var px = Math.max(1, Math.min(W - GRID - 1, Math.round(W * defs[d].u) - 12))
      slots.push({ key: defs[d].key, hud: defs[d].hud, x: px, y: groundY - 22, flat: defs[d].flat })
    }

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

    for (var a = 0; a < slots.length; a++) {
      var isP = slots[a].key === 'player'
      // 攻击前冲（宿主 tick.lunge）/ 待机隔帧下沉 1 格 / 击败隔帧消散
      var ox = isP && tick.lunge ? 2 : 0
      var oy = isP ? (tick.lunge || !tick.frame ? 0 : 1) : 0
      drawFlat(slots[a].flat, slots[a].x + ox, slots[a].y + oy, !isP && tick.dissolve && tick.frame % 2 === 0)
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

  // 伤害飘字：3 帧阶梯上浮（每帧跳 1 格、跳变显隐，不做平滑过渡）
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
    el.style.left = (eslot.x + 14) * S + 'px'
    el.style.top = (eslot.y + 2 - (3 - dmg.ticks)) * S + 'px'
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
      // 帧递减（先减旧的，再按新事件置满）：飘字 3 帧、演出飞散块 5 帧
      if (dmg.ticks > 0) dmg.ticks--
      if (burstFrames > 0) burstFrames--
      // 攻击上升沿 → 弹伤害飘字（数值取最近一次 state.lastDmg；0 = 未命中，跳过）
      if (msg.lunge && !lastLunge && state && state.lastDmg > 0) {
        dmg.val = state.lastDmg
        dmg.ticks = 3
      }
      lastLunge = !!msg.lunge
      if (state) draw()
    } else if (msg.type === 'burst') {
      // 超载演出（≥50 连）：闪白 + 横幅 + 飞散块，1.6 秒后跳变消失
      burstFrames = 5
      showFx(msg.combo)
      draw()
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
  if (window.ResizeObserver) new ResizeObserver(function () { draw() }).observe(stage)
  window.addEventListener('resize', draw)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { draw() })
  draw()
})()
