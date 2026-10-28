'use strict'
// home-view.js — 小屋的视图装配层
//
// 职责边界很窄：找节点、量尺寸、把指针事件翻译成世界坐标、调 scene / backend。
// 投影、排序、命中、拖拽的数学全在 home-scene.js；像素怎么上屏全在后端。
//
// 三条硬规矩：
//   1. 只在视图激活时干活 —— 切走要 unmount，否则 rAF 会和宿主的 tick() 抢主线程；
//   2. 按需重绘（dirty + rAF 一次），不做常驻空转；
//   3. 所有 DOM 查找都要判空 —— pet.js 被官网复用，那边没有小屋节点。

;(function (root) {
  var D = root.NibbleHomeData
  if (!D) return

  var instance = null
  // 宿主的提交回调（pet.js 在 hasHost 时注入；官网/样张页没有 → commit 是空操作）
  var commitHook = null
  // "醒来演出已播完"的回写（同 commitHook 的注入方式；没有宿主时是空操作）
  var wakeSeenHook = null
  // 小屋还没打开过时收到的存档，先存着，等 mount 再应用（避免平白建一次图集）
  var pendingHome = null
  // 同上：小屋没建过时收到的情绪状态（lastSeen / wake）
  var pendingMood = null
  // 玩家收藏（pet.js 推过来）：{ weapons: {list, sprites, owned}, enemies: {list, sprites, defeated} }
  // 放在模块级而不是实例内：小屋没打开时数据也会到，先接着。
  var assetStore = { weapons: null, enemies: null }

  function createHome(rootEl) {
    var canvas = rootEl.querySelector('#homeCanvas')
    if (!canvas) return null

    var scene = root.NibbleHomeScene.createScene({})
    var atlas = root.NibbleHomeAtlas.build()
    // 屋里的小狗：行为/动画在 home-actor.js，这里只负责推进与合流绘制列表
    var actor = root.NibbleHomeActor ? root.NibbleHomeActor.create(scene) : null

    // 优先 WebGL2；拿不到就落到 canvas2d，功能一点不少。
    // 加 ?force2d=1 可强制走兜底路径（调样式、验降级时用）
    var force2d = /[?&]force2d=1/.test(String(root.location && root.location.search))
    var backend = force2d ? null : root.NibbleHomeGL.create(canvas, atlas)
    if (!backend) backend = root.NibbleHome2D.create(canvas, atlas)
    if (!backend) return null

    var active = false
    var rafId = 0
    var cw = 1
    var ch = 1
    var dpr = 1
    var homeSynced = false
    var assets = assetStore
    var mountPicks = [null, null, null, null, null]
    // 已拥有的物品（后端 owned）。物品级：某件「苔石·椅子」拥有，不代表拥有整套苔石。
    var ownedItems = {}
    for (var oi in D.DEFAULT_OWNED) {
      if (Object.prototype.hasOwnProperty.call(D.DEFAULT_OWNED, oi)) ownedItems[oi] = true
    }

    // 房间底图是按「地板系列|墙纸系列」按需生成的，换搭配时要同步给后端上传纹理
    function syncRoom() {
      var f = D.seriesOfItem(scene.skins.floor) || 'wood'
      var w = D.seriesOfItem(scene.skins.wall) || 'wood'
      var key = atlas.ensureRoom(f, w)
      if (backend.setRoom) backend.setRoom(key, atlas.rooms[key])
      return key
    }

    // 指针状态：拖动家具 / 平移视角，两种互斥
    var mode = null // 'drag' | 'pan'
    var panStart = null

    var els = {
      sets: rootEl.querySelector('#homeSets'),
      mounts: rootEl.querySelector('#homeMounts'),
      zoomLabel: rootEl.querySelector('#homeZoomLabel'),
      backend: rootEl.querySelector('#homeBackend'),
    }

    // ---------- 尺寸 ----------
    // 舞台背景：把程序化夜空铺到 .homeStage 上（只做一次，dataURL 转换有点贵）
    var backdropDone = false
    function paintStageBackdrop() {
      if (backdropDone) return
      var stage = rootEl.querySelector('#homeStage')
      if (!stage || !atlas.backdrop) return
      try {
        var url = atlas.backdrop.toDataURL('image/png')
        stage.style.background = '#120d0b url("' + url + '") center / cover no-repeat'
        backdropDone = true
      } catch (err) {
        /* 拿不到 dataURL 就保留 CSS 渐变兜底 */
      }
    }

    function measure() {
      var r = canvas.getBoundingClientRect()
      cw = Math.max(1, Math.round(r.width))
      ch = Math.max(1, Math.round(r.height))
      dpr = Math.min(3, Math.max(1, root.devicePixelRatio || 1))
      backend.resize(cw, ch, dpr)
      invalidate()
    }

    function autoFit() {
      // 选一个让整块房间底图刚好放得下的最大整数档。
      // 房间底图 288×224 逻辑像素，宽高都要照顾到（否则窄而高的窗口会切掉地面）。
      //
      // 仓库抽屉打开时要给右侧让出宽度：可用区变窄 → 重新选缩放档，
      // 并把房间中心左移半个抽屉宽，保证「一边看一边摆」时房间仍然完整可见。
      // 只让出抽屉本身的宽度（含左右各 2px 边框）。多留 16px 会让 2x 掉到 1x，
      // 房间凭空小一半 —— 这点余量比缩放档位不值钱。
      var reserved = depotOpen ? D.DEPOT_W + 4 : 0
      var availW = Math.max(160, cw - reserved)
      var fit = Math.min(availW / D.WORLD_W, ch / D.WORLD_H)
      var idx = 0
      for (var i = 0; i < D.ZOOM_STEPS.length; i++) {
        if (D.ZOOM_STEPS[i] <= fit) idx = i
      }
      scene.camera.zoomIndex = idx
      var zoom = D.ZOOM_STEPS[idx]
      scene.camera.panX = -reserved / 2
      // 房间的视觉重心不在世界原点：地板中心 y=0，墙顶约 y=-115，取 -18 折中。
      // draw 里 screen = world*zoom + 画布中心 + pan，所以要让 world=-18 落在正中 → pan = 18*zoom
      scene.camera.panY = 18 * zoom
      syncZoomLabel()
    }

    // ---------- 坐标换算 ----------
    // 屏幕 CSS 坐标 → 世界像素（跟后端 draw 里的变换互逆）
    function toWorld(clientX, clientY) {
      var r = canvas.getBoundingClientRect()
      var zoom = scene.zoomLevel()
      return {
        x: (clientX - r.left - cw / 2 - scene.camera.panX) / zoom,
        y: (clientY - r.top - ch / 2 - scene.camera.panY) / zoom,
      }
    }

    // 灯光位置：从灯的锚点算，房间没灯就放在中上方
    function lightScreen() {
      var lamp = scene.itemOf('lamp')
      var zoom = scene.zoomLevel()
      var lx
      var ly
      if (lamp) {
        var slot = D.SLOT_INDEX.lamp
        var rect = scene.spriteRect('lamp', lamp.gx, lamp.gy)
        lx = rect.x + slot.light[0] * rect.w
        ly = rect.y + slot.light[1] * rect.h
      } else {
        lx = 0
        ly = -20
      }
      return {
        x: (lx * zoom + cw / 2 + scene.camera.panX) / cw,
        y: (ly * zoom + ch / 2 + scene.camera.panY) / ch,
      }
    }

    // ---------- 绘制 ----------
    // 角色/特效插进家具的深度序列。
    // 只看 obj / shadow：地毯是地板层（depth -1e7），预览幽灵是覆盖层（1e9+），都不是深度序。
    // ⚠️ 曾经把 rug 也算进来，结果小狗被插到地毯后面、整只藏进床底下（踩过一次）。
    function insertSprite(list, entry) {
      var after = -1 // 最后一个比它浅的家具条目
      var first = -1 // 第一件家具（比所有家具都浅时插在它前面）
      for (var i = 0; i < list.length; i++) {
        var it = list[i]
        if (it.kind !== 'obj' && it.kind !== 'shadow') continue
        if (it.depth > 1e8) break // 幽灵/预览开始，后面都是覆盖层
        if (first < 0) first = i
        if (it.depth > entry.depth) {
          list.splice(i, 0, entry)
          return
        }
        after = i
      }
      if (after >= 0) list.splice(after + 1, 0, entry)
      else if (first >= 0) list.splice(first, 0, entry)
      else list.push(entry)
    }

    function draw() {
      if (!active) return
      var cam = scene.camera
      var light = lightScreen()
      // 光照色跟随地板系列（房间的主色调）
      var set = D.SET_INDEX[D.seriesOfItem(scene.skins.floor)] || D.SETS[0]
      var list = scene.buildDrawList()
      if (actor) {
        var extra = actor.entries()
        for (var i = 0; i < extra.length; i++) insertSprite(list, extra[i])
      }
      backend.draw(list, {
        zoom: scene.zoomLevel(),
        panX: cam.panX,
        panY: cam.panY,
        lightX: light.x,
        lightY: light.y,
        lightColor: hexToRgb(set.palette.glow),
      })
    }

    // 角色在动，所以 mount 期间需要常驻逐帧循环（只在视图可见时跑，切走立即停）。
    // invalidate 保留原语义：第一次调度会顺手把循环拉起来，重复调用是空操作。
    var lastTs = 0
    var lastPaint = 0
    function loop(ts) {
      if (!active) {
        rafId = 0
        return
      }
      rafId = root.requestAnimationFrame(loop)
      var dt = lastTs ? Math.min(0.06, (ts - lastTs) / 1000) : 1 / 60
      lastTs = ts
      if (actor) actor.tick(dt)
      // 30fps 足够（像素动画本来就是 7~8fps），底部面板里没必要 60fps 常驻烧 CPU
      if (ts - lastPaint >= 32) {
        lastPaint = ts
        draw()
      }
    }

    function invalidate() {
      if (!active || rafId) return
      rafId = root.requestAnimationFrame(loop)
    }

    function hexToRgb(hex) {
      var h = String(hex || '#FFC98A').replace('#', '')
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      var n = parseInt(h, 16) || 0
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }

    // ---------- 面板 ----------
    // 左栏 = 当前搭配的 8 个槽位摘要（逐件挑的结果），点任一行进仓库换那一件。
    function renderSets() {
      if (!els.sets) return
      els.sets.innerHTML = ''

      var head = document.createElement('div')
      head.className = 'homeSideHead'
      head.textContent = '当前搭配'
      els.sets.appendChild(head)

      for (var i = 0; i < D.SKIN_SLOTS.length; i++) {
        var slot = D.SKIN_SLOTS[i].key
        var it = D.ITEM_INDEX[scene.skins[slot]]
        var row = document.createElement('button')
        row.className = 'homeSkinRow'
        row.dataset.slot = slot
        row.style.borderLeftColor = it ? D.RARITY_COLOR[it.rarity] : 'var(--line)'
        row.title = it ? it.name + '（点击更换）' : '未配置'

        var lbl = document.createElement('span')
        lbl.className = 'homeSkinSlot'
        lbl.textContent = D.SLOT_NAME[slot]

        var nm = document.createElement('span')
        nm.className = 'homeSkinName'
        nm.style.color = it ? D.RARITY_COLOR[it.rarity] : 'var(--dim)'
        // 物品名形如「暖木·床铺」，左栏只留前面那段系列名
        nm.textContent = it ? it.name.split('·')[0] : '—'

        row.appendChild(lbl)
        row.appendChild(nm)
        els.sets.appendChild(row)
      }

      // 装饰计数做成真按钮：它长得像入口，玩家一定会点它，
      // 纯文字点不动会被当成坏了。点了直接开仓库的装饰页。
      var cnt = document.createElement('button')
      cnt.className = 'homeWardCount homeWardCountBtn'
      cnt.textContent = '装饰 ' + scene.extraCount() + '/' + D.EXTRA_MAX
      cnt.title = '打开仓库 · 装饰页'
      cnt.onclick = function () {
        openDepot('extra')
      }
      els.sets.appendChild(cnt)
    }

    // ---------- 槽位就地快换 ----------
    // 换单件不该走「打开抽屉 → 滚到那一组 → 点选 → 关抽屉」，
    // 直接在这行旁边弹出 5 个缩略图，点一下即换。大改（看全部/一键整套）才开抽屉。
    var quickPick = null

    function closeQuickPick() {
      if (quickPick) {
        quickPick.remove()
        quickPick = null
      }
    }

    function showQuickPick(slot, anchor) {
      closeQuickPick()
      var box = document.createElement('div')
      box.className = 'homeQuickPick'

      for (var i = 0; i < D.SETS.length; i++) {
        var series = D.SETS[i]
        var itemId = series.id + '_' + slot
        var it = D.ITEM_INDEX[itemId]
        var own = !!ownedItems[itemId]
        var cur = scene.skins[slot] === itemId
        var btn = document.createElement('button')
        btn.className = 'homeQuickOpt' + (cur ? ' on' : '') + (own ? '' : ' locked')
        btn.dataset.quickItem = itemId
        btn.style.borderColor = cur ? D.RARITY_COLOR[it.rarity] : ''
        btn.title = it.name + '（' + D.RARITY_LABEL[it.rarity] + '）' + (own ? '' : '　尚未拥有')
        btn.appendChild(makeThumb(series.id, slot))
        var nm = document.createElement('span')
        nm.textContent = series.name
        btn.appendChild(nm)
        box.appendChild(btn)
      }

      box.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-quick-item]') : null
        if (!b) return
        var id = b.dataset.quickItem
        if (!ownedItems[id]) return
        if (scene.skins[slot] === id) {
          closeQuickPick()
          return
        }
        pushHistory()
        if (scene.setSkin(slot, id)) {
          syncRoom()
          renderSets()
          invalidate()
          commit()
        }
        closeQuickPick()
      })

      rootEl.appendChild(box)
      // 贴在锚点行右侧；超出容器则回退到左侧
      var r = anchor.getBoundingClientRect()
      var pr = rootEl.getBoundingClientRect()
      var left = r.right - pr.left + 6
      if (left + box.offsetWidth > pr.width - 4) left = Math.max(4, r.left - pr.left - box.offsetWidth - 6)
      box.style.left = Math.round(left) + 'px'
      box.style.top = Math.round(Math.max(4, Math.min(r.top - pr.top - 6, pr.height - box.offsetHeight - 4))) + 'px'
      quickPick = box
    }

    function onSkinRowClick(e) {
      var row = e.target.closest ? e.target.closest('.homeSkinRow') : null
      if (!row) return
      showQuickPick(row.dataset.slot, row)
    }

    // 点浮层和水屋以外的地方 → 关掉
    function onDocPointerDown(e) {
      if (!quickPick) return
      if (quickPick.contains(e.target)) return
      closeQuickPick()
    }

    function renderMounts() {
      if (!els.mounts) return
      els.mounts.innerHTML = ''
      var head = document.createElement('div')
      head.className = 'homeMountHead'
      head.textContent = '墙面陈列'
      els.mounts.appendChild(head)

      for (var i = 0; i < D.WALL_MOUNTS.length; i++) {
        var m = D.WALL_MOUNTS[i]
        var pick = mountPicks[i]
        var cell = document.createElement('div')
        cell.className = 'homeMountCell' + (pick ? '' : ' empty')
        cell.dataset.mount = m.id
        var tag = document.createElement('span')
        tag.className = 'homeMountTag'
        tag.textContent = m.kind === 'weapon' ? '武器' : '挂画'
        var val = document.createElement('span')
        val.className = 'homeMountVal'
        if (pick) {
          val.textContent = pick.name
          val.style.color = pick.color || ''
          cell.style.borderColor = pick.color || ''
          cell.title = pick.name + '（' + D.RARITY_LABEL[pick.rarityKey] + '）'
        } else {
          val.textContent = '空'
          cell.title = m.label + '：还没有可陈列的东西'
        }
        cell.appendChild(tag)
        cell.appendChild(val)
        els.mounts.appendChild(cell)
      }
    }

    // ---------- 墙面陈列 ----------
    // **展示已取消**（用户反馈不要武器/怪物挂画）。数据链（setAssets）与选择逻辑
    // 都保留着，恢复时删掉下面的 early return 即可。
    // 陈列规则：3 个武器位放战力最高的 3 把已拥有武器，2 个挂画位放层级最高、击败次数最多的 2 只怪。
    function computeMounts() {
      return
      var picks = [null, null, null, null, null]

      var w = assets.weapons
      if (w && w.sprites && w.byId) {
        var wIndex = {}
        for (var i = 0; i < (w.list || []).length; i++) wIndex[w.list[i].id] = w.list[i]
        var owned = Object.keys(w.byId).filter(function (id) {
          return w.sprites[id] && wIndex[id]
        })
        owned.sort(function (a, b) {
          return (wIndex[b].power || 0) - (wIndex[a].power || 0) || (w.byId[b] || 0) - (w.byId[a] || 0)
        })
        for (var k = 0; k < Math.min(3, owned.length); k++) {
          var wid = owned[k]
          picks[k] = {
            id: wid,
            name: wIndex[wid].name,
            rarityKey: wIndex[wid].rarity,
            color: D.RARITY_COLOR[wIndex[wid].rarity] || D.RARITY_COLOR.common,
            sprite: w.sprites[wid],
          }
        }
      }

      var e = assets.enemies
      if (e && e.sprites && e.byId) {
        var eIndex = {}
        for (var j = 0; j < (e.list || []).length; j++) eIndex[e.list[j].id] = e.list[j]
        var tierRank = { common: 0, elite: 1, boss: 2 }
        var beat = Object.keys(e.byId).filter(function (id) {
          return e.sprites[id] && eIndex[id] && e.byId[id] > 0
        })
        beat.sort(function (a, b) {
          var ta = tierRank[eIndex[a].tier] || 0
          var tb = tierRank[eIndex[b].tier] || 0
          return tb - ta || (e.byId[b] || 0) - (e.byId[a] || 0)
        })
        for (var n = 0; n < Math.min(2, beat.length); n++) {
          var eid = beat[n]
          var tier = eIndex[eid].tier || 'common'
          picks[3 + n] = {
            id: eid,
            name: eIndex[eid].name,
            rarityKey: tier === 'boss' ? 'legendary' : tier === 'elite' ? 'epic' : 'common',
            color: tier === 'boss' ? '#FFD700' : tier === 'elite' ? '#E040E0' : '#FFB86B',
            sprite: e.sprites[eid],
          }
        }
      }

      mountPicks = picks
      for (var m = 0; m < D.WALL_MOUNTS.length; m++) {
        var p = picks[m]
        atlas.paintMountSlot(m, p ? p.sprite : null, p ? p.color : null)
      }
      if (backend.reuploadAtlas) backend.reuploadAtlas(atlas.atlas)
      renderMounts()
      invalidate()
    }

    function syncZoomLabel() {
      if (els.zoomLabel) els.zoomLabel.textContent = scene.zoomLevel() + 'x'
    }

    // ---------- 指针 ----------
    // 指针捕获可能失败（合成事件、指针已被释放），失败不该中断拖拽
    function capture(id) {
      try {
        canvas.setPointerCapture(id)
      } catch (err) {
        /* 没有这个指针就算了 */
      }
    }

    function onPointerDown(e) {
      if (!active) return
      closeQuickPick()
      var w = toWorld(e.clientX, e.clientY)

      // 预览放置态：左键落地（放得下才算数），右键取消
      if (scene.placing) {
        if (e.button === 2) {
          scene.cancelPlacing()
          if (depot && !depot.classList.contains('hidden')) renderDepot()
          syncPlacingTip()
          invalidate()
          return
        }
        var g = scene.gridAt(w.x, w.y)
        var pp = scene.movePlacing(g.gx, g.gy)
        if (pp && pp.valid) {
          pushHistory()
          scene.confirmPlacing()
          if (actor) actor.validate()
          renderSets()
          if (depot && !depot.classList.contains('hidden')) renderDepot()
          syncPlacingTip()
          invalidate()
          commit()
        }
        return
      }
      var forcePan = e.shiftKey || e.button === 2 || e.button === 1

      if (!forcePan) {
        // 先判小狗：点它 = 逗一下（角色才 24×24，不会挡着抓家具）
        if (actor && actor.hitTest(w.x, w.y)) {
          actor.poke()
          invalidate()
          return
        }
        var d = scene.startDrag(w.x, w.y)
        if (d) {
          mode = 'drag'
          capture(e.pointerId)
          canvas.style.cursor = 'grabbing'
          invalidate()
          return
        }
      }
      mode = 'pan'
      panStart = { x: e.clientX, y: e.clientY }
      capture(e.pointerId)
      canvas.style.cursor = 'move'
    }

    function onPointerMove(e) {
      if (!active) return
      // 预览放置态没有 mode（还没按下），所以必须挡在 mode 判断之前
      if (scene.placing) {
        var gw = toWorld(e.clientX, e.clientY)
        var gp = scene.gridAt(gw.x, gw.y)
        scene.movePlacing(gp.gx, gp.gy)
        syncPlacingTip()
        invalidate()
        canvas.style.cursor = 'crosshair'
        return
      }
      if (!mode) {
        canvas.style.cursor = e.shiftKey ? 'move' : 'default'
        return
      }
      var w = toWorld(e.clientX, e.clientY)
      if (mode === 'drag') {
        scene.moveDrag(w.x, w.y)
      } else if (mode === 'pan' && panStart) {
        scene.camera.panX += e.clientX - panStart.x
        scene.camera.panY += e.clientY - panStart.y
        panStart = { x: e.clientX, y: e.clientY }
      }
      invalidate()
    }

    function onPointerUp(e) {
      if (!active) return
      if (mode === 'drag') {
        // 先留快照，挪成功了才进历史（失败就不该占一格撤销）
        var before = snapshot()
        var done = scene.endDrag()
        syncZoomLabel()
        // 只有真的动了且放得下才写盘；点一下、拖到非法位置都不产生 IO
        if (done && done.moved && done.ok) {
          history.push(before)
          if (history.length > MAX_HISTORY) history.shift()
          if (actor) actor.validate() // 家具压到狗身上时把它挪开
          commit()
        }
      }
      mode = null
      panStart = null
      canvas.style.cursor = 'default'
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* 指针已经没了 */
      }
      invalidate()
    }

    function onWheel(e) {
      if (!active) return
      e.preventDefault()
      scene.zoomStep(e.deltaY > 0 ? -1 : 1)
      syncZoomLabel()
      invalidate()
    }

    function onResize() {
      if (!active) return
      measure()
    }

    function onZoomIn() {
      scene.zoomStep(1)
      syncZoomLabel()
      invalidate()
    }

    function onZoomOut() {
      scene.zoomStep(-1)
      syncZoomLabel()
      invalidate()
    }

    function onReset() {
      scene.setLayout(D.DEFAULT_LAYOUT)
      invalidate()
      commit()
    }

    // ---------- 存档 ----------
    // 只在「松手 / 换套装 / 重排」这三处提交一条，拖动过程中一个字节都不写盘 ——
    // 宿主的 saveSave 是同步 writeFileSync，跟着 pointermove 写会把编辑器卡住。
    function snapshot() {
      return {
        // skins 必须拷贝：它是 scene 上的活动对象，直接引用会让历史记录跟着一起变
        skins: Object.assign({}, scene.skins),
        layout: scene.layout.map(function (it) {
          return { key: it.key, gx: it.gx, gy: it.gy }
        }),
      }
    }

    // ---------- 撤销 ----------
    // 装扮时最常见的操作失误就是「换错了想退回」，没有撤销就得手动点回去。
    var history = []
    var MAX_HISTORY = 12

    function pushHistory() {
      history.push(snapshot())
      if (history.length > MAX_HISTORY) history.shift()
    }

    function undo() {
      var prev = history.pop()
      if (!prev) return false
      scene.setSkins(prev.skins)
      scene.setLayout(prev.layout)
      syncRoom()
      renderSets()
      if (depot && !depot.classList.contains('hidden')) renderDepot()
      invalidate()
      commit()
      return true
    }

    // ---------- 键盘 ----------
    // Ctrl/Cmd+Z 撤销；Esc 依次取消「预览放置」「关闭抽屉」。
    // 只在视图激活时接管，避免影响编辑器本身的快捷键。
    function onKeyDown(e) {
      if (!active) return
      var k = e.key
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
        if (undo()) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      if (k === 'Escape') {
        if (scene.placing) {
          scene.cancelPlacing()
          syncPlacingTip()
          invalidate()
          e.preventDefault()
        } else if (depotOpen) {
          closeDepot()
          e.preventDefault()
        }
      }
    }

    // ---------- 仓库 ----------
    // 家具先「拥有」再「展示」：仓库同时承担收藏查看与当前展示配置。
    // 两个 tab 就够 —— 装潢（5 套整屋风格）和装饰（20 件单件家具）。
    var depot = null
    var depotTab = 'skin'
    var depotFocus = ''
    // 抽屉是否展开：影响 autoFit 让出多少宽度
    var depotOpen = false

    function ensureDepot() {
      if (depot) return depot
      depot = document.createElement('div')
      depot.className = 'homeDepot hidden'
      depot.addEventListener('click', onDepotClick)
      rootEl.appendChild(depot)
      return depot
    }

    function openDepot(tab, focusSlot) {
      depotTab = tab || 'skin'
      depotFocus = focusSlot || ''
      depotOpen = true
      rootEl.classList.add('depot-open')
      var d = ensureDepot()
      d.classList.remove('hidden')
      renderDepot()
      // 让房间给抽屉让位：重新选缩放档 + 左移，玩家能一边看一边换
      autoFit()
      syncZoomLabel()
      invalidate()
    }

    // 物品缩略图：材质槽位用配色块，家具从图集里裁一格
    function makeThumb(seriesId, slot) {
      var cv = document.createElement('canvas')
      var set = D.SET_INDEX[seriesId]
      if (slot === 'floor' || slot === 'wall') {
        cv.width = 28
        cv.height = 20
        var c2 = cv.getContext('2d')
        c2.fillStyle = slot === 'floor' ? set.palette.floor : set.palette.wall
        c2.fillRect(0, 0, 28, 20)
        c2.fillStyle = slot === 'floor' ? set.palette.trim : set.palette.wallAlt
        c2.fillRect(0, 15, 28, 2)
        cv.style.width = '28px'
        cv.style.height = '20px'
        return cv
      }
      var def = D.SLOT_INDEX[slot]
      var w = def ? def.sprite[0] : 38
      var h = def ? def.sprite[1] : 42
      cv.width = w
      cv.height = h
      var c3 = cv.getContext('2d')
      c3.imageSmoothingEnabled = false
      var rect = atlas.cells[seriesId + '/' + slot]
      if (rect) c3.drawImage(atlas.atlas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
      var k = Math.min(1, 44 / h, 40 / w)
      cv.style.width = Math.round(w * k) + 'px'
      cv.style.height = Math.round(h * k) + 'px'
      return cv
    }

    function closeDepot() {
      depotOpen = false
      rootEl.classList.remove('depot-open')
      if (depot) depot.classList.add('hidden')
      // 关掉后房间回到居中
      autoFit()
      syncZoomLabel()
      invalidate()
    }

    // 抽屉顶部那行提示的临时替换（1.8 秒后自动还原）
    var hintTimer = 0
    function flashDepotHint(text) {
      if (!depot) return
      var hint = depot.querySelector('.homeDepotHint')
      if (!hint) return
      hint.textContent = text
      hint.classList.add('warn')
      clearTimeout(hintTimer)
      hintTimer = setTimeout(function () {
        hint.classList.remove('warn')
        renderDepot()
      }, 1800)
    }

    // 舞台上的放置提示条：让玩家知道「已经拿起了，接下来该点屋里」
    var placingTip = null
    function syncPlacingTip() {
      if (!scene.placing) {
        if (placingTip) placingTip.classList.add('hidden')
        return
      }
      if (!placingTip) {
        placingTip = document.createElement('div')
        placingTip.className = 'homePlacingTip hidden'
        var stage = rootEl.querySelector('#homeStage')
        if (stage) stage.appendChild(placingTip)
      }
      placingTip.classList.remove('hidden')
      placingTip.textContent = scene.placing.valid
        ? '点击房间放下 · Esc 取消'
        : '这里放不下 · 换个位置或按 Esc 取消'
      placingTip.classList.toggle('bad', !scene.placing.valid)
    }

    function renderDepot() {
      var d = ensureDepot()
      d.innerHTML = ''

      var bar = document.createElement('div')
      bar.className = 'homeDepotBar'
      var tabs = [
        { id: 'skin', label: '装潢' },
        { id: 'extra', label: '装饰' },
      ]
      for (var t = 0; t < tabs.length; t++) {
        var tb = document.createElement('button')
        tb.className = 'homeDepotTab' + (depotTab === tabs[t].id ? ' on' : '')
        tb.dataset.tab = tabs[t].id
        tb.textContent = tabs[t].label
        bar.appendChild(tb)
      }
      var close = document.createElement('button')
      close.className = 'homeDepotClose'
      close.dataset.close = '1'
      close.textContent = '×'
      close.title = '关闭仓库'
      bar.appendChild(close)
      d.appendChild(bar)

      var body = document.createElement('div')
      body.className = 'homeDepotBody'

      if (depotTab === 'skin') {
        // 顶部：一键整套（只在该系列 8 件全拥有时可点）
        var quick = document.createElement('div')
        quick.className = 'homeQuickRow'
        var qlabel = document.createElement('span')
        qlabel.className = 'homeQuickLabel'
        qlabel.textContent = '整套'
        quick.appendChild(qlabel)
        for (var q = 0; q < D.SETS.length; q++) {
          var qs = D.SETS[q]
          var ids = D.itemsOfSeries(qs.id)
          var have = 0
          for (var h = 0; h < ids.length; h++) if (ownedItems[ids[h]]) have++
          var qb = document.createElement('button')
          qb.className = 'homeQuickBtn'
          qb.dataset.series = qs.id
          qb.style.borderColor = have === ids.length ? D.RARITY_COLOR[qs.rarity] : '#2e231c'
          // 不再用 disabled：禁用按钮点了毫无反应，改由点击时的提示解释差什么
          qb.title = have < ids.length ? qs.name + '：还差 ' + (ids.length - have) + ' 件' : '一键换上整套「' + qs.name + '」'
          qb.textContent = qs.name + ' ' + have + '/' + ids.length
          quick.appendChild(qb)
        }
        body.appendChild(quick)

        // 提示行：flashDepotHint 要有这个元素才有地方写字（与装饰页同款）
        var h1 = document.createElement('div')
        h1.className = 'homeDepotHint'
        h1.textContent = '点一下换上 · 未拥有的击败敌人有几率掉落'
        body.appendChild(h1)

        // 8 个槽位，每个槽位 5 个选项
        for (var i = 0; i < D.SKIN_SLOTS.length; i++) {
          var slot = D.SKIN_SLOTS[i].key
          var group = document.createElement('div')
          group.className = 'homeDepotGroup'
          var gt = document.createElement('div')
          gt.className = 'homeDepotGroupTitle'
          gt.textContent = D.SLOT_NAME[slot]
          group.appendChild(gt)

          var opts = document.createElement('div')
          opts.className = 'homeDepotOpts'
          for (var s2 = 0; s2 < D.SETS.length; s2++) {
            var series = D.SETS[s2]
            var itemId = series.id + '_' + slot
            var it = D.ITEM_INDEX[itemId]
            var own = !!ownedItems[itemId]
            var cur = scene.skins[slot] === itemId
            var cell = document.createElement('button')
            cell.className = 'homeDepotOpt' + (cur ? ' on' : '') + (own ? '' : ' locked')
            cell.dataset.skin = itemId
            cell.dataset.slot = slot
            cell.style.borderColor = cur ? D.RARITY_COLOR[it.rarity] : ''
            cell.title = it.name + '（' + D.RARITY_LABEL[it.rarity] + '）' + (own ? '' : '　尚未拥有')
            cell.appendChild(makeThumb(series.id, slot))
            var tag = document.createElement('span')
            tag.className = 'homeDepotOptTag'
            tag.textContent = own ? D.RARITY_LABEL[it.rarity] : '未拥有'
            tag.style.color = own ? D.RARITY_COLOR[it.rarity] : 'var(--dim)'
            cell.appendChild(tag)
            opts.appendChild(cell)
          }
          group.appendChild(opts)
          body.appendChild(group)
        }
      } else {
        var placed = scene.extraCount()
        // 「已拥有 x/y」是诊断位：前端从 tick 里同步到的 owned 数量。
        // 如果这里显示的不是你解锁的数量，说明 webview 在跑旧脚本或消息没到，一看便知。
        var ownCount = 0
        for (var oc = 0; oc < D.EXTRAS.length; oc++) if (ownedItems[D.EXTRAS[oc].id]) ownCount++
        var h2 = document.createElement('div')
        h2.className = 'homeDepotHint'
        h2.textContent =
          '已摆放 ' + placed + '/' + D.EXTRA_MAX +
          ' · 已拥有 ' + ownCount + '/' + D.EXTRAS.length +
          '　点一下拿起，再点屋里放下'
        body.appendChild(h2)

        var grid = document.createElement('div')
        grid.className = 'homeExtraGrid'
        for (var e = 0; e < D.EXTRAS.length; e++) {
          var ex = D.EXTRAS[e]
          var ownE = !!ownedItems[ex.id]
          var on = !!scene.itemOf(ex.id)
          // 正在「拿起」的那件要有明确高亮，否则点了之后看着毫无反应
          var picking = !!(scene.placing && scene.placing.key === ex.id)
          var cell2 = document.createElement('button')
          cell2.className = 'homeExtraCell' + (on ? ' on' : '') + (picking ? ' picking' : '') + (ownE ? '' : ' locked')
          cell2.dataset.extra = ex.id
          cell2.title = ex.name + '（' + D.RARITY_LABEL[ex.rarity] + '）' +
            (ownE ? (on ? '　已摆放，点击收起' : '　点击拿起，再点屋里放下') : '　尚未拥有')
          var cv = document.createElement('canvas')
          cv.width = ex.sprite[0]
          cv.height = ex.sprite[1]
          var c2 = cv.getContext('2d')
          c2.imageSmoothingEnabled = false
          var cellRect = atlas.cells['x/' + ex.id]
          if (cellRect) c2.drawImage(atlas.atlas, cellRect.x, cellRect.y, cellRect.w, cellRect.h, 0, 0, cellRect.w, cellRect.h)
          cv.style.width = Math.round(ex.sprite[0] * 0.55) + 'px'
          cv.style.height = Math.round(ex.sprite[1] * 0.55) + 'px'
          cell2.appendChild(cv)
          grid.appendChild(cell2)
        }
        body.appendChild(grid)
      }
      d.appendChild(body)
    }

    function onDepotClick(e) {
      var el = e.target.closest ? e.target.closest('[data-close],[data-tab],[data-skin],[data-series],[data-extra]') : null
      if (!el) return

      if (el.dataset.close) {
        closeDepot()
        return
      }
      if (el.dataset.tab) {
        depotTab = el.dataset.tab
        renderDepot()
        return
      }

      // 一键整套：只有 8 件全拥有才可点
      if (el.dataset.series) {
        var ids = D.itemsOfSeries(el.dataset.series)
        var missingName = ''
        for (var i = 0; i < ids.length; i++) {
          if (!ownedItems[ids[i]]) {
            var mi = D.ITEM_INDEX[ids[i]]
            missingName = mi ? mi.name : ids[i]
            break
          }
        }
        // 未集齐也不能静默 —— 玩家会以为按钮坏了
        if (missingName) {
          flashDepotHint('还差「' + missingName + '」，集齐整套才能一键换装')
          return
        }
        pushHistory()
        for (var j = 0; j < ids.length; j++) {
          var it = D.ITEM_INDEX[ids[j]]
          if (it && it.slot) scene.setSkin(it.slot, ids[j])
        }
        syncRoom()
        renderSets()
        renderDepot()
        invalidate()
        commit()
        return
      }

      // 换单件
      if (el.dataset.skin) {
        var slot = el.dataset.slot
        var itemId = el.dataset.skin
        if (!ownedItems[itemId]) {
          // 未拥有时不再静默 return —— 玩家会以为按钮坏了
          var it = D.ITEM_INDEX[itemId]
          flashDepotHint('「' + (it ? it.name : itemId) + '」尚未拥有，击败敌人有几率掉落')
          return
        }
        if (scene.skins[slot] === itemId) return // 没变就别记历史
        pushHistory()
        if (!scene.setSkin(slot, itemId)) return
        syncRoom()
        renderSets()
        renderDepot()
        invalidate()
        commit()
        return
      }

      // 装饰摆 / 收
      if (el.dataset.extra) {
        var id = el.dataset.extra
        // 未拥有时不再静默 return —— 玩家会以为按钮坏了
        if (!ownedItems[id]) {
          flashDepotHint('「' + D.EXTRA_INDEX[id].name + '」尚未拥有，击败敌人有几率掉落')
          return
        }

        // 已经摆着 → 直接收起
        if (scene.itemOf(id)) {
          pushHistory()
          scene.removePiece(id)
          renderSets()
          renderDepot()
          invalidate()
          commit()
          return
        }

        // 没摆 → 进入预览放置：跟着鼠标走，点屋里才落下。
        // 直接丢到「第一个空位」经常被床挡住，是之前最烦人的一点。
        if (!scene.startPlacing(id)) {
          var hint = depot.querySelector('.homeDepotHint')
          if (hint) {
            var over = scene.extraCount() >= D.EXTRA_MAX
            hint.textContent = over ? '已达上限 ' + D.EXTRA_MAX + ' 件，先收起一件' : '屋里没有放得下的空位了'
            hint.classList.add('warn')
            setTimeout(function () {
              hint.classList.remove('warn')
              renderDepot()
            }, 1600)
          }
          return
        }
        renderDepot()
        syncPlacingTip()
        invalidate()
      }
    }

    // 底栏加「仓库」按钮（纯 JS 注入，panel.html 与 home-lab.html 都不用改）
    function ensureDepotButton() {
      var bar = rootEl.querySelector('.homeBar')
      if (!bar || bar.querySelector('#homeDepotBtn')) return

      // 先插撤销，再把仓库插到最前 → 最终顺序是 [仓库][撤销]
      var undoBtn = document.createElement('button')
      undoBtn.id = 'homeUndoBtn'
      undoBtn.textContent = '撤销'
      undoBtn.title = '后退一步（Ctrl+Z）'
      undoBtn.onclick = function () {
        undo()
      }
      bar.insertBefore(undoBtn, bar.firstChild)

      var btn = document.createElement('button')
      btn.id = 'homeDepotBtn'
      btn.textContent = '仓库'
      btn.onclick = function () {
        if (depot && !depot.classList.contains('hidden')) closeDepot()
        else openDepot('skin')
      }
      bar.insertBefore(btn, bar.firstChild)
    }

    function commit() {
      if (commitHook) commitHook(snapshot())
    }

    // 宿主推进来的存档只在第一次生效。之后玩家本地摆的才是准的，
    // 否则每次 tick 推 state 都会把正在拖的布局冲掉。
    function applyHome(home) {
      if (!home || typeof home !== 'object') return false
      // 拥有状态每次都要同步：掉出新物品要立刻反映到仓库，不能被「只应用一次」挡住
      var ownedChanged = false
      var shrunk = false // 服务端件数比本地少 = 重置 / 换档，必须按服务端全量重建
      if (home.owned && typeof home.owned === 'object') {
        var serverN = 0
        var clientN = 0
        var k
        for (k in home.owned) if (home.owned[k]) serverN++
        for (k in ownedItems) if (ownedItems[k]) clientN++
        if (serverN < clientN) {
          ownedItems = {}
          for (k in home.owned) if (home.owned[k]) ownedItems[k] = true
          ownedChanged = true
          shrunk = true
        } else {
          for (k in home.owned) {
            if (home.owned[k] && D.ITEM_INDEX[k] && !ownedItems[k]) {
              ownedItems[k] = true
              ownedChanged = true
            }
          }
        }
      }
      if (homeSynced && !shrunk) {
        if (ownedChanged) {
          renderSets()
          // 仓库抽屉正开着时也要立刻点亮新掉的那件（否则要关掉再开才看得到）
          if (depotOpen) renderDepot()
        }
        return false
      }
      // 重置后 layout 是空数组：此时要回到默认摆位，而不是"保持旧房间不动"
      if (home.skins) scene.setSkins(home.skins)
      if (Array.isArray(home.layout) && (home.layout.length || shrunk)) {
        scene.setLayout(home.layout.length ? home.layout : D.DEFAULT_LAYOUT)
      }
      if (actor) actor.validate()
      homeSynced = true
      syncRoom()
      renderSets()
      if (depotOpen) renderDepot()
      invalidate()
      return true
    }

    // ---------- 久别（72 小时）与情绪 ----------
    // 判定口径：存档里的 lastSeen（每次攻击都会刷新）距今 ≥ 72h → 屋子落灰、小狗趴睡。
    // 真正的"醒来 + 一次性奖励"由宿主在攻击时结算（home.wake），这里只负责播演出。
    var AWAY_MS = 72 * 60 * 60 * 1000
    var WAKE_LINES = [
      '你回来啦。屋里的灰我都扫干净了。',
      '好久不见……我睡了好久，尾巴都压麻了。',
      '你不在的时候，我把家看好了。',
      '终于回来了。我还以为你要搬走了。',
    ]
    var moodDusty = false
    var wakeSeen = 0
    var lastMoodHome = null
    var sayEl = null
    var sayTimer = 0

    function ensureSay() {
      if (sayEl) return sayEl
      var stage = rootEl.querySelector('#homeStage')
      if (!stage) return null
      sayEl = document.createElement('div')
      sayEl.className = 'homeSay'
      stage.appendChild(sayEl)
      return sayEl
    }

    function say(text, ms) {
      var el = ensureSay()
      if (!el) return
      el.textContent = text
      el.classList.add('on')
      if (sayTimer) clearTimeout(sayTimer)
      sayTimer = setTimeout(function () {
        el.classList.remove('on')
      }, ms || 6500)
    }

    function itemName(id) {
      var it = D.ITEM_INDEX[id]
      return it ? it.name : String(id)
    }

    function applyDustClass(on) {
      moodDusty = !!on
      if (canvas) canvas.classList.toggle('dusty', !!on)
    }

    function applyMood(home) {
      if (!home || typeof home !== 'object') return
      lastMoodHome = home
      if (!actor) return
      var wake = home.wake && Number(home.wake.at) > 0 && !home.wake.seen ? home.wake : null
      // 新事件：同一个 wake.at 只播一次；播完回写 seen，重开面板不再重复"你回来啦"
      if (wake && wake.at > wakeSeen) {
        if (!active) {
          // 面板在战斗页：演出先欠着，等切到小屋再补（否则播在看不见的地方，还白白标记已看）
          return
        }
        wakeSeen = wake.at
        applyDustClass(false)
        actor.wake()
        var line = WAKE_LINES[Math.abs(Math.floor(wake.at / 1000)) % WAKE_LINES.length]
        var tail = wake.item
          ? ' 还从角落里翻出「' + itemName(wake.item) + '」，给你摆好了。'
          : ' 家里干净得很，没什么可收拾的。'
        var text = line + tail
        say(text, 8000)
        if (wakeSeenHook) wakeSeenHook(wake.at)
        invalidate()
        return
      }
      // 没有新事件：按 lastSeen 决定是否落灰 / 趴睡
      var last = Number(home.lastSeen) || 0
      var dusty = last > 0 && Date.now() - last >= AWAY_MS
      if (dusty === moodDusty) return
      applyDustClass(dusty)
      if (dusty) {
        actor.setAway(true, 1)
        if (active) say('屋子落了灰，它趴在角落睡着了。', 5200)
      } else {
        actor.setAway(false, 0)
      }
      invalidate()
    }

    // ---------- 生命周期 ----------
    function mount() {
      if (active) return
      active = true
      // capture 阶段监听：webview 里 Ctrl+Z 默认会被编辑器吃掉，先拦下来
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('pointerdown', onDocPointerDown, true)
      paintStageBackdrop()
      syncRoom()
      renderSets()
      computeMounts()
      measure()
      autoFit()
      syncZoomLabel()
      if (els.backend) els.backend.textContent = backend.name === 'webgl2' ? 'WebGL2' : 'Canvas2D 兜底'
      // 存档可能在小屋没打开时就到了（战斗页触发了醒来）→ 进小屋时补播
      if (lastMoodHome) applyMood(lastMoodHome)
      lastTs = 0
      invalidate()
    }

    function unmount() {
      if (!active) return
      active = false
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      closeQuickPick()
      scene.cancelPlacing()
      if (rafId) {
        root.cancelAnimationFrame(rafId)
        rafId = 0
      }
      lastTs = 0
      scene.cancelDrag()
      mode = null
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault()
    })
    root.addEventListener('resize', onResize)
    if (els.sets) els.sets.addEventListener('click', onSkinRowClick)
    ensureDepotButton()
    ensureDepot()

    var zin = rootEl.querySelector('#homeZoomIn')
    var zout = rootEl.querySelector('#homeZoomOut')
    var reset = rootEl.querySelector('#homeReset')
    if (zin) zin.addEventListener('click', onZoomIn)
    if (zout) zout.addEventListener('click', onZoomOut)
    if (reset) reset.addEventListener('click', onReset)

    return {
      scene: scene,
      backend: backend,
      mount: mount,
      unmount: unmount,
      isActive: function () {
        return active
      },
      invalidate: invalidate,
      applyHome: applyHome,
      // 情绪层（久别/落灰/醒来）：存档里带 lastSeen 与 wake，每次 state 都会推进来
      setMood: applyMood,
      pokeActor: function () {
        if (actor) actor.poke()
      },
      celebrate: function () {
        if (actor) return actor.celebrate()
        return false
      },
      actorState: function () {
        return actor ? { pos: actor.pos, state: actor.state, dust: actor.dust, prop: actor.prop } : null
      },
      snapshot: snapshot,
      // 收藏数据变动后重算陈列（数据本体存在模块级 assetStore 里）
      refreshMounts: function () {
        if (active) computeMounts()
      },
      setSkin: function (slot, itemId) {
        var ok = scene.setSkin(slot, itemId)
        if (ok) {
          syncRoom()
          renderSets()
          invalidate()
        }
        return ok
      },
      getLayout: function () {
        return scene.layout.map(function (it) {
          return { slot: it.slot, gx: it.gx, gy: it.gy }
        })
      },
      dispose: function () {
        unmount()
        backend.dispose()
        root.removeEventListener('resize', onResize)
      },
    }
  }

  // 单例：视图切换时复用同一个 scene（布局不丢），只做 mount / unmount
  function get(rootEl) {
    if (instance) return instance
    var el = rootEl || document.getElementById('homeView')
    if (!el) return null
    instance = createHome(el)
    return instance
  }

  var API = {
    get: get,
    mount: function () {
      var h = get()
      if (!h) return null
      h.mount()
      // 首次打开时把之前收到的存档灌进去（此时图集刚建好）
      if (pendingHome) {
        h.applyHome(pendingHome)
        pendingHome = null
      }
      if (pendingMood) {
        h.setMood(pendingMood)
        pendingMood = null
      }
      return h
    },
    unmount: function () {
      if (instance) instance.unmount()
    },
    setSkin: function (slot, itemId) {
      var h = get()
      return h ? h.setSkin(slot, itemId) : false
    },
    getLayout: function () {
      return instance ? instance.getLayout() : null
    },
    // 宿主推进来的存档。小屋还没打开过就先存着，等 mount 再应用，
    // 免得为了存一个字段就平白建一次图集。
    applyHome: function (home) {
      if (!home || typeof home !== 'object') return false
      if (instance) return instance.applyHome(home)
      pendingHome = home
      return true
    },
    // 情绪层：lastSeen（落灰/趴睡）与 wake（醒来演出）。小屋没打开时先存着，
    // 打开那一刻补播（不然战斗页触发的醒来演出会被静默丢掉）。
    setMood: function (home) {
      if (!home || typeof home !== 'object') return false
      if (instance) {
        instance.setMood(home)
        return true
      }
      pendingMood = home
      return true
    },
    // pet.js 在 hasHost 时注入：布局变更 → 一条 postMessage，由宿主落盘
    setCommit: function (fn) {
      commitHook = typeof fn === 'function' ? fn : null
    },
    // 醒来演出播完 → 回写 seen（不注入时什么都不做，官网演示因此会重播，可接受）
    setWakeSeen: function (fn) {
      wakeSeenHook = typeof fn === 'function' ? fn : null
    },
    // 玩家收藏：pet.js 收到 arsenalData / bestiaryData 时推进来。
    // kind = 'weapons' 时 owned 是 {id:count}；kind = 'enemies' 时 owned 是 defeated。
    setAssets: function (kind, list, sprites, byId) {
      if (kind !== 'weapons' && kind !== 'enemies') return
      // byId 对武器是 {id: 数量}，对怪物是 {id: 击败次数}，语义一致：>0 即已拥有
      assetStore[kind] = { list: list, sprites: sprites, byId: byId || {} }
      if (instance) instance.refreshMounts()
    },
    get scene() {
      return instance ? instance.scene : null
    },
    // 自检/调试：小狗此刻在哪、在干什么
    actorState: function () {
      return instance ? instance.actorState() : null
    },
    poke: function () {
      if (instance) instance.pokeActor()
    },
    // 击杀庆祝（宿主在 defeats 增加时调一次；小屋没打开时什么也不做）
    celebrate: function () {
      return instance ? instance.celebrate() : false
    },
  }

  root.NibbleHome = API
})(typeof window !== 'undefined' ? window : globalThis)
