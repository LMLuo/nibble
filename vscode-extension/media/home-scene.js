'use strict'
// home-scene.js — 小屋的纯逻辑层：等距投影 / 深度排序 / 占用表 / 命中测试 / 拖拽状态机 / 相机
//
// 这一层不碰任何渲染 API。它只产出「这一帧该画哪些精灵、画在哪」的列表，
// 由 home-gl.js（WebGL2）或 home-2d.js（canvas2d 兜底）负责真正画出来。
// 这样做的三个理由：
//   1. WebGL2 拿不到时，兜底后端只要实现同一份接口，不用重写逻辑；
//   2. 拖拽手感可以先用 2D 后端调通，再切 shader；
//   3. 官网复用同一份代码时不需要改任何东西。
//
// 坐标分三层，别混：
//   格坐标 (gx, gy) —— 连续或整数，gx ∈ [0, COLS]，gy ∈ [0, ROWS]
//   世界像素 (wx, wy) —— 已减掉 ORIGIN，房间中心≈原点，可以是负数
//   屏幕像素 —— view 层负责（含 zoom 与相机偏移），本层不参与

;(function (root) {
  var D = root.NibbleHomeData
  if (!D) return

  var HW = D.TILE_W / 2 // 16
  var HH = D.TILE_H / 2 // 8

  // ============================================================
  // 投影
  // ============================================================
  function project(gx, gy, z) {
    return {
      x: (gx - gy) * HW - D.ORIGIN_X,
      y: (gx + gy) * HH - (z || 0) * D.Z_UNIT - D.ORIGIN_Y,
    }
  }

  // 逆变换只在 z = 0 的地板平面上成立（拖动落点、地格拾取都用它）
  function unproject(wx, wy) {
    var px = wx + D.ORIGIN_X
    var py = wy + D.ORIGIN_Y
    return {
      gx: (py / HH + px / HW) / 2,
      gy: (py / HH - px / HW) / 2,
    }
  }

  // 占地区域的南角（屏幕上最低的那个顶点）—— 精灵底边中点对齐到这里
  function footOf(gx, gy, size) {
    return project(gx + size[0], gy + size[1], 0)
  }

  // 精灵包围盒（世界像素，左上角 + 宽高）
  function spriteRect(slotId, gx, gy) {
    var slot = D.PIECE_INDEX[slotId]
    if (!slot) return null
    var sw = slot.sprite[0]
    var sh = slot.sprite[1]
    var foot = footOf(gx, gy, slot.size)
    return { x: foot.x - sw / 2, y: foot.y - sh, w: sw, h: sh }
  }

  // 深度键：用占地区域的前缘（南角），这样 2×2 的床不会盖住站在它背后的角色。
  // 同键再按 gy / gx 升序，保证结果稳定（否则同深度物件会闪）。
  function depthOf(gx, gy, size) {
    return gx + size[0] + (gy + size[1])
  }

  // ============================================================
  // 场景实例
  // ============================================================
  function createScene(options) {
    var opt = options || {}

    var scene = {
      // 当前搭配：槽位 → 物品 id（'wood_bed' / 'star_floor' / …）
      skins: {},
      layout: [],
      occupancy: new Uint8Array(D.COLS * D.ROWS),
      navVersion: 1,
      // 相机：世界像素偏移 + 整数缩放档位
      camera: { panX: 0, panY: 0, zoomIndex: D.ZOOM_STEPS.indexOf(D.ZOOM_DEFAULT) },
      // 拖动状态
      drag: null,
      // 预览放置态：{ key, gx, gy, valid }，确认后才进 layout
      placing: null,
      // 第一版没有人使用：门位与交互点先建好，供以后做角色走动
      door: { gx: D.DOOR.gx, gy: D.DOOR.gy },
    }

    // ---------- 布局 ----------
    // 每条 { key, gx, gy }：key 是套内槽位 id（bed/desk/…）或装饰 id（plant/…）。
    // 两者都「每种最多一件」：套内件是房间的基础配置，装饰件是收藏品，
    // 但装饰件额外受 EXTRA_MAX 总件数限制。
    function pieceOf(key) {
      return D.PIECE_INDEX[key] || null
    }

    function itemOf(key) {
      for (var i = 0; i < scene.layout.length; i++) {
        if (scene.layout[i].key === key) return scene.layout[i]
      }
      return null
    }

    function isExtra(key) {
      var p = pieceOf(key)
      return !!(p && p.kind === 'extra')
    }

    function extraCount() {
      var n = 0
      for (var i = 0; i < scene.layout.length; i++) {
        if (isExtra(scene.layout[i].key)) n++
      }
      return n
    }

    function setLayout(list) {
      var out = []
      var seen = {}
      var extras = 0
      for (var i = 0; i < (list || []).length; i++) {
        var src = list[i]
        if (!src) continue
        // 兼容旧结构：最早存的是 { slot, gx, gy }
        var key = src.key || src.slot || src.id
        var piece = pieceOf(key)
        if (!piece) continue
        if (seen[key]) continue
        var isEx = piece.kind === 'extra'
        if (isEx && extras >= D.EXTRA_MAX) continue
        seen[key] = true
        if (isEx) extras++
        out.push({ key: key, gx: src.gx | 0, gy: src.gy | 0 })
      }
      scene.layout = out
      rebuildOccupancy()
      scene.navVersion++
      return scene.layout
    }

    // 占用表：只记 block 的物件（地毯可踩过，不写）。第一版没人读它，
    // 但必须实时维护 —— 以后接角色走动时，寻路直接吃这张表。
    function rebuildOccupancy() {
      var occ = scene.occupancy
      occ.fill(0)
      for (var i = 0; i < scene.layout.length; i++) {
        var it = scene.layout[i]
        var piece = pieceOf(it.key)
        if (!piece || !piece.block) continue
        var cells = D.cellsOf(it.gx, it.gy, piece.size)
        for (var c = 0; c < cells.length; c++) {
          var x = cells[c][0]
          var y = cells[c][1]
          if (x >= 0 && x < D.COLS && y >= 0 && y < D.ROWS) occ[y * D.COLS + x] = i + 1
        }
      }
    }

    // 能否放在 (gx, gy)：越界 / 与其它 block 物件重叠都算非法。
    // ignoreKey 用于拖动时把自己摘出去（否则永远和自己撞）。
    function canPlace(key, gx, gy, ignoreKey) {
      var piece = pieceOf(key)
      if (!piece) return false
      if (!D.inRoom(gx, gy, piece.size)) return false
      if (!piece.block) return true
      for (var i = 0; i < scene.layout.length; i++) {
        var it = scene.layout[i]
        if (it.key === ignoreKey) continue
        var other = pieceOf(it.key)
        if (!other || !other.block) continue
        var a = D.cellsOf(gx, gy, piece.size)
        var b = D.cellsOf(it.gx, it.gy, other.size)
        for (var p = 0; p < a.length; p++) {
          for (var q = 0; q < b.length; q++) {
            if (a[p][0] === b[q][0] && a[p][1] === b[q][1]) return false
          }
        }
      }
      return true
    }

    function moveItem(key, gx, gy) {
      var it = itemOf(key)
      if (!it) return false
      if (!canPlace(key, gx, gy, key)) return false
      it.gx = gx
      it.gy = gy
      rebuildOccupancy()
      scene.navVersion++
      return true
    }

    // 从里往外扫第一块放得下的位置（放新装饰时用）
    function findFreeSpot(key) {
      var piece = pieceOf(key)
      if (!piece) return null
      for (var gy = 0; gy < D.ROWS; gy++) {
        for (var gx = 0; gx < D.COLS; gx++) {
          if (canPlace(key, gx, gy, null)) return { gx: gx, gy: gy }
        }
      }
      return null
    }

    // 摆一件装饰。已经有 / 超上限 / 没空位都返回 null，调用方据此提示。
    function addPiece(key) {
      var piece = pieceOf(key)
      if (!piece) return null
      if (itemOf(key)) return null
      if (piece.kind === 'extra' && extraCount() >= D.EXTRA_MAX) return null
      var spot = findFreeSpot(key)
      if (!spot) return null
      scene.layout.push({ key: key, gx: spot.gx, gy: spot.gy })
      rebuildOccupancy()
      scene.navVersion++
      return spot
    }

    // ---------- 预览放置 ----------
    // 与拖拽的区别：这件东西还不存在于 layout 里（从仓库拿出来还没落地），
    // 所以单独一条状态，确认后才真正 push 进 layout。
    function startPlacing(key) {
      var piece = pieceOf(key)
      if (!piece) return null
      if (itemOf(key)) return null // 已经摆着了
      if (piece.kind === 'extra' && extraCount() >= D.EXTRA_MAX) return null
      var spot = findFreeSpot(key)
      if (!spot) return null
      scene.placing = { key: key, gx: spot.gx, gy: spot.gy, valid: true }
      return scene.placing
    }

    function movePlacing(gx, gy) {
      var p = scene.placing
      if (!p) return null
      // unproject 给的是浮点格坐标，必须取整 —— 否则 inRoom/占用判定永远失败，
      // 幽灵精灵会一直是红的、怎么点都放不下去。
      var ix = Math.round(gx)
      var iy = Math.round(gy)
      if (ix === p.gx && iy === p.gy) return p // 没换格就不用重算
      p.gx = ix
      p.gy = iy
      p.valid = canPlace(p.key, ix, iy, null)
      return p
    }

    function confirmPlacing() {
      var p = scene.placing
      if (!p || !p.valid) return null
      scene.placing = null
      scene.layout.push({ key: p.key, gx: p.gx, gy: p.gy })
      rebuildOccupancy()
      scene.navVersion++
      return { key: p.key, gx: p.gx, gy: p.gy }
    }

    function cancelPlacing() {
      var had = !!scene.placing
      scene.placing = null
      return had
    }

    // 收一件装饰。套内 6 件是房间的基础配置，不允许移除。
    function removePiece(key) {
      if (!isExtra(key)) return false
      var before = scene.layout.length
      scene.layout = scene.layout.filter(function (x) {
        return x.key !== key
      })
      if (scene.layout.length === before) return false
      rebuildOccupancy()
      scene.navVersion++
      return true
    }

    // ---------- 搭配（逐槽位）----------
    // 每件物品只对得上自己那个槽位，传错槽位直接拒绝（避免把「云榻」塞进椅子位）。
    function setSkin(slot, itemId) {
      var it = D.ITEM_INDEX[itemId]
      if (!it || it.slot !== slot) return false
      scene.skins[slot] = itemId
      return true
    }

    function setSkins(obj) {
      if (!obj || typeof obj !== 'object') return false
      var changed = false
      for (var i = 0; i < D.SKIN_SLOTS.length; i++) {
        var slot = D.SKIN_SLOTS[i].key
        var it = D.ITEM_INDEX[obj[slot]]
        if (it && it.slot === slot && scene.skins[slot] !== obj[slot]) {
          scene.skins[slot] = obj[slot]
          changed = true
        }
      }
      return changed
    }

    // 某槽位当前用哪个系列的素材（渲染取图用；装饰不属于任何系列）
    function seriesOf(slot) {
      var s = D.seriesOfItem(scene.skins[slot])
      return s || 'wood'
    }

    // 交互点：家具前方站稳的位置（格）。第一版没人用，先算出来。
    function interactPointOf(slotId) {
      var it = itemOf(slotId)
      if (!it) return null
      var slot = D.PIECE_INDEX[it.key]
      if (!slot || !slot.interact) return null
      return {
        gx: it.gx + slot.interact[0],
        gy: it.gy + slot.interact[1],
      }
    }

    // ---------- 命中测试 ----------
    // 物件用屏幕 AABB、按深度从近到远找；地板则走逆变换。
    // 占位阶段 AABB 不抠透明像素是够用的（物件才 6 件）。
    function hitTest(wx, wy) {
      var movable = []
      for (var i = 0; i < scene.layout.length; i++) {
        var it = scene.layout[i]
        var slot = D.PIECE_INDEX[it.key]
        if (!slot || slot.kind === 'rug') continue // 地毯可穿透，不抢点击
        var r = spriteRect(it.key, it.gx, it.gy)
        movable.push({ item: it, slot: slot, rect: r, depth: depthOf(it.gx, it.gy, slot.size) })
      }
      movable.sort(function (a, b) {
        return b.depth - a.depth || b.item.gy - a.item.gy || b.item.gx - a.item.gx
      })
      for (var k = 0; k < movable.length; k++) {
        var m = movable[k]
        if (wx >= m.rect.x && wx <= m.rect.x + m.rect.w && wy >= m.rect.y && wy <= m.rect.y + m.rect.h) {
          return { type: 'obj', key: m.item.key, item: m.item }
        }
      }
      var g = unproject(wx, wy)
      if (g.gx >= 0 && g.gx < D.COLS && g.gy >= 0 && g.gy < D.ROWS) {
        return { type: 'floor', gx: Math.floor(g.gx), gy: Math.floor(g.gy) }
      }
      return { type: 'none' }
    }

    // ---------- 拖拽状态机 ----------
    // 抓取时记住「指针相对精灵底边中点」的偏移，移动时反推落点，
    // 这样家具不会在按下瞬间跳到指针中心。
    function startDrag(wx, wy) {
      var hit = hitTest(wx, wy)
      if (hit.type !== 'obj') return null
      var slot = D.PIECE_INDEX[hit.key]
      if (!slot || slot.kind === 'rug') return null
      var foot = footOf(hit.item.gx, hit.item.gy, slot.size)
      scene.drag = {
        key: hit.key,
        from: { gx: hit.item.gx, gy: hit.item.gy },
        to: { gx: hit.item.gx, gy: hit.item.gy },
        grabDX: wx - foot.x,
        grabDY: wy - foot.y,
        valid: true,
        moved: false,
      }
      return scene.drag
    }

    function moveDrag(wx, wy) {
      var d = scene.drag
      if (!d) return null
      var slot = D.PIECE_INDEX[d.key]
      if (!slot) return null
      var g = unproject(wx - d.grabDX, wy - d.grabDY)
      var gx = Math.round(g.gx - slot.size[0])
      var gy = Math.round(g.gy - slot.size[1])
      // 夹在房间里：拖到墙外时贴边，而不是直接判非法（手感上更宽容）
      gx = Math.max(0, Math.min(D.COLS - slot.size[0], gx))
      gy = Math.max(0, Math.min(D.ROWS - slot.size[1], gy))
      if (gx !== d.to.gx || gy !== d.to.gy) d.moved = true
      d.to = { gx: gx, gy: gy }
      d.valid = canPlace(d.key, gx, gy, d.key)
      return d
    }

    function endDrag() {
      var d = scene.drag
      scene.drag = null
      if (!d) return { moved: false }
      if (!d.moved) return { moved: false } // 只是点了一下，不算拖拽
      if (!d.valid) {
        return { moved: true, ok: false, key: d.key, gx: d.from.gx, gy: d.from.gy }
      }
      var it = itemOf(d.key)
      if (it) {
        it.gx = d.to.gx
        it.gy = d.to.gy
        rebuildOccupancy()
        scene.navVersion++
      }
      return { moved: true, ok: true, key: d.key, gx: d.to.gx, gy: d.to.gy }
    }

    function cancelDrag() {
      scene.drag = null
    }

    // ---------- 相机 ----------
    function panBy(dx, dy) {
      scene.camera.panX += dx
      scene.camera.panY += dy
    }

    function zoomStep(dir) {
      var n = scene.camera.zoomIndex + (dir > 0 ? 1 : -1)
      n = Math.max(0, Math.min(D.ZOOM_STEPS.length - 1, n))
      scene.camera.zoomIndex = n
      return D.ZOOM_STEPS[n]
    }

    function zoomLevel() {
      return D.ZOOM_STEPS[scene.camera.zoomIndex]
    }

    // ---------- 绘制列表 ----------
    // 渲染层只需要按数组顺序画：房间底图 → 地毯 → 按深度排的物件 → 挂点 → 拖动中的物件。
    // 每项 { key, rect, depth, alpha, ghost }，key 是图集里找贴图用的 ' setId/slotId '。
    // 一件布局物件对应图集里的哪一格：
    //   装饰跨套装共用（'x/…'），套内件按它当前选的系列取图（'study/bed'）。
    function atlasKey(key) {
      var piece = pieceOf(key)
      if (!piece) return ''
      if (piece.kind === 'extra') return 'x/' + key
      return seriesOf(key) + '/' + key
    }

    function buildDrawList() {
      var out = []

      // 1) 房间底图：地板菱形网格 + 后墙 + 左墙，烘焙在同一张纹理里。
      //    合成一张的理由：墙是平行四边形，拆开画要多一个 draw call 和一套 UV，
      //    而它永远在地板之上、物件之下，没有任何需要单独排序的场景。
      out.push({
        // 房间底图的 key 由 floor|wall 两个系列组成，与 atlas.ensureRoom 共用同一个函数
        key: D.roomKey(seriesOf('floor'), seriesOf('wall')),
        kind: 'room',
        rect: { x: D.ROOM_RECT.x, y: D.ROOM_RECT.y, w: D.ROOM_RECT.w, h: D.ROOM_RECT.h },
        depth: -1e9,
      })

      // 2) 地毯（贴着地，永远在物件之下）
      var rugs = []
      var objs = []
      for (var i = 0; i < scene.layout.length; i++) {
        var it = scene.layout[i]
        var slot = D.PIECE_INDEX[it.key]
        if (!slot) continue
        if (slot.kind === 'rug') rugs.push({ item: it, piece: slot })
        else objs.push({ item: it, piece: slot })
      }
      for (var r = 0; r < rugs.length; r++) {
        out.push({
          key: atlasKey(rugs[r].item.key),
          kind: 'rug',
          rect: spriteRect(rugs[r].item.key, rugs[r].item.gx, rugs[r].item.gy),
          depth: -1e7,
        })
      }

      // 3) 墙面挂点：**展示已取消**（用户反馈武器/怪物挂画不要）。
      //    WALL_MOUNTS 元数据与图集第 6 行的空槽都保留着，恢复时把这段加回来即可。

      // 4) 拖动落点高亮：铺在地板上、物件之下（否则会盖住正在拖的那件家具）
      if (scene.drag) {
        var dslot = D.PIECE_INDEX[scene.drag.key]
        if (dslot) {
          out.push({
            key: scene.drag.valid ? 'hl/ok' : 'hl/bad',
            kind: 'hl',
            rect: areaRect(scene.drag.to.gx, scene.drag.to.gy, dslot.size),
            depth: 1e10,
          })
        }
      }

      // 5) 物件：按前缘深度升序
      objs.sort(function (a, b) {
        return (
          depthOf(a.item.gx, a.item.gy, a.piece.size) - depthOf(b.item.gx, b.item.gy, b.piece.size) ||
          a.item.gy - b.item.gy ||
          a.item.gx - b.item.gx
        )
      })
      var dragKey = scene.drag ? scene.drag.key : null
      for (var o = 0; o < objs.length; o++) {
        var oit = objs[o].item
        var gx = oit.gx
        var gy = oit.gy
        // 拖动中的物件跟着指针走
        if (dragKey === oit.key && scene.drag) {
          gx = scene.drag.to.gx
          gy = scene.drag.to.gy
        }
        var isDragging = dragKey === oit.key
        var rect = spriteRect(oit.key, gx, gy)
        var d = isDragging ? 1e9 : depthOf(gx, gy, objs[o].piece.size)
        // 落影：跟着家具一起参与深度排序（比自身略小，只铺在占地内），
        // 没有它家具会像贴纸一样浮在地板上。
        var area = areaRect(gx, gy, objs[o].piece.size)
        out.push({
          key: 'fx/shadow',
          kind: 'shadow',
          rect: {
            x: area.x + area.w * 0.07,
            y: area.y + area.h * 0.1,
            w: area.w * 0.86,
            h: area.h * 0.8,
          },
          depth: d - 0.5,
        })
        out.push({
          key: atlasKey(oit.key),
          kind: 'obj',
          slot: oit.key,
          rect: rect,
          // 拖动中放到最后画（depth 取最大），否则会被别的家具盖住看不清
          depth: d,
          alpha: isDragging && !scene.drag.valid ? 0.45 : 1,
          ghost: isDragging,
        })
      }

      // 6) 预览放置：落点菱形高亮 + 半透明幽灵精灵
      if (scene.placing) {
        var pc = scene.placing
        var pPiece = pieceOf(pc.key)
        if (pPiece) {
          out.push({
            key: pc.valid ? 'hl/ok' : 'hl/bad',
            kind: 'hl',
            rect: areaRect(pc.gx, pc.gy, pPiece.size),
            depth: 1e10,
          })
          out.push({
            key: atlasKey(pc.key),
            kind: 'obj',
            slot: pc.key,
            rect: spriteRect(pc.key, pc.gx, pc.gy),
            depth: 1e9 + 1,
            alpha: pc.valid ? 0.72 : 0.4,
            ghost: true,
          })
        }
      }

      return out
    }

    // 占地区域的地板菱形包围盒。2:1 恒比，所以拉伸高亮贴图不会变形。
    function areaRect(gx, gy, size) {
      var p00 = project(gx, gy, 0)
      var p10 = project(gx + size[0], gy, 0)
      var p01 = project(gx, gy + size[1], 0)
      var p11 = project(gx + size[0], gy + size[1], 0)
      var left = Math.min(p00.x, p10.x, p01.x, p11.x)
      var right = Math.max(p00.x, p10.x, p01.x, p11.x)
      var top = Math.min(p00.y, p10.y, p01.y, p11.y)
      var bottom = Math.max(p00.y, p10.y, p01.y, p11.y)
      return { x: left, y: top, w: right - left, h: bottom - top }
    }

    // 墙面挂点：along 沿墙铺开，z 是离地高度（格），project 已经折算进 z
    function mountRect(mount) {
      var w = 24
      var h = 24
      var p =
        mount.wall === 'back'
          ? project(D.COLS * mount.along, 0, mount.z)
          : project(0, D.ROWS * mount.along, mount.z)
      return { x: p.x - w / 2, y: p.y - h / 2, w: w, h: h }
    }

    // ---------- 初始化 ----------
    // 搭配是逐槽位的，每个槽位都必须先有一个合法物品，否则渲染取不到图
    for (var ii = 0; ii < D.SKIN_SLOTS.length; ii++) {
      var kk = D.SKIN_SLOTS[ii].key
      var want = opt.skins && opt.skins[kk]
      var wit = want ? D.ITEM_INDEX[want] : null
      scene.skins[kk] = wit && wit.slot === kk ? want : D.DEFAULT_SKINS[kk]
    }

    setLayout(opt.layout || D.DEFAULT_LAYOUT)

    // 暴露内部工具（view 层调）
    scene.project = project
    scene.unproject = unproject
    scene.spriteRect = spriteRect
    scene.depthOf = depthOf
    scene.footOf = footOf
    scene.hitTest = hitTest
    scene.canPlace = canPlace
    scene.moveItem = moveItem
    scene.setLayout = setLayout
    scene.setSkin = setSkin
    scene.setSkins = setSkins
    scene.seriesOf = seriesOf
    scene.addPiece = addPiece
    scene.removePiece = removePiece
    // 世界像素 → 格坐标（view 层做预览放置时要用）
    scene.gridAt = function (wx, wy) {
      return unproject(wx, wy)
    }
    scene.startPlacing = startPlacing
    scene.movePlacing = movePlacing
    scene.confirmPlacing = confirmPlacing
    scene.cancelPlacing = cancelPlacing
    scene.extraCount = extraCount
    scene.isExtra = isExtra
    scene.pieceOf = pieceOf
    scene.findFreeSpot = findFreeSpot
    scene.itemOf = itemOf
    scene.interactPointOf = interactPointOf
    scene.startDrag = startDrag
    scene.moveDrag = moveDrag
    scene.endDrag = endDrag
    scene.cancelDrag = cancelDrag
    scene.panBy = panBy
    scene.zoomStep = zoomStep
    scene.zoomLevel = zoomLevel
    scene.buildDrawList = buildDrawList
    scene.mountRect = mountRect

    return scene
  }

  var API = {
    createScene: createScene,
    project: project,
    unproject: unproject,
    spriteRect: spriteRect,
    depthOf: depthOf,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHomeScene = API
})(typeof window !== 'undefined' ? window : globalThis)
