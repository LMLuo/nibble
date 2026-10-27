'use strict'
// home-2d.js — 小屋的 canvas2d 兜底后端
//
// 与 home-gl.js 的 create/draw 签名完全一致，view 层用哪个后端都不需要改。
// 存在意义：VS Code / CodeBuddy 的 webview 在关掉硬件加速、虚拟机软渲染、
// 显卡驱动黑名单等情况下拿不到 webgl2，这时小屋必须还能用。
//
// 等距渲染本质就是「按深度顺序画图」，用 drawImage 完全做得到 ——
// 只是没有 shader 的那层灯光，观感会平一点，功能一点不少。

;(function (root) {
  function create(canvas, atlas) {
    var ctx = null
    try {
      ctx = canvas.getContext('2d')
    } catch (e) {
      return null
    }
    if (!ctx) return null

    var cw = 1
    var ch = 1
    var dpr = 1

    return {
      name: 'canvas2d',
      ok: true,

      resize: function (cssW, cssH, ratio) {
        cw = Math.max(1, cssW)
        ch = Math.max(1, cssH)
        dpr = ratio || 1
        var w = Math.round(cw * dpr)
        var h = Math.round(ch * dpr)
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.imageSmoothingEnabled = false
      },

      // view: { zoom, panX, panY, lightX, lightY, lightColor }
      draw: function (drawList, view) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cw, ch)
        var zoom = view.zoom || 1
        var ox = cw / 2 + (view.panX || 0)
        var oy = ch / 2 + (view.panY || 0)

        for (var i = 0; i < drawList.length; i++) {
          var d = drawList[i]
          var src = null
          var sx = 0
          var sy = 0
          var sw = 0
          var sh = 0

          if (d.kind === 'room') {
            src = atlas.rooms[d.key]
            if (!src) continue
            sx = 0
            sy = 0
            sw = src.width
            sh = src.height
          } else {
            var cell = atlas.cells[d.key]
            if (!cell) continue
            src = atlas.atlas
            sx = cell.x
            sy = cell.y
            sw = cell.w
            sh = cell.h
          }

          // 世界像素 → 屏幕像素：整数取整，避免像素图被半像素采样糊掉
          var dx = Math.round(d.rect.x * zoom + ox)
          var dy = Math.round(d.rect.y * zoom + oy)
          var dw = Math.round(d.rect.w * zoom)
          var dh = Math.round(d.rect.h * zoom)

          var alpha = typeof d.alpha === 'number' ? d.alpha : 1
          if (alpha !== 1) ctx.globalAlpha = alpha
          ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)
          if (alpha !== 1) ctx.globalAlpha = 1

          // 拖动中的物件叠一层暖色提亮，跟 GL 后端的 tint 对齐
          if (d.ghost) {
            ctx.globalCompositeOperation = 'source-atop'
            ctx.fillStyle = 'rgba(255,237,204,0.12)'
            ctx.fillRect(dx, dy, dw, dh)
            ctx.globalCompositeOperation = 'source-over'
          }
        }
      },

      // 2D 后端直接 drawImage 同一张 canvas，重画后立刻生效，无需额外动作。
      // 保留这个空实现是为了让 view 层不必区分后端类型。
      reuploadAtlas: function () {},

      dispose: function () {
        ctx = null
      },
    }
  }

  var API = { create: create }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHome2D = API
})(typeof window !== 'undefined' ? window : globalThis)
