'use strict'
// home-actor.js — 小屋里的角色（小狗）行为与动画
//
// 只做三件事：
//   1) 状态机：发呆 / 走路 / 玩耍 / 休息 / 搞怪 / 睡觉 / 醒来；
//   2) 寻路：在 home-scene 的占用表上做 BFS，绕开家具走到随机目标格；
//   3) 出绘制项：把「这一帧该画哪张角色帧、画在哪、多深」交给 view 层。
// 它不碰任何渲染 API，也不读写存档 —— 那边的状态由 view 层通过 setAway / wake 推进来。
//
// 坐标口径与 home-scene 一致：位置是**格坐标**（浮点），一格的角色站位在
// (x+1, y+1) 的南角（和 1×1 家具的锚点相同），所以深度排序可以直接共用 depthOf。
//
// 帧来自 actor-frames.js（tools/actor-frames.mjs 生成），全部是 24×24 整像素帧：
//   stand / breathe / walk1~4 / sit / rest / sleep / happy / goofy / goofy2

;(function (root) {
  var D = root.NibbleHomeData
  if (!D) return

  var SPRITE = 24
  var WALK_SPEED = 2.1 // 格/秒：从房间一头走到另一头约 5 秒，比"瞬移感"慢一点
  var WALK_FPS = 8

  // 简单可复现的伪随机（mulberry32）：同一次打开面板，动作序列稳定，不会每次重绘都换动作
  function makeRng(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function createActor(scene) {
    var COLS = D.COLS
    var ROWS = D.ROWS
    var rnd = makeRng((Date.now() ^ 0x5bd1e995) >>> 0)

    var state = 'idle'
    var until = 0 // 当前状态的结束时刻（ms）；0 = 由逻辑决定
    var stateT = 0 // 当前状态已持续多久（秒）
    var pos = { x: D.DOOR.gx, y: D.DOOR.gy } // 浮点格：脚底所在的格
    var path = []
    var movePhase = 0
    var bobT = 0
    var away = false // 72 小时没活动 → 睡觉
    var waking = 0 // >0 表示正在播"醒来"演出（秒）
    var dust = 0 // 0..1：灰尘浓度，醒来时淡出
    var effects = [] // { kind, x, y, t, life, vx, vy }
    var frame = 'stand'
    // 落灰时漂浮的灰尘：固定位置 + 相位，浓度由 view 层按 lastSeen 决定
    var MOTES = [
      { gx: 1.2, gy: 2.4, a: 0.5, ph: 0.1 },
      { gx: 3.6, gy: 5.1, a: 0.4, ph: 0.6 },
      { gx: 5.2, gy: 1.7, a: 0.55, ph: 0.3 },
      { gx: 7.4, gy: 3.2, a: 0.35, ph: 0.8 },
      { gx: 2.3, gy: 6.6, a: 0.45, ph: 0.45 },
      { gx: 6.1, gy: 5.8, a: 0.4, ph: 0.15 },
      { gx: 8.2, gy: 1.4, a: 0.3, ph: 0.7 },
      { gx: 4.4, gy: 3.9, a: 0.5, ph: 0.9 },
    ]
    var lastSleepZ = 0
    var lastHeart = 0
    var blinkT = 0 // 距离下一次眨眼的累计秒数
    var blinkAt = 0 // 眨眼结束时刻（这之前画闭眼帧）
    var seed = rnd() * 1e9
    // 道具与表演层（0.7.0）：小球 / 走路扬尘 / 搞怪星星 / 击杀庆祝。
    // 全部是"角色之外"的像素，角色帧一个都没动。
    var ball = null // { x, y, t }：玩耍时脚边弹跳的小球
    var afterWalk = null // 走到目的地之后要切的状态（rest / sleep）
    var lastWalkDust = 0
    var lastStar = 0
    var lastCelebrate = 0

    // 门位可能被家具占了（玩家可以往门口摆东西）→ 退到最近的空格
    if (!free(pos.x, pos.y)) {
      var alt = nearestFree(pos.x, pos.y)
      if (alt) pos = { x: alt.x, y: alt.y }
    }

    function free(x, y) {
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return false
      return !scene.occupancy[y * COLS + x]
    }

    function nearestFree(x, y) {
      for (var r = 1; r < Math.max(COLS, ROWS); r++) {
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
            if (free(x + dx, y + dy)) return { x: x + dx, y: y + dy }
          }
        }
      }
      return null
    }

    // BFS：命中障碍就绕，找不到路返回 null（不会卡死在原地）
    function findPath(from, to) {
      if (!free(to.x, to.y)) return null
      var key = function (x, y) {
        return y * COLS + x
      }
      var prev = new Int16Array(COLS * ROWS).fill(-1)
      var seen = new Uint8Array(COLS * ROWS)
      var queue = [key(from.x, from.y)]
      seen[key(from.x, from.y)] = 1
      var goal = key(to.x, to.y)
      var dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
      for (var qi = 0; qi < queue.length; qi++) {
        var cur = queue[qi]
        if (cur === goal) break
        var cx = cur % COLS
        var cy = (cur - cx) / COLS
        for (var d = 0; d < 4; d++) {
          var nx = cx + dirs[d][0]
          var ny = cy + dirs[d][1]
          if (!free(nx, ny)) continue
          var nk = key(nx, ny)
          if (seen[nk]) continue
          seen[nk] = 1
          prev[nk] = cur
          queue.push(nk)
        }
      }
      if (!seen[goal]) return null
      var out = []
      var step = goal
      while (step !== key(from.x, from.y)) {
        out.push({ x: step % COLS, y: (step - (step % COLS)) / COLS })
        step = prev[step]
        if (step < 0) return null
      }
      out.reverse()
      return out
    }

    function randomCell() {
      for (var i = 0; i < 40; i++) {
        var x = Math.floor(rnd() * COLS)
        var y = Math.floor(rnd() * ROWS)
        if (free(x, y)) return { x: x, y: y }
      }
      return null
    }

    // 想待的地方：优先家具的交互点（床前/桌前），否则随机
    function pickTarget(slotId) {
      if (slotId) {
        var p = scene.interactPointOf(slotId)
        if (p) {
          var ix = Math.round(p.gx)
          var iy = Math.round(p.gy)
          if (free(ix, iy)) return { x: ix, y: iy }
          var near = nearestFree(ix, iy)
          if (near) return near
        }
      }
      return randomCell()
    }

    function addEffect(kind, x, y, life, vx, vy) {
      effects.push({ kind: kind, x: x, y: y, t: 0, life: life, vx: vx || 0, vy: vy || 0 })
      if (effects.length > 24) effects.shift()
    }

    function setState(next, now) {
      state = next
      stateT = 0
      // 停留时长（0.7.0 调过一轮）：发呆不能太长、玩耍要够看、休息要真的躺一会儿
      if (next === 'idle') until = now + 2600 + rnd() * 2600 // 2.6~5.2s
      else if (next === 'walk') until = 0
      else if (next === 'play') {
        until = now + 3200 + rnd() * 1800 // 3.2~5s
        spawnBall()
      } else if (next === 'goofy') until = now + 2600 + rnd() * 1400 // 2.6~4s
      else if (next === 'rest') until = now + 9000 + rnd() * 5000 // 9~14s
      else if (next === 'sleep') until = 0
      else if (next === 'wake') until = now + 1500
      if (next !== 'play') ball = null
    }

    // 小球（纯表现，不占格、不能捡）：
    // 曾经按"世界格"放球，结果狗在门口/家具旁时球会落进植物或墙里看不见；
    // 改成**贴着脚边的屏幕偏移**，跟着狗走，任何位置都看得见。
    function spawnBall() {
      ball = { t: rnd() * 0.6, side: rnd() < 0.5 ? -1 : 1 }
    }

    function startWalk(now, slotId) {
      var target = pickTarget(slotId)
      if (!target) {
        setState('idle', now)
        return
      }
      var p = findPath({ x: Math.round(pos.x), y: Math.round(pos.y) }, target)
      if (!p || !p.length) {
        setState('idle', now)
        return
      }
      path = p
      setState('walk', now)
    }

    function decide(now) {
      var r = rnd()
      // 权重（0.7.0）：休息占比最高（狗大多数时间在趴着）；玩耍次之；瞎逛最少
      if (r < 0.3) startWalk(now, null)
      else if (r < 0.42) startWalk(now, 'bed')
      else if (r < 0.52) startWalk(now, 'desk')
      else if (r < 0.62) setState('play', now)
      else if (r < 0.8) restAtBed(now)
      else if (r < 0.86) setState('goofy', now)
      else setState('yawn', now) // 8%：发呆着就打了个哈欠
    }

    // 休息 = 先走到床边（一次寻路），到了再趴下；已经在床边就直接趴
    function restAtBed(now) {
      var p = scene.interactPointOf('bed')
      var near = p ? Math.hypot(pos.x - Math.round(p.gx), pos.y - Math.round(p.gy)) < 1.2 : false
      if (near) {
        setState('rest', now)
        return
      }
      startWalkThen(now, 'bed', 'rest')
    }

    function startWalkThen(now, slotId, then) {
      var target = pickTarget(slotId)
      if (!target) {
        setState('idle', now)
        return
      }
      var p = findPath({ x: Math.round(pos.x), y: Math.round(pos.y) }, target)
      if (!p || !p.length) {
        setState('idle', now)
        return
      }
      path = p
      afterWalk = then
      setState('walk', now)
    }

    // ---------- 对外：状态推进 ----------
    // 72 小时没活动：趴下睡觉（灰尘浓度由 view 层按 lastSeen 算好传进来）
    function setAway(on, dustLevel) {
      away = !!on
      if (typeof dustLevel === 'number') dust = Math.max(0, Math.min(1, dustLevel))
      if (away) {
        path = []
        waking = 0
        // 睡在床边（而不是门口）：主人不在时它守着床 —— 也让演出有个像样的构图
        var spot = pickTarget('bed') || { x: Math.round(pos.x), y: Math.round(pos.y) }
        pos = { x: spot.x, y: spot.y }
        setState('sleep', Date.now())
      }
    }

    // 宿主判定"这次回来触发了打扫" → 播 1.5 秒的醒来演出，灰尘随之淡出
    function wake() {
      if (waking > 0) return
      away = false
      waking = 1.45 // 睡 → 趴 → 打哈欠（半/大） → 站好
      path = []
      state = 'wake'
      stateT = 0
      until = Date.now() + 1450
      addEffect('spark', pos.x + 0.5, pos.y, 0.9, 0, -0.6)
    }

    function poke() {
      // 点一下小狗：开心一下 + 冒颗心（不改变任何数值）
      var now = Date.now()
      if (away) return
      if (now - lastHeart < 700) return
      lastHeart = now
      if (state !== 'play' && state !== 'wake') {
        setState('play', now)
      }
      addEffect('heart', pos.x + 0.55, pos.y - 0.15, 1.2, 0.12, -0.7)
    }

    // 击杀庆祝：宿主在"这一击打死了怪"时调一次。4 秒玩耍 + 一颗心，30 秒内只触发一次；
    // 睡着/刚醒来时不打断（那两段演出优先级更高）。
    function celebrate() {
      var now = Date.now()
      if (away || state === 'sleep' || state === 'wake') return false
      if (now - lastCelebrate < 30000) return false
      lastCelebrate = now
      path = []
      afterWalk = null
      setState('play', now)
      until = now + 4000
      addEffect('heart', pos.x + 0.55, pos.y - 0.2, 1.2, 0.1, -0.7)
      return true
    }

    function hitTest(wx, wy) {
      var foot = scene.project(pos.x + 1, pos.y + 1, 0)
      var r = { x: Math.round(foot.x) - 12, y: Math.round(foot.y) - SPRITE, w: SPRITE, h: SPRITE }
      return wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h
    }

    // ---------- 每帧推进 ----------
    function tick(dt) {
      var now = Date.now()
      stateT += dt
      dust = Math.max(0, dust - dt * (waking > 0 ? 0.8 : 0))

      if (waking > 0) {
        waking -= dt
        if (waking <= 0) {
          waking = 0
          setState('idle', now)
        }
      }

      // 睡觉：冒 Z
      if (state === 'sleep') {
        if (now - lastSleepZ > 1700) {
          lastSleepZ = now
          addEffect('zzz', pos.x + 0.75, pos.y - 0.35, 2.4, 0.18, -0.45)
        }
      } else if (!away && state === 'idle' && now >= until) {
        decide(now)
      } else if (state === 'walk') {
        moveAlong(dt)
      } else if ((state === 'play' || state === 'goofy' || state === 'wake') && now >= until) {
        setState('idle', now)
      } else if (state === 'rest' && now >= until) {
        setState('idle', now)
      } else if (state === 'yawn' && now >= until) {
        setState('idle', now)
      }

      // 玩耍时偶尔冒心
      if ((state === 'play' || state === 'goofy') && now - lastHeart > 900) {
        lastHeart = now
        addEffect('heart', pos.x + 0.5, pos.y - 0.2, 1.1, 0, -0.6)
      }

      // 发呆时每 4~7 秒眨一下眼（130ms 的闭眼帧，够短才像眨眼）
      blinkT += dt
      if (blinkT > 4 + (seed % 3)) {
        blinkT = 0
        if (state === 'idle') blinkAt = now + 130
      }

      // 小球：原地弹跳（纯表现；不参与拾球/碰撞）
      if (state === 'play' && ball) {
        ball.t += dt
        if (ball.t > 6) ball.t = 0
      }

      // 走路扬尘：每 0.22 秒在脚下撒一小撮（不走近路时不出）
      if (state === 'walk' && path.length && now - lastWalkDust > 220) {
        lastWalkDust = now
        addEffect('puff', pos.x + 0.55, pos.y + 0.55, 0.5, 0, 0.1)
      }

      // 搞怪时头顶冒星
      if (state === 'goofy' && now - lastStar > 420) {
        lastStar = now
        addEffect('star', pos.x + 0.35 + rnd() * 0.7, pos.y - 0.1 - rnd() * 0.4, 0.75, 0, -0.25)
      }

      // 特效推进
      for (var i = effects.length - 1; i >= 0; i--) {
        var e = effects[i]
        e.t += dt
        e.x += e.vx * dt
        e.y += e.vy * dt
        if (e.t >= e.life) effects.splice(i, 1)
      }

      frame = pickFrame(now)
    }

    function moveAlong(dt) {
      if (!path.length) {
        arrive()
        return
      }
      var next = path[0]
      var dx = next.x - pos.x
      var dy = next.y - pos.y
      var dist = Math.hypot(dx, dy)
      var step = WALK_SPEED * dt
      if (dist <= step || dist < 1e-4) {
        pos.x = next.x
        pos.y = next.y
        path.shift()
        if (!path.length) arrive()
      } else {
        pos.x += (dx / dist) * step
        pos.y += (dy / dist) * step
      }
      movePhase += dt * WALK_FPS
    }

    // 到达终点：如果这趟是"去床边趴下"，就接着趴；否则发呆
    function arrive() {
      var now = Date.now()
      var then = afterWalk
      afterWalk = null
      setState(then || 'idle', now)
    }

    function pickFrame(now) {
      var walking = state === 'walk' && path.length > 0
      if (walking) {
        var f = Math.floor(movePhase) % 4
        return ['walk1', 'walk2', 'walk3', 'walk4'][f]
      }
      if (state === 'sleep') return 'sleep'
      if (state === 'rest') return 'rest'
      if (state === 'goofy') return Math.floor(stateT * 7) % 2 ? 'goofy2' : 'goofy'
      if (state === 'play') return stateT < 0.35 || (stateT > 0.6 && stateT < 0.85) ? 'happy' : 'stand'
      if (state === 'wake') {
        if (stateT < 0.3) return 'sleep'
        if (stateT < 0.6) return 'rest'
        if (stateT < 0.82) return 'yawn1'
        if (stateT < 1.15) return 'yawn2'
        return 'stand'
      }
      // 打哈欠：先半张，再大张（眯眼已是帧属性）
      if (state === 'yawn') return stateT < 0.42 ? 'yawn1' : 'yawn2'
      // 发呆：呼吸两帧交替（1.1s 一次，慢到像在喘气而不是抖）；偶尔眨一下
      if (now < blinkAt) return 'happy'
      return Math.floor(now / 1100) % 2 ? 'breathe' : 'stand'
    }

    // ---------- 绘制项 ----------
    // 跳起来的高度：玩耍时按正弦起跳，rest/sleep 落地
    function hopOf() {
      if (state === 'play') {
        var p = (stateT % 0.55) / 0.55
        return Math.round(Math.sin(p * Math.PI) * 3)
      }
      if (state === 'wake') return 0
      return 0
    }

    function entries() {
      var out = []
      var foot = scene.project(pos.x + 1, pos.y + 1, 0)
      var fxp = Math.round(foot.x)
      var fyp = Math.round(foot.y)
      var depth = pos.x + pos.y + 2
      var hop = hopOf()
      var sleeping = state === 'sleep'
      // 落影：活着的时候跟着；睡着时更扁（贴身）
      out.push({
        key: 'fx/shadow',
        kind: 'shadow',
        rect: { x: fxp - 15, y: fyp - (sleeping ? 4 : 7), w: 30, h: sleeping ? 8 : 14 },
        depth: depth + 0.005,
        alpha: state === 'play' ? 0.55 : 0.8,
      })
      out.push({
        key: 'actor/' + frame,
        kind: 'actor',
        rect: { x: fxp - 12, y: fyp - SPRITE - hop, w: SPRITE, h: SPRITE },
        depth: depth + 0.01,
        alpha: 1,
      })
      // 灰尘：只在落灰/刚醒来时出现，慢慢上浮 + 淡出（浓度由 dust 控制）
      if (dust > 0.02) {
        var tick = Date.now() / 1000
        for (var m = 0; m < MOTES.length; m++) {
          var mo = MOTES[m]
          var rise = ((tick * 0.06 + mo.ph) % 1) * 0.9
          var mp = scene.project(mo.gx, mo.gy, 0.35 + rise)
          out.push({
            key: 'fx/dust',
            kind: 'fx',
            rect: { x: Math.round(mp.x) - 2, y: Math.round(mp.y) - 2, w: 4, h: 3 },
            depth: 1e8 + 0.5 + m * 0.001,
            alpha: dust * mo.a * (1 - rise * 0.6),
          })
        }
      }
      // 小球：贴脚边左右轻微摆动 + 上下弹跳（屏幕偏移，保证任何位置都看得见）
      if (state === 'play' && ball) {
        var bounce = Math.abs(Math.sin(ball.t * 5.4)) * 9
        var sway = Math.sin(ball.t * 2.2) * 3
        out.push({
          key: 'fx/ball',
          kind: 'fx',
          rect: {
            x: fxp + 10 + sway * ball.side,
            y: fyp - 9 - bounce,
            w: 9,
            h: 9,
          },
          depth: depth + 0.02,
          alpha: 1,
        })
      }
      // 特效：浮在房间最上层（拖拽高亮 1e10 之下）
      for (var i = 0; i < effects.length; i++) {
        var e = effects[i]
        var p = scene.project(e.x, e.y, 0)
        var k = e.t / e.life
        var alpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45)
        if (e.kind === 'star') {
          out.push({
            key: 'fx/star',
            kind: 'fx',
            rect: { x: Math.round(p.x), y: Math.round(p.y) - 26 - k * 8, w: 5, h: 5 },
            depth: 1e8 + i * 0.001,
            alpha: Math.max(0, alpha),
          })
        } else if (e.kind === 'puff') {
          out.push({
            key: 'fx/dust',
            kind: 'fx',
            rect: { x: Math.round(p.x), y: Math.round(p.y) - 2 - k * 3, w: 4, h: 3 },
            depth: 1e8 + i * 0.001,
            alpha: Math.max(0, 0.7 * (1 - k)),
          })
        } else if (e.kind === 'zzz') {
          out.push({
            key: 'fx/zzz',
            kind: 'fx',
            rect: { x: Math.round(p.x), y: Math.round(p.y) - 30 - k * 10, w: 7, h: 8 },
            depth: 1e8 + i * 0.001,
            alpha: Math.max(0, alpha),
          })
        } else if (e.kind === 'heart') {
          out.push({
            key: 'fx/heart',
            kind: 'fx',
            rect: { x: Math.round(p.x), y: Math.round(p.y) - 20 - k * 12, w: 7, h: 6 },
            depth: 1e8 + i * 0.001,
            alpha: Math.max(0, alpha),
          })
        } else if (e.kind === 'spark') {
          out.push({
            key: 'fx/dust',
            kind: 'fx',
            rect: { x: Math.round(p.x), y: Math.round(p.y) - 10 - k * 14, w: 4, h: 3 },
            depth: 1e8 + i * 0.001,
            alpha: Math.max(0, 1 - k),
          })
        }
      }
      return out
    }

    // 家具挪到狗身上了 / 换布局了：把狗挪到最近的空格，别让它卡在家具里
    function validate() {
      var cx = Math.round(pos.x)
      var cy = Math.round(pos.y)
      if (free(cx, cy)) return false
      var alt = nearestFree(cx, cy)
      if (alt) {
        pos = { x: alt.x, y: alt.y }
        path = []
        setState('idle', Date.now())
      }
      return true
    }

    return {
      tick: tick,
      entries: entries,
      setAway: setAway,
      wake: wake,
      poke: poke,
      celebrate: celebrate,
      validate: validate,
      hitTest: hitTest,
      get state() {
        return state
      },
      get dust() {
        return dust
      },
      // 调试/自检用：脚底所在的格坐标（浮点）
      get pos() {
        return { x: pos.x, y: pos.y }
      },
      get prop() {
        return ball ? { x: ball.x, y: ball.y, t: ball.t } : null
      },
      set dust(v) {
        dust = Math.max(0, Math.min(1, Number(v) || 0))
      },
      resetPosition: function () {
        var alt = nearestFree(D.DOOR.gx, D.DOOR.gy)
        if (alt) pos = { x: alt.x, y: alt.y }
        path = []
      },
    }
  }

  var API = { create: createActor }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHomeActor = API
})(typeof window !== 'undefined' ? window : globalThis)
