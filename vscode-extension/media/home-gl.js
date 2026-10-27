'use strict'
// home-gl.js — 小屋的 WebGL2 渲染后端
//
// 只做一件事：把 home-scene 产出的 drawList 画出来。不掺任何业务逻辑。
// 没有 GPU 时（用户关了硬件加速 / 虚拟机软渲染 / 驱动黑名单）create() 返回 null，
// 由 home-2d.js 顶上，两边的 draw 签名完全一致。
//
// 为什么手写不用 three.js：
//   小屋需要的只是「一堆带 UV 的四边形」，three.js 压缩后 150KB+，
//   会撑破官网 ≤+200KB 的硬线；而且它自带的相机/场景图在这里全是负担。

;(function (root) {
  var VS = [
    '#version 300 es',
    'in vec2 a_unit;',
    'uniform vec4 u_rect;', // x, y, w, h（世界像素）
    'uniform vec4 u_uv;', // u0, v0, u1, v1
    'uniform vec2 u_canvas;', // 画布 CSS 尺寸
    'uniform vec2 u_pan;',
    'uniform float u_zoom;',
    'out vec2 v_uv;',
    'out vec2 v_screen;',
    'void main(){',
    '  vec2 world = u_rect.xy + a_unit * u_rect.zw;',
    '  vec2 screen = world * u_zoom + u_canvas * 0.5 + u_pan;',
    '  vec2 clip = vec2(screen.x / u_canvas.x * 2.0 - 1.0, 1.0 - screen.y / u_canvas.y * 2.0);',
    '  gl_Position = vec4(clip, 0.0, 1.0);',
    '  v_uv = mix(u_uv.xy, u_uv.zw, a_unit);',
    '  v_screen = screen / u_canvas;',
    '}',
  ].join('\n')

  var FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 v_uv;',
    'in vec2 v_screen;',
    'uniform sampler2D u_tex;',
    'uniform float u_alpha;',
    'uniform vec3 u_tint;',
    'uniform float u_tintAmt;',
    'uniform vec2 u_lightPos;',
    'uniform vec3 u_lightColor;',
    'out vec4 outColor;',
    'void main(){',
    '  vec4 c = texture(u_tex, v_uv);',
    '  if (c.a < 0.02) discard;',
    '  c.rgb = mix(c.rgb, u_tint, u_tintAmt);',
    // 一次径向衰减当灯光：没有阴影贴图，效果够用且几乎零成本
    '  float d = distance(v_screen, u_lightPos);',
    '  float k = smoothstep(0.85, 0.05, d);',
    // 0.06：太高会让整屋偏黄、和 canvas2d 兜底的观感拉开差距（实测差 10% 以上）
    '  c.rgb += u_lightColor * k * 0.06;',
    '  outColor = vec4(c.rgb, c.a * u_alpha);',
    '}',
  ].join('\n')

  function compile(gl, type, src) {
    var sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh)
      gl.deleteShader(sh)
      throw new Error('shader: ' + log)
    }
    return sh
  }

  function create(canvas, atlas) {
    var gl = null
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      })
    } catch (e) {
      gl = null
    }
    if (!gl) return null

    var prog = null
    var vao = null
    var quadBuf = null
    var uniforms = {}
    var objTex = null
    var roomTex = {}
    var cw = 1
    var ch = 1
    var lost = false

    function initResources() {
      var vs = compile(gl, gl.VERTEX_SHADER, VS)
      var fs = compile(gl, gl.FRAGMENT_SHADER, FS)
      prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(prog))
      }
      gl.useProgram(prog)

      // unit quad：两个三角形，a_unit ∈ [0,1]²
      var quad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1])
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      quadBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
      var loc = gl.getAttribLocation(prog, 'a_unit')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

      ;['u_rect', 'u_uv', 'u_canvas', 'u_pan', 'u_zoom', 'u_tex', 'u_alpha', 'u_tint', 'u_tintAmt', 'u_lightPos', 'u_lightColor'].forEach(
        function (n) {
          uniforms[n] = gl.getUniformLocation(prog, n)
        }
      )

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.clearColor(0, 0, 0, 0)

      objTex = texFromCanvas(atlas.atlas)
      roomTex = {}
      for (var id in atlas.rooms) {
        if (Object.prototype.hasOwnProperty.call(atlas.rooms, id)) {
          roomTex[id] = texFromCanvas(atlas.rooms[id])
        }
      }
    }

    function texFromCanvas(cv) {
      var t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    }

    // 图集里的像素矩形 → UV。
    // 顶点着色器里 v_uv = mix(u_uv.xy, u_uv.zw, a_unit)，而 a_unit 的 (0,0) 是矩形**左上角**，
    // 所以 xy 必须给「左 + 上边对应的 V」。flipY 上传后 canvas 的 y 越小 V 越大，
    // 因此上边 V = 1 - y/H、下边 V = 1 - (y+h)/H。
    // （这里写反过一次，结果是所有家具上下颠倒 —— 房间用的是手写 UV 所以侥幸没露馅。）
    function uvOf(rect, srcW, srcH) {
      return [
        rect.x / srcW,
        1 - rect.y / srcH,
        (rect.x + rect.w) / srcW,
        1 - (rect.y + rect.h) / srcH,
      ]
    }

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault()
      lost = true
    })
    canvas.addEventListener('webglcontextrestored', function () {
      try {
        initResources()
        lost = false
      } catch (err) {
        lost = true
      }
    })

    try {
      initResources()
    } catch (e) {
      return null
    }

    var atlasW = atlas.atlas.width
    var atlasH = atlas.atlas.height

    return {
      name: 'webgl2',
      ok: true,

      resize: function (cssW, cssH, dpr) {
        cw = Math.max(1, cssW)
        ch = Math.max(1, cssH)
        var w = Math.round(cw * dpr)
        var h = Math.round(ch * dpr)
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        gl.viewport(0, 0, w, h)
      },

      // view: { zoom, panX, panY, lightX, lightY, lightColor }
      draw: function (drawList, view) {
        if (lost || !prog) return
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(prog)
        gl.bindVertexArray(vao)
        gl.uniform2f(uniforms.u_canvas, cw, ch)
        gl.uniform2f(uniforms.u_pan, view.panX, view.panY)
        gl.uniform1f(uniforms.u_zoom, view.zoom)
        gl.uniform2f(uniforms.u_lightPos, view.lightX, view.lightY)
        gl.uniform3fv(uniforms.u_lightColor, view.lightColor || [1, 0.82, 0.55])

        for (var i = 0; i < drawList.length; i++) {
          var d = drawList[i]
          var uv
          if (d.kind === 'room') {
            // room 的 key 是「地板系列|墙纸系列」，直接当纹理表键
            var rt = roomTex[d.key]
            if (!rt) continue
            gl.bindTexture(gl.TEXTURE_2D, rt)
            uv = [0, 1, 1, 0]
          } else {
            var cell = atlas.cells[d.key]
            if (!cell) continue
            gl.bindTexture(gl.TEXTURE_2D, objTex)
            uv = uvOf(cell, atlasW, atlasH)
          }
          gl.uniform4f(uniforms.u_rect, d.rect.x, d.rect.y, d.rect.w, d.rect.h)
          gl.uniform4f(uniforms.u_uv, uv[0], uv[1], uv[2], uv[3])
          gl.uniform1f(uniforms.u_alpha, typeof d.alpha === 'number' ? d.alpha : 1)
          // 拖动中的物件提亮 10%，其余不做任何 tint
          var tintAmt = d.ghost ? 0.12 : 0
          gl.uniform3f(uniforms.u_tint, 1, 0.93, 0.8)
          gl.uniform1f(uniforms.u_tintAmt, tintAmt)
          gl.drawArrays(gl.TRIANGLES, 0, 6)
        }
      },

      // 房间底图是按「地板系列|墙纸系列」按需生成的，新组合要单独上传一张纹理。
      setRoom: function (key, canvas) {
        if (lost || !canvas) return
        if (roomTex[key]) {
          gl.bindTexture(gl.TEXTURE_2D, roomTex[key])
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
          return
        }
        roomTex[key] = texFromCanvas(canvas)
      },

      // 挂点内容变化后调用：整张图集重新上传（256KB 级别，几毫秒，只在上墙/换件时发生）。
      // 不做局部 texSubImage2D 是因为图集行内布局由 atlas 决定，整传更不容易错位。
      reuploadAtlas: function (atlasCanvas) {
        if (lost || !objTex || !atlasCanvas) return
        gl.bindTexture(gl.TEXTURE_2D, objTex)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas)
      },

      dispose: function () {
        lost = true
        try {
          if (objTex) gl.deleteTexture(objTex)
          for (var id in roomTex) {
            if (Object.prototype.hasOwnProperty.call(roomTex, id)) gl.deleteTexture(roomTex[id])
          }
          if (quadBuf) gl.deleteBuffer(quadBuf)
          if (vao) gl.deleteVertexArray(vao)
          if (prog) gl.deleteProgram(prog)
        } catch (e) {
          /* 上下文已经没了就没什么可删的 */
        }
      },
    }
  }

  var API = { create: create }
  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHomeGL = API
})(typeof window !== 'undefined' ? window : globalThis)
