'use strict'
// home-atlas.js — 小屋的占位美术生成器
//
// 第一刀没有真实美术。这里用程序化绘制产出两样东西：
//   1) 物件图集：5 套 × 6 件家具，每件按 palette + shape 画出可辨识的轮廓；
//   2) 房间底图：地板菱形网格 + 后墙 + 左墙，每套一张（烘焙成一张纹理）。
//
// 为什么放在独立文件而不是塞进渲染后端：
//   WebGL2 与 canvas2d 两条路径要用同一批图，生成逻辑只该有一份。
//   GL 端把这个 canvas 上传成纹理，2D 端直接 drawImage。
//
// 接真实美术时只需要替换本文件的绘制部分（或改成读 *-pixels.js 的网格数据），
// 图集布局、UV 约定、两个后端都不需要改。

;(function (root) {
  var D = root.NibbleHomeData
  if (!D) return

  var HW = D.TILE_W / 2
  var HH = D.TILE_H / 2
  var PAD = D.PAD_Y // 地面菱形之上留出的高度（墙与最高家具都画在这段里）

  // 图集网格：6 列 × 11 行
  //   行 0-4 = 5 套 × 6 件家具（每套一行）
  //   行 5   = 墙面挂点空槽（5 格）
  //   行 6   = 拖动高亮 ×2 + 家具落影
  //   行 7-10 = 20 件通用装饰（跨套装共用，只画一份）
  // 格子必须容得下最大的一件（地毯 108 宽、床 64 高），否则会互相切边
  var CELL_W = 112
  var CELL_H = 72
  var COLS = 6
  var ROWS = 11
  var ATLAS_W = CELL_W * COLS
  var ATLAS_H = CELL_H * ROWS

  // 纹理坐标：格坐标 → 房间底图像素
  //   与 scene.project 的关系：先算世界像素，再减掉 ROOM_RECT 左上角
  //   worldX = (gx-gy)*HW - ORIGIN_X，worldY = (gx+gy)*HH - z*Z_UNIT - ORIGIN_Y
  function tp(gx, gy, z) {
    return {
      x: (gx - gy) * HW - D.ORIGIN_X - D.ROOM_RECT.x,
      y: (gx + gy) * HH - (z || 0) * D.Z_UNIT - D.ORIGIN_Y - D.ROOM_RECT.y,
    }
  }

  // ---------- 基础绘制 ----------
  function rect(ctx, x, y, w, h, color) {
    ctx.fillStyle = color
    ctx.fillRect(x | 0, y | 0, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
  }

  function diamondPath(ctx, cx, cy, hw, hh) {
    ctx.beginPath()
    ctx.moveTo(cx, cy - hh)
    ctx.lineTo(cx + hw, cy)
    ctx.lineTo(cx, cy + hh)
    ctx.lineTo(cx - hw, cy)
    ctx.closePath()
  }

  function fillDiamond(ctx, cx, cy, hw, hh, color) {
    diamondPath(ctx, cx, cy, hw, hh)
    ctx.fillStyle = color
    ctx.fill()
  }

  // ---------- 房间底图 ----------
  // 地板与墙纸可以来自不同系列，所以这里收两个参数：floorSet 管地面，wallSet 管墙面。
  function paintRoom(set, wallSet) {
    var p = set.palette
    var w = (wallSet || set).palette
    var cv = document.createElement('canvas')
    cv.width = D.WORLD_W
    cv.height = D.WORLD_H
    var ctx = cv.getContext('2d')
    ctx.imageSmoothingEnabled = false

    // 1) 地板：有材质图就逐格铺菱形砖，否则回退到程序化菱形网格
    var floorTile = tileCanvas(set.id + '/tile_floor')
    for (var gy = 0; gy < D.ROWS; gy++) {
      for (var gx = 0; gx < D.COLS; gx++) {
        var c = tp(gx + 0.5, gy + 0.5, 0)
        if (floorTile) {
          // 精确贴合一格菱形；向左上各扩 1px 消掉相邻砖之间的缝
          ctx.drawImage(floorTile, Math.round(c.x - HW) - 1, Math.round(c.y - HH) - 1, D.TILE_W + 2, D.TILE_H + 2)
          continue
        }
        var col = (gx + gy) % 2 === 0 ? p.floor : p.floorAlt
        fillDiamond(ctx, c.x, c.y, HW, HH, col)
        // 1px 菱格描边：像素地板靠这条线立骨架
        diamondPath(ctx, c.x, c.y, HW, HH)
        ctx.strokeStyle = p.trim
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    // 2) 后墙（gy = 0 平面，沿 gx 铺开）
    var wallH = D.Z_UNIT * 3.2
    var b0 = tp(0, 0, 0)
    var b1 = tp(D.COLS, 0, 0)
    ctx.beginPath()
    ctx.moveTo(b0.x, b0.y)
    ctx.lineTo(b1.x, b1.y)
    ctx.lineTo(b1.x, b1.y - wallH)
    ctx.lineTo(b0.x, b0.y - wallH)
    ctx.closePath()
    ctx.fillStyle = w.wall
    ctx.fill()

    // 墙纸：有材质图就沿墙面斜切平铺，否则回退到竖向条纹
    var wallTile = tileCanvas((wallSet || set).id + '/tile_wall')
    if (wallTile) {
      var bLen = Math.hypot(b1.x - b0.x, b1.y - b0.y)
      ctx.save()
      ctx.clip() // clip 用的是全局坐标的墙路径，必须在 setTransform 之前建立
      // 局部 (u,v)：u 沿墙向右下、v 垂直向上。u/v 方向长度均为 1，贴图不会被拉长。
      ctx.setTransform((b1.x - b0.x) / bLen, (b1.y - b0.y) / bLen, 0, -1, b0.x, b0.y)
      for (var u = 0; u < bLen; u += wallTile.width) {
        for (var v = 0; v < wallH; v += wallTile.height) {
          ctx.drawImage(wallTile, u, v)
        }
      }
      ctx.restore()
    } else {
      ctx.save()
      ctx.clip()
      for (var wx = 0; wx < D.COLS * 8; wx++) {
        if (wx % 4 !== 0) continue
        var s0 = tp(wx / 8, 0, 0)
        rect(ctx, s0.x, s0.y - wallH, 2, wallH, w.wallAlt)
      }
      ctx.restore()
    }

    // 墙脚线
    ctx.beginPath()
    ctx.moveTo(b0.x, b0.y)
    ctx.lineTo(b1.x, b1.y)
    ctx.lineTo(b1.x, b1.y - 3)
    ctx.lineTo(b0.x, b0.y - 3)
    ctx.closePath()
    ctx.fillStyle = w.trim
    ctx.fill()

    // 3) 左墙（gx = 0 平面，沿 gy 铺开）—— 背光面，用更暗的色
    var l0 = tp(0, 0, 0)
    var l1 = tp(0, D.ROWS, 0)
    ctx.beginPath()
    ctx.moveTo(l0.x, l0.y)
    ctx.lineTo(l1.x, l1.y)
    ctx.lineTo(l1.x, l1.y - wallH)
    ctx.lineTo(l0.x, l0.y - wallH)
    ctx.closePath()
    ctx.fillStyle = w.wallAlt
    ctx.fill()

    ctx.save()
    ctx.clip()
    if (wallTile) {
      var lLen = Math.hypot(l0.x - l1.x, l0.y - l1.y)
      ctx.save()
      ctx.clip()
      // 从左下角往北角铺，u 方向与后墙同长但符号相反
      ctx.setTransform((l0.x - l1.x) / lLen, (l0.y - l1.y) / lLen, 0, -1, l1.x, l1.y)
      for (var lu = 0; lu < lLen; lu += wallTile.width) {
        for (var lv = 0; lv < wallH; lv += wallTile.height) {
          ctx.drawImage(wallTile, lu, lv)
        }
      }
      ctx.restore()
    } else {
      for (var wy = 0; wy < D.ROWS * 8; wy++) {
        if (wy % 4 !== 0) continue
        var t0 = tp(0, wy / 8, 0)
        rect(ctx, t0.x - 2, t0.y - wallH, 2, wallH, w.trim)
      }
    }
    ctx.restore()

    // 左墙墙脚线
    ctx.beginPath()
    ctx.moveTo(l0.x, l0.y)
    ctx.lineTo(l1.x, l1.y)
    ctx.lineTo(l1.x, l1.y - 3)
    ctx.lineTo(l0.x, l0.y - 3)
    ctx.closePath()
    ctx.fillStyle = w.trim
    ctx.fill()

    // 4) 门（留开口：角色未来的入场点）—— 画在后墙最左一格，跟墙纸同色系
    var door = tp(0.5, 0, 0)
    rect(ctx, door.x - 7, door.y - 26, 14, 24, w.trim)
    rect(ctx, door.x - 5, door.y - 24, 10, 21, w.dark)
    rect(ctx, door.x + 1, door.y - 14, 2, 2, w.accent)

    // 5) alpha 硬化：把半透明边缘压成 0 或 255。
    //    菱形是斜边，canvas 抗锯齿会留下半透明像素；GL 侧按 alpha 混合后
    //    这些像素会变成格与格之间的暗缝，整体发灰。像素画本来就该是硬边。
    var img = ctx.getImageData(0, 0, cv.width, cv.height)
    var px = img.data
    for (var i = 3; i < px.length; i += 4) {
      px[i] = px[i] < 8 ? 0 : 255
    }
    ctx.putImageData(img, 0, 0)

    return cv
  }

  // ---------- 材质（地板砖 / 墙纸）----------
  // 从构建产出的像素数据还原成小 canvas 并缓存。Tile 很小（32×16 / 32×32），
  // 逐像素 fillRect 一次就够，不需要离屏 ImageData。
  var TILE_CACHE = {}
  function tileCanvas(key) {
    if (TILE_CACHE[key] !== undefined) return TILE_CACHE[key]
    var px = root.NibbleFurniturePixels
    var src = px && px[key]
    if (!src || !src.rows || !src.palette) {
      TILE_CACHE[key] = null
      return null
    }
    var cv = document.createElement('canvas')
    cv.width = src.w
    cv.height = src.h
    var c2 = cv.getContext('2d')
    for (var y = 0; y < src.h; y++) {
      var row = src.rows[y]
      for (var x = 0; x < src.w; x++) {
        var ch = row[x]
        if (!ch || ch === '.') continue
        c2.fillStyle = src.palette[parseInt(ch, 36)] || '#000'
        c2.fillRect(x, y, 1, 1)
      }
    }
    TILE_CACHE[key] = cv
    return cv
  }

  // ---------- 家具 ----------
  // 每件家具都画在「底边中点 = 精灵底边中点」的坐标系里，
  // 这样 scene 层只要把精灵底边对齐占地区域的南角就行，两处不用互相迁就。
  function paintBed(ctx, x, y, set, shape) {
    var p = set.palette
    var float = shape === 'float'
    // 床头板
    rect(ctx, x + 2, y + 4, 12, 36, p.dark)
    rect(ctx, x + 4, y + 8, 8, 24, p.base)
    // 床脚（悬浮款不画腿，改画落影）
    if (!float) {
      rect(ctx, x + 14, y + 40, 4, 6, p.dark)
      rect(ctx, x + 50, y + 40, 4, 6, p.dark)
    } else {
      rect(ctx, x + 14, y + 44, 40, 2, 'rgba(0,0,0,0.28)')
    }
    // 床体
    rect(ctx, x + 12, y + 18, 42, 22, p.base)
    rect(ctx, x + 12, y + 18, 42, 2, p.light)
    // 被子
    rect(ctx, x + 12, y + 26, 42, 14, p.accent)
    rect(ctx, x + 12, y + 26, 42, 2, p.light)
    // 枕头
    rect(ctx, x + 16, y + 12, 16, 10, p.light)
    rect(ctx, x + 16, y + 20, 16, 2, p.trim)
    // 描边
    rect(ctx, x + 12, y + 40, 42, 1, p.trim)
  }

  function paintDesk(ctx, x, y, set) {
    var p = set.palette
    rect(ctx, x + 2, y + 10, 48, 7, p.light)
    rect(ctx, x + 2, y + 17, 48, 3, p.base)
    rect(ctx, x + 2, y + 20, 48, 1, p.trim)
    rect(ctx, x + 5, y + 21, 4, 15, p.dark)
    rect(ctx, x + 43, y + 21, 4, 15, p.dark)
    // 桌面上的小物（每套都不同色，算是占位阶段的「个性」）
    rect(ctx, x + 18, y + 3, 14, 7, p.accent)
    rect(ctx, x + 18, y + 3, 14, 1, p.light)
    rect(ctx, x + 34, y + 6, 8, 4, p.dark)
  }

  function paintChair(ctx, x, y, set) {
    var p = set.palette
    rect(ctx, x + 4, y + 2, 16, 13, p.base)
    rect(ctx, x + 4, y + 7, 16, 2, p.light)
    rect(ctx, x + 2, y + 14, 20, 5, p.light)
    rect(ctx, x + 2, y + 19, 20, 2, p.base)
    rect(ctx, x + 4, y + 21, 3, 8, p.dark)
    rect(ctx, x + 17, y + 21, 3, 8, p.dark)
  }

  function paintLamp(ctx, x, y, set, shape) {
    var p = set.palette
    // 光晕：先画，被灯罩盖住一点，视觉上是「溢出」
    var g = ctx.createRadialGradient(x + 10, y + 12, 1, x + 10, y + 12, 16)
    g.addColorStop(0, p.glow)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.35
    ctx.fillStyle = g
    ctx.fillRect(x, y, 20, 30)
    ctx.globalAlpha = 1

    rect(ctx, x + 6, y + 33, 8, 4, p.dark)
    if (shape === 'tube') {
      rect(ctx, x + 8, y + 6, 4, 27, p.glow)
      rect(ctx, x + 8, y + 6, 1, 27, p.accent)
    } else {
      rect(ctx, x + 9, y + 17, 2, 16, p.dark)
      rect(ctx, x + 5, y + 3, 10, 4, p.accent)
      rect(ctx, x + 3, y + 7, 14, 10, p.glow)
      rect(ctx, x + 3, y + 15, 14, 2, p.accent)
    }
  }

  function paintRug(ctx, x, y, set, shape) {
    var p = set.palette
    var cx = x + 44
    var cy = y + 22
    // 深色外框压住地板，否则 base 色和地板太接近，地毯看起来像块空地
    fillDiamond(ctx, cx, cy, 40, 20, p.trim)
    fillDiamond(ctx, cx, cy, 37, 18, p.light)
    fillDiamond(ctx, cx, cy, 30, 15, p.base)
    if (shape === 'grid') {
      for (var i = -2; i <= 2; i++) {
        rect(ctx, cx + i * 10 - 1, cy - 6, 2, 12, p.light)
      }
    } else if (shape === 'stars') {
      rect(ctx, cx - 12, cy - 4, 2, 2, p.glow)
      rect(ctx, cx + 6, cy + 3, 2, 2, p.glow)
      rect(ctx, cx + 16, cy - 6, 2, 2, p.glow)
      rect(ctx, cx - 20, cy + 5, 2, 2, p.glow)
    } else if (shape === 'pattern' || shape === 'weave') {
      fillDiamond(ctx, cx, cy, 20, 10, p.light)
      fillDiamond(ctx, cx, cy, 12, 6, p.base)
    }
  }

  function paintDeco(ctx, x, y, set, shape) {
    var p = set.palette
    rect(ctx, x + 4, y + 23, 14, 5, p.dark)
    if (shape === 'fern') {
      rect(ctx, x + 10, y + 10, 2, 13, p.dark)
      rect(ctx, x + 4, y + 6, 6, 3, p.accent)
      rect(ctx, x + 12, y + 3, 6, 3, p.accent)
      rect(ctx, x + 3, y + 13, 6, 3, p.accent)
      rect(ctx, x + 13, y + 11, 6, 3, p.accent)
    } else if (shape === 'box') {
      rect(ctx, x + 5, y + 12, 12, 11, p.base)
      rect(ctx, x + 5, y + 12, 12, 1, p.light)
      rect(ctx, x + 9, y + 15, 4, 4, p.accent)
    } else if (shape === 'crystal') {
      rect(ctx, x + 8, y + 6, 6, 17, p.accent)
      rect(ctx, x + 9, y + 4, 4, 3, p.light)
    } else if (shape === 'stack') {
      rect(ctx, x + 4, y + 14, 14, 3, p.accent)
      rect(ctx, x + 5, y + 17, 12, 3, p.light)
      rect(ctx, x + 6, y + 20, 10, 3, p.base)
    } else {
      rect(ctx, x + 6, y + 9, 10, 14, p.accent)
      rect(ctx, x + 8, y + 5, 6, 4, p.light)
    }
  }

  var PAINTERS = {
    bed: paintBed,
    desk: paintDesk,
    chair: paintChair,
    lamp: paintLamp,
    rug: paintRug,
    deco: paintDeco,
  }

  // ---------- 真实素材 ----------
  // furniture-pixels.js 由 tools/furniture-sprites.mjs 构建期生成，形如
  //   'wood/bed': { w: 56, h: 46, palette: ['#...'], rows: ['..ab..', ...] }
  // rows 的每个字符是调色板下标（base36），'.' = 透明。
  //
  // 用 ImageData 整块写入而不是逐像素 fillRect：
  // 30 件 × 约 2500 像素 = 7 万次 fillRect，构建首帧会明显卡顿；
  // putImageData 一次搞定，而且 alpha 天然是 0/255 的硬边（不会在 GL 里出现暗缝）。
  function paintFromPixels(ctx, data, ox, oy) {
    var w = data.w
    var h = data.h
    var img = ctx.createImageData(w, h)
    var d = img.data
    var pal = data.palette
    // 调色板预解析成 RGB，避免每个像素都 parseInt 一次
    var rgb = new Array(pal.length)
    for (var i = 0; i < pal.length; i++) {
      var n = parseInt(String(pal[i]).slice(1), 16)
      rgb[i] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    for (var y = 0; y < h; y++) {
      var row = data.rows[y] || ''
      for (var x = 0; x < w; x++) {
        var ch = row.charAt(x)
        if (ch === '' || ch === '.') continue
        var idx = parseInt(ch, 36)
        var c = rgb[idx]
        if (!c) continue
        var o = (y * w + x) * 4
        d[o] = c[0]
        d[o + 1] = c[1]
        d[o + 2] = c[2]
        d[o + 3] = 255
      }
    }
    ctx.putImageData(img, ox, oy)
  }

  // ---------- 拖动落点高亮 ----------
  // 96×48 的菱形（2:1），拉伸到任意占地面积的包围盒都不会变形
  function paintHighlight(ctx, x, y, ok) {
    var fill = ok ? 'rgba(255,240,210,0.42)' : 'rgba(255,107,107,0.40)'
    var edge = ok ? '#FFE3AE' : '#FF6B6B'
    fillDiamond(ctx, x + 48, y + 24, 46, 23, fill)
    diamondPath(ctx, x + 48, y + 24, 46, 23)
    ctx.strokeStyle = edge
    ctx.lineWidth = 3
    ctx.stroke()
  }

  // ---------- 墙面挂点 ----------
  // 第 6 行的 5 个格子。索引对应 D.WALL_MOUNTS 的顺序。
  // 内容会随玩家收集变化，所以这一行必须支持「只重画一格」，整张图集重画太贵。
  function paintMountCell(ctx, index, flatGrid, color) {
    var cx = index * CELL_W
    var cy = 5 * CELL_H
    ctx.clearRect(cx, cy, CELL_W, CELL_H)
    var mx = cx + (CELL_W - 24) / 2
    var my = cy + (CELL_H - 24) / 2

    if (!flatGrid) {
      // 空槽：虚线框 + 十字。用低 alpha 的米白 ——
      // 深色套装（霓虹/旧书房）的墙上如果画实心亮框，5 个空槽会比家具还抢眼。
      var slotColor = 'rgba(240, 224, 196, 0.34)'
      ctx.strokeStyle = slotColor
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.strokeRect(mx + 1.5, my + 1.5, 21, 21)
      ctx.setLineDash([])
      rect(ctx, mx + 11, my + 6, 2, 12, slotColor)
      rect(ctx, mx + 6, my + 11, 12, 2, slotColor)
      return
    }

    // 内容：一块不透明深色背板（不能用半透明，进 GL 会变成暗缝），
    // 上面叠 24×24 像素，最后套一圈稀有度色硬边。
    rect(ctx, mx - 2, my - 2, 28, 28, '#150F0C')
    for (var r = 0; r < 24; r++) {
      for (var c = 0; c < 24; c++) {
        var col = flatGrid[r * 24 + c]
        if (!col) continue
        rect(ctx, mx + c, my + r, 1, 1, col)
      }
    }
    ctx.strokeStyle = color || '#8A6242'
    ctx.lineWidth = 2
    ctx.strokeRect(mx - 1.5, my - 1.5, 27, 27)
  }

  // ---------- 家具落影 ----------
  // 96×48 的软两层菱形（硬边），运行时按占地区域拉伸。
  // 没有它家具会像贴纸一样浮在地板上；两层叠加让中心略深、边缘略浅。
  function paintShadow(ctx, x, y) {
    fillDiamond(ctx, x + 48, y + 24, 44, 22, 'rgba(0,0,0,0.34)')
    fillDiamond(ctx, x + 48, y + 24, 34, 17, 'rgba(0,0,0,0.26)')
  }

  // ---------- 舞台背景 ----------
  // 小屋外面原本是纯黑一片，太空旷。这里程序化画一张像素夜空：
  // 上深紫 → 下暖褐的渐变 + 两层星点 + 底部地平线雾气。
  // 用固定种子的伪随机，保证每次刷新星星位置不变（否则看起来像在闪）。
  function paintBackdrop() {
    var W = 320
    var H = 200
    var cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    var c = cv.getContext('2d')

    var g = c.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#0B0810')
    g.addColorStop(0.5, '#17101A')
    g.addColorStop(0.82, '#241A18')
    g.addColorStop(1, '#2E2219')
    c.fillStyle = g
    c.fillRect(0, 0, W, H)

    var seed = 20261027
    var rnd = function () {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }

    // 远层：细密小星点，偏暗
    for (var i = 0; i < 120; i++) {
      var x = Math.floor(rnd() * W)
      var y = Math.floor(rnd() * H * 0.62)
      c.fillStyle = 'rgba(255, 228, 190, ' + (0.1 + rnd() * 0.22).toFixed(3) + ')'
      c.fillRect(x, y, 1, 1)
    }
    // 近层：少量亮星，带一圈很淡的光晕
    for (var j = 0; j < 14; j++) {
      var bx = Math.floor(rnd() * W)
      var by = Math.floor(rnd() * H * 0.5)
      c.fillStyle = 'rgba(255, 240, 210, 0.1)'
      c.fillRect(bx - 1, by - 1, 4, 4)
      c.fillStyle = 'rgba(255, 246, 224, 0.9)'
      c.fillRect(bx, by, 2, 2)
    }
    // 底部雾气：把夜空和舞台底色接上，避免出现一条硬边
    var fog = c.createLinearGradient(0, H * 0.78, 0, H)
    fog.addColorStop(0, 'rgba(46, 34, 25, 0)')
    fog.addColorStop(1, 'rgba(46, 34, 25, 0.92)')
    c.fillStyle = fog
    c.fillRect(0, H * 0.78, W, H * 0.22)

    return cv
  }

  // ---------- 组装 ----------
  function build() {
    var atlas = document.createElement('canvas')
    atlas.width = ATLAS_W
    atlas.height = ATLAS_H
    var ctx = atlas.getContext('2d')
    ctx.imageSmoothingEnabled = false

    var cells = {}
    var rooms = {}
    // 真实家具素材（构建期生成）；读不到就整块回退到程序化 painters，
    // 官网或旧构建因此不会白屏。
    var PIXELS = root.NibbleFurniturePixels || null

    // 房间底图按需生成：地板与墙纸可以来自不同系列，组合有 25 种，
    // 全预烘焙要 6MB 内存 + 一两秒构建时间，没必要。
    function ensureRoom(floorId, wallId) {
      var f = D.SET_INDEX[floorId] || D.SETS[0]
      var wl = D.SET_INDEX[wallId] || D.SETS[0]
      var rk = D.roomKey(f.id, wl.id)
      if (!rooms[rk]) rooms[rk] = paintRoom(f, wl)
      return rk
    }

    for (var s = 0; s < D.SETS.length; s++) {
      var set = D.SETS[s]

      for (var k = 0; k < D.MOVABLE_SLOT_IDS.length; k++) {
        var slotId = D.MOVABLE_SLOT_IDS[k]
        var slot = D.SLOT_INDEX[slotId]
        var painter = PAINTERS[slotId]
        if (!slot || !painter) continue

        var cx = (k % COLS) * CELL_W
        var cy = Math.floor(k / COLS) * CELL_H + s * CELL_H
        var sw = slot.sprite[0]
        var sh = slot.sprite[1]
        // 精灵在格内底部居中：底边中点 = 格底边中点
        var ox = cx + (CELL_W - sw) / 2
        var oy = cy + (CELL_H - sh)

        var real = PIXELS ? PIXELS[set.id + '/' + slotId] : null
        // 尺寸不匹配就当作没有（宁可回退也不要拉伸变形）
        if (real && real.palette && real.rows && real.w === sw && real.h === sh) {
          paintFromPixels(ctx, real, ox, oy)
        } else {
          painter(ctx, ox, oy, set, set.shape[slotId])
        }
        cells[set.id + '/' + slotId] = { x: ox, y: oy, w: sw, h: sh }
      }
    }

    // 挂点：放在第 6 行。初始全是空槽，收到玩家收藏后由 paintMountCell 逐格重画。
    for (var m = 0; m < D.WALL_MOUNTS.length; m++) {
      var mount = D.WALL_MOUNTS[m]
      paintMountCell(ctx, m, null, null)
      cells['mount/' + mount.id] = {
        x: m * CELL_W + (CELL_W - 24) / 2,
        y: 5 * CELL_H + (CELL_H - 24) / 2,
        w: 24,
        h: 24,
      }
    }

    // 高亮菱形 + 家具落影：第 7 行
    var hlY = 6 * CELL_H + (CELL_H - 48) / 2
    paintHighlight(ctx, 0, hlY, true)
    cells['hl/ok'] = { x: 0, y: hlY, w: 96, h: 48 }
    paintHighlight(ctx, CELL_W, hlY, false)
    cells['hl/bad'] = { x: CELL_W, y: hlY, w: 96, h: 48 }
    paintShadow(ctx, CELL_W * 2, hlY)
    cells['fx/shadow'] = { x: CELL_W * 2, y: hlY, w: 96, h: 48 }

    // 通用装饰：跨 5 套共用同一套中性配色，所以只画一份（从第 8 行起）
    for (var x = 0; x < D.EXTRAS.length; x++) {
      var ex = D.EXTRAS[x]
      var exW = ex.sprite[0]
      var exH = ex.sprite[1]
      var exX = (x % COLS) * CELL_W + (CELL_W - exW) / 2
      var exY = (7 + Math.floor(x / COLS)) * CELL_H + (CELL_H - exH)
      var exData = PIXELS ? PIXELS['x/' + ex.id] : null
      if (exData && exData.palette && exData.rows && exData.w === exW && exData.h === exH) {
        paintFromPixels(ctx, exData, exX, exY)
      } else {
        // 素材还没生成：画个灰框占位，一眼能看出缺图，而不是静默空白
        rect(ctx, exX, exY, exW, exH, '#2A2118')
        ctx.strokeStyle = '#5A4A38'
        ctx.lineWidth = 1
        ctx.strokeRect(exX + 0.5, exY + 0.5, exW - 1, exH - 1)
      }
      cells['x/' + ex.id] = { x: exX, y: exY, w: exW, h: exH }
    }

    // paintMountSlot：让 view 层在玩家换挂件时只重画一格，再由后端重传纹理
    return {
      atlas: atlas,
      cells: cells,
      rooms: rooms,
      backdrop: paintBackdrop(),
      ensureRoom: ensureRoom,
      paintMountSlot: function (index, flatGrid, color) {
        paintMountCell(ctx, index, flatGrid, color)
      },
    }
  }

  var API = { build: build, CELL_W: CELL_W, CELL_H: CELL_H }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHomeAtlas = API
})(typeof window !== 'undefined' ? window : globalThis)
