/* ============================================================================
   site.js —— 官网交互脚本（无依赖）
   1) 点阵标题：把 data-pt 的英文用 SVG 像素字画出来（未启用 JS 时退化为等宽文字）
   2) 演示驱动：官网没有扩展宿主，这里扮演"扩展"，给 pet.js 喂与 IDE 里完全相同的消息
      （state / tick / drop / arsenalData / bestiaryData），数值公式照抄
      plugins/nibble/hooks/nibble.js，改玩法请先改那边、再同步这里。
   3) 小交互：复制命令、导航高亮、怪物名单点击跳到演示
   ========================================================================== */
'use strict'
;(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) document.documentElement.setAttribute('data-motion', 'reduce')

  // 滚出视口的段落会被 buildIdle() 挂上 data-idle：CSS 冻结那里的动画，自走定时器也跟着停
  // （定时器不像 CSS 动画那样能被 animation-play-state 管住，要各自判一下）
  function asleepIn(el) {
    return document.hidden || !!(el && el.closest && el.closest('[data-idle]'))
  }

  /* ------------------------------------------------------------ 1) 点阵标题 */
  // 5x7 像素字模；'#' = 实心像素。只用于英文标签与品牌名。
  const FONT = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
    H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
    J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
    R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
    '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
    // 代码符号：给背景里飘的"代码像素"用
    '{': ['..##.', '.#...', '.#...', '#....', '.#...', '.#...', '..##.'],
    '}': ['.##..', '...#.', '...#.', '....#', '...#.', '...#.', '.##..'],
    '(': ['..##.', '.#...', '.#...', '.#...', '.#...', '.#...', '..##.'],
    ')': ['.##..', '...#.', '...#.', '...#.', '...#.', '...#.', '.##..'],
    ';': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.#...'],
    '<': ['...##', '..#..', '.#...', '#....', '.#...', '..#..', '...##'],
    '>': ['##...', '..#..', '...#.', '....#', '...#.', '..#..', '##...'],
    '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
    '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
    '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
    '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  }
  const GW = 5
  const GH = 7

  function pixelType(el) {
    const text = (el.dataset.pt || el.textContent || '').toUpperCase()
    const glyphs = [...text].map((ch) => FONT[ch] || FONT[' '])
    const width = glyphs.length * (GW + 1) - 1
    const rects = []
    glyphs.forEach((rows, i) => {
      const ox = i * (GW + 1)
      rows.forEach((row, y) => {
        let x = 0
        while (x < GW) {
          if (row[x] !== '#') { x++; continue }
          let run = 1
          while (row[x + run] === '#') run++
          rects.push('<rect x="' + (ox + x) + '" y="' + y + '" width="' + run + '" height="1"/>')
          x += run
        }
      })
    })
    el.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + GH + '" shape-rendering="crispEdges" role="img" aria-label="' + text +
      '" style="width:calc(' + width + ' * var(--u));height:calc(' + GH + ' * var(--u))">' + rects.join('') + '</svg>'
  }
  document.querySelectorAll('[data-pt]').forEach(pixelType)
  // 画一个点阵词（复用于页脚营地的 zzz）
  function pixelSvgNode(text, unit) {
    const glyphs = [...text.toUpperCase()].map((ch) => FONT[ch] || FONT[' '])
    const width = glyphs.length * (GW + 1) - 1
    const svg = makeSvg(width, GH)
    glyphs.forEach((rows, i) =>
      rows.forEach((row, y) => {
        let x = 0
        while (x < GW) {
          if (row[x] !== '#') { x++; continue }
          let run = 1
          while (row[x + run] === '#') run++
          const r = document.createElementNS(NS, 'rect')
          r.setAttribute('x', i * (GW + 1) + x)
          r.setAttribute('y', y)
          r.setAttribute('width', run)
          r.setAttribute('height', 1)
          svg.appendChild(r)
          x += run
        }
      }),
    )
    svg.style.width = 'calc(' + width + ' * ' + unit + 'px)'
    svg.style.height = 'calc(' + GH + ' * ' + unit + 'px)'
    return svg
  }

  /* ------------------------------------------------------------ 1.5) 像素场景
     首屏夜空与页脚营地的所有画面都是现画的（SVG 像素块 / canvas 逐像素），
     不引任何图片；单位 = 1 CSS px，天然像素对齐。数据只借用 demo-data.js 里
     拾玖的真网格（和扩展里同一份）。 */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const NS = 'http://www.w3.org/2000/svg'
  function makeSvg(w, h) {
    const s = document.createElementNS(NS, 'svg')
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + h)
    s.setAttribute('width', w)
    s.setAttribute('height', h)
    s.setAttribute('shape-rendering', 'crispEdges')
    s.setAttribute('aria-hidden', 'true')
    s.style.height = h + 'px'
    return s
  }
  function px(parent, x, y, w, h, fill, opacity, cls) {
    const r = document.createElementNS(NS, 'rect')
    r.setAttribute('x', Math.round(x))
    r.setAttribute('y', Math.round(y))
    r.setAttribute('width', Math.max(1, Math.round(w)))
    r.setAttribute('height', Math.max(1, Math.round(h)))
    r.setAttribute('fill', fill)
    if (opacity != null) r.setAttribute('opacity', opacity)
    if (cls) r.setAttribute('class', cls)
    parent.appendChild(r)
    return r
  }
  // 阶梯地形：逐列高度 → 一条 path（同高列自动合并，节点极少）
  function ridgePath(hs, base) {
    let d = 'M0 ' + base
    let cur = base
    for (let i = 0; i < hs.length; i++) {
      const y = base - hs[i]
      if (y !== cur) { d += ' H' + i + ' V' + y; cur = y }
    }
    return d + ' H' + hs.length + ' V' + base + ' Z'
  }
  function newDiv(cls, parent) {
    const el = document.createElement('div')
    el.className = cls
    if (parent) parent.appendChild(el)
    return el
  }
  // 压缩网格（palette + base36 rows）→ 576 长度扁平色值
  function decodePlain(sp) {
    if (!sp) return null
    const out = new Array(576)
    for (let r = 0; r < 24; r++) {
      const row = sp.rows[r] || ''
      for (let c = 0; c < 24; c++) {
        const ch = row[c]
        out[r * 24 + c] = ch && ch !== '.' ? sp.palette[parseInt(ch, 36)] || null : null
      }
    }
    return out
  }
  // 把 24x24 网格画进 canvas（整像素，配合 CSS image-rendering: pixelated 放大）
  function paintGrid(cv, grid, dy) {
    const ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, 24, 24)
    if (!grid) return
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        const col = grid[r * 24 + c]
        if (!col) continue
        ctx.fillStyle = col
        ctx.fillRect(c, r + (dy || 0), 1, 1)
      }
    }
  }
  let skyLayers = []
  let skyRaf = 0
  window.addEventListener(
    'scroll',
    () => {
      if (skyRaf || !skyLayers.length) return
      skyRaf = window.requestAnimationFrame(() => {
        skyRaf = 0
        const y = Math.min(window.scrollY, window.innerHeight)
        skyLayers.forEach(([el, k]) => el.style.setProperty('--py', Math.round(y * k) + 'px'))
      })
    },
    { passive: true },
  )

  function buildSky() {
    const root = document.getElementById('heroScene')
    if (!root) return
    const W = Math.max(360, Math.round(root.clientWidth))
    const H = Math.max(360, Math.round(root.clientHeight))
    const rnd = mulberry32(20261012)
    root.textContent = ''

    ;['sky-b1', 'sky-b2', 'sky-b3', 'sky-b4'].forEach((c) => newDiv(c, root))
    ;['dz-12', 'dz-23', 'dz-34', 'dz-4g'].forEach((c) => newDiv('dz ' + c, root))
    newDiv('glow', root)
    // 三层雾带：不同速度漂移，压在地形之前，拉开纵深
    newDiv('fog fog-1', root)
    newDiv('fog fog-2', root)
    newDiv('fog fog-3', root)
    // 地面色阶（天空→地面的过渡）
    newDiv('ground', root)

    // 星（三组不同节奏地闪，提亮后更明显）
    const stars = makeSvg(W, Math.round(H * 0.62))
    stars.setAttribute('class', 'stars')
    for (let i = 0, n = Math.round(W / 10); i < n; i++) {
      const big = rnd() < 0.16
      const s = 1 + Math.floor(rnd() * 3)
      px(stars, rnd() * W, rnd() * H * 0.48, big ? 2 : 1, big ? 2 : 1, big ? '#FFFFFF' : '#CFE1FF', big ? 1 : 0.85, 's' + s)
    }
    root.appendChild(stars)

    // 远景"代码塔"天际线：塔身比天空暗一点，窗口按三组节奏亮灭
    const towers = makeSvg(W, 80)
    towers.setAttribute('class', 'towers')
    for (let i = 0, n = Math.round(W / 58); i < n; i++) {
      const w = 3 + Math.floor(rnd() * 4)
      const x = Math.round(rnd() * (W - w))
      const h = 14 + Math.floor(rnd() * 46)
      px(towers, x, 80 - h, w, h, '#131E36')
      for (let k = 0, kn = 1 + Math.floor(rnd() * 3); k < kn; k++) {
        px(
          towers,
          x + 1,
          80 - h + 3 + Math.floor(rnd() * Math.max(2, h - 6)),
          1,
          1,
          rnd() < 0.62 ? '#7FE3DA' : '#FFD9A8',
          0.55,
          'w' + Math.floor(rnd() * 3),
        )
      }
    }
    root.appendChild(towers)

    // 山脊
    const ridge = makeSvg(W, 52)
    ridge.setAttribute('class', 'ridge')
    const rh = []
    for (let x = 0; x < W; x++) {
      const v = 20 + 9 * Math.sin(x / 97 + 0.6) + 6 * Math.sin(x / 37 + 2.1) + 3 * Math.sin(x / 13 + 1.2)
      rh.push(Math.max(4, Math.round(v / 3) * 3))
    }
    const rp = document.createElementNS(NS, 'path')
    rp.setAttribute('d', ridgePath(rh, 52))
    // 用 style.fill 而不是 fill 属性：属性吃不了 var()，这样山脊就能跟着「滚动即一天」换色
    rp.style.fill = 'var(--ridge)'
    ridge.appendChild(rp)
    root.appendChild(ridge)

    // 丘陵
    const hills = makeSvg(W, 44)
    hills.setAttribute('class', 'hills')
    const hh = []
    for (let x = 0; x < W; x++) {
      const v = 15 + 7 * Math.sin(x / 61 + 2.4) + 4 * Math.sin(x / 23 + 0.3) + 2 * Math.sin(x / 9 + 1.9)
      hh.push(Math.max(3, Math.round(v / 2) * 2))
    }
    const hp = document.createElementNS(NS, 'path')
    hp.setAttribute('d', ridgePath(hh, 44))
    hp.style.fill = 'var(--hill)'
    hills.appendChild(hp)
    root.appendChild(hills)

    // 近景草丛（尖端带一点青光）
    const grass = makeSvg(W, 18)
    grass.setAttribute('class', 'grass')
    for (let i = 0, n = Math.round(W / 15); i < n; i++) {
      const x = Math.round(rnd() * W)
      const cnt = 2 + Math.floor(rnd() * 4)
      for (let k = 0; k < cnt; k++) {
        const h = 3 + Math.floor(rnd() * 6)
        px(grass, x + k * 2, 18 - h, 1, h, '#172437')
        px(grass, x + k * 2, 18 - h, 1, 1, k % 2 ? '#4ecdc4' : '#8FE3D8', k % 2 ? 0.5 : 0.3)
      }
    }
    root.appendChild(grass)

    // 飘浮的代码像素：给背景一点"正在写代码"的题材感
    const glyphLayer = newDiv('glyphs', root)
    const GLYPHS = ['{', '}', '(', ')', ';', '<', '>', '/', '=', '*', '+']
    for (let i = 0; i < 16; i++) {
      const g = document.createElement('i')
      g.style.setProperty('--x', Math.round(2 + rnd() * 92) + '%')
      g.style.setProperty('--y', Math.round(4 + rnd() * 44) + '%')
      g.style.setProperty('--d', (9 + rnd() * 10).toFixed(1) + 's')
      g.style.setProperty('--t', (-rnd() * 18).toFixed(1) + 's')
      if (rnd() < 0.35) g.style.setProperty('--c', '#FFD9A8')
      g.appendChild(pixelSvgNode(GLYPHS[Math.floor(rnd() * GLYPHS.length)], 2))
      glyphLayer.appendChild(g)
    }

    // 扫描线：每 9 秒从天上扫过一次
    newDiv('scan', root)

    skyLayers = [
      [towers, -0.05],
      [ridge, -0.09],
      [hills, -0.14],
      [grass, -0.2],
    ]

    // 大气微粒
    const dust = newDiv('dust', root)
    for (let i = 0; i < 22; i++) {
      const s = document.createElement('i')
      s.style.setProperty('--x', Math.round(rnd() * 100) + '%')
      s.style.setProperty('--d', (7 + rnd() * 8).toFixed(2) + 's')
      s.style.setProperty('--t', (-rnd() * 12).toFixed(2) + 's')
      dust.appendChild(s)
    }

    // 流星：随机隔几秒划一次
    const meteor = newDiv('meteor', root)
    if (!reduce) {
      const shoot = () => {
        meteor.style.setProperty('--y', (4 + Math.random() * 24).toFixed(1) + '%')
        meteor.classList.remove('on')
        void meteor.offsetWidth
        meteor.classList.add('on')
        window.setTimeout(shoot, 6500 + Math.random() * 9000)
      }
      window.setTimeout(shoot, 2600)
    }
  }
  buildSky()
  let resizeTimer = 0
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(buildSky, 200)
  })

  // 段落地形边：用下一段的底色画一条锯齿，伸进上一段，视觉上像"地形切开"
  function buildEdges() {
    document.querySelectorAll('#how, #bugs, #look, #shijiu, #install, #privacy, #support').forEach((sec) => {
      const W = Math.max(320, Math.round(sec.clientWidth))
      const svg = makeSvg(W, 8)
      svg.setAttribute('class', 'sec-edge')
      const hs = []
      for (let x = 0; x < W; x++) {
        const v = 3 + 2.5 * Math.sin(x / 47 + 1.1) + 1.8 * Math.sin(x / 17 + 2.2)
        hs.push(Math.max(1, Math.round(v / 2) * 2))
      }
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', ridgePath(hs, 8))
      p.setAttribute('fill', getComputedStyle(sec).backgroundColor)
      svg.appendChild(p)
      sec.appendChild(svg)
    })
  }
  buildEdges()

  // 页脚营地：篝火（6 帧循环）+ 睡觉的拾玖（真像素网格 + 呼吸）+ 火星
  function buildCamp() {
    const root = document.getElementById('camp')
    if (!root) return
    root.textContent = ''
    const glow = newDiv('fireglow', root)
    void glow
    newDiv('logart', root)
    // 营地上方的星空（和首屏同一套做法，只是更疏）
    const W = Math.max(320, Math.round(root.clientWidth))
    const sky = makeSvg(W, 60)
    sky.setAttribute('class', 'campstars')
    const rnd = mulberry32(77)
    for (let i = 0, n = Math.round(W / 40); i < n; i++) {
      px(sky, rnd() * W, rnd() * 56, 1, rnd() < 0.2 ? 2 : 1, rnd() < 0.7 ? '#9fb8d8' : '#ffd9a0', 0.7, 's' + (1 + Math.floor(rnd() * 3)))
    }
    root.appendChild(sky)

    const dog = document.createElement('canvas')
    dog.className = 'dog'
    dog.width = 24
    dog.height = 24
    const fire = document.createElement('canvas')
    fire.className = 'fire'
    fire.width = 16
    fire.height = 16
    root.appendChild(dog)
    root.appendChild(fire)
    newDiv('zzz', root).appendChild(pixelSvgNode('Z', 2))
    newDiv('zzz zzz2', root).appendChild(pixelSvgNode('Z', 2))
    const sparks = newDiv('sparks', root)

    const grid = window.NIBBLE_DEMO ? decodePlain(window.NIBBLE_DEMO.player) : null
    let breath = 0
    paintGrid(dog, grid, 0)
    if (!reduce && grid) {
      window.setInterval(() => {
        breath = breath ? 0 : 1
        paintGrid(dog, grid, breath)
      }, 1200)
    }

    // 火焰：逐列高度 + 按高度分层上色，6 帧循环（≈5.5fps，和像素游戏一致）
    const FIRE = ['#B4482E', '#FF6B6B', '#FFB86B', '#FFE066', '#FFF6D8']
    const fireFrame = (f) => {
      const ctx = fire.getContext('2d')
      ctx.clearRect(0, 0, 16, 16)
      ctx.fillStyle = '#4A3326'
      ctx.fillRect(2, 15, 12, 1)
      for (let x = 2; x < 14; x++) {
        const cx = Math.abs(x - 7.5) / 5.5
        let h = Math.round(12 * (1 - cx * cx * 0.8) * (1 - 0.14 * Math.sin(f * 1.1 + x * 0.9)))
        h = Math.max(1, Math.min(12, h + ((x + f) % 2 ? 1 : 0)))
        for (let y = 0; y < h; y++) {
          const t = y / h
          ctx.fillStyle = FIRE[t < 0.16 ? 4 : t < 0.38 ? 3 : t < 0.66 ? 2 : t < 0.9 ? 1 : 0]
          ctx.fillRect(x, 14 - y, 1, 1)
        }
      }
    }
    fireFrame(0)
    if (!reduce) {
      let f = 0
      window.setInterval(() => fireFrame(++f % 6), 180)
    }

    const sl = []
    for (let i = 0; i < 5; i++) sl.push(document.createElement('i'))
    sl.forEach((s) => sparks.appendChild(s))
    if (!reduce) {
      window.setInterval(() => {
        const s = sl[Math.floor(Math.random() * sl.length)]
        s.style.setProperty('--sx', (Math.random() * 26 - 13).toFixed(0) + 'px')
        s.classList.remove('on')
        void s.offsetWidth
        s.classList.add('on')
      }, 620)
    }
  }
  buildCamp()

  // #bugs 段底：拾玖和几只真怪物站在地平线上（像素图同样是仓库真数据）
  function buildActors() {
    const sec = document.getElementById('bugs')
    const D = window.NIBBLE_DEMO
    if (!sec || !D || !D.enemies || !D.enemies.length) return
    const W = Math.max(320, Math.round(sec.clientWidth))
    const box = newDiv('horizon', sec)

    const lay = makeSvg(W, 40)
    lay.setAttribute('class', 'lay')
    const hs = []
    for (let x = 0; x < W; x++) {
      const v = 7 + 5 * Math.sin(x / 83 + 0.4) + 3 * Math.sin(x / 29 + 2.2)
      hs.push(Math.max(2, Math.round(v / 2) * 2))
    }
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', ridgePath(hs, 40))
    p.setAttribute('fill', '#151c2b')
    lay.appendChild(p)
    box.appendChild(lay)
    newDiv('line', box)

    const row = newDiv('row', box)
    const dog = window.NIBBLE_DEMO.player ? decodePlain(window.NIBBLE_DEMO.player) : null
    if (dog) {
      const a = document.createElement('span')
      a.className = 'actor dog bob'
      a.title = 'Nibble（拾玖）'
      const cv = document.createElement('canvas')
      cv.width = 24
      cv.height = 24
      paintGrid(cv, dog, 0)
      a.appendChild(cv)
      row.appendChild(a)
    }
    // 三档轮流取，保证画面上小怪/精英/头目都露脸；顺序固定，每次刷新一样
    const byTier = { common: [], elite: [], boss: [] }
    D.enemies.forEach((e) => byTier[e.tier] && byTier[e.tier].push(e))
    const picks = []
    ;[['common', 0], ['common', 5], ['elite', 1], ['common', 11], ['boss', 2], ['elite', 6], ['common', 17]].forEach(
      ([t, i]) => {
        const pool = byTier[t]
        if (pool && pool.length) picks.push(pool[i % pool.length])
      },
    )
    picks.forEach((e, i) => {
      const a = document.createElement('span')
      a.className = 'actor bob'
      a.title = e.name + '（' + e.tierLabel + (e.mechText ? ' · ' + e.mechText : '') + '）'
      a.style.animationDelay = (i * 0.29).toFixed(2) + 's'
      const cv = document.createElement('canvas')
      cv.width = 24
      cv.height = 24
      paintGrid(cv, decodePlain(e.sprite), 0)
      a.appendChild(cv)
      row.appendChild(a)
    })
  }
  buildActors()

  // #bugs 地平线：每隔几秒，随机一只怪物从草里探出头（呼应的正是"它在草里沙沙动"的设定）。
  // 它是这一段的彩蛋，尺寸比站着的队伍更大（见 .ruster 的 --rs），所以定位必须按"自己的宽度"算，
  // 否则放大的怪会被视口裁掉半只（原来的百分比定位在手机上就有这个毛病）。
  let rustleTimer = 0
  let rustleIo = null
  function buildRustle() {
    const horizon = document.querySelector('.horizon')
    const D = window.NIBBLE_DEMO
    if (!horizon || !D || !D.enemies || !D.enemies.length) return
    const old = horizon.querySelector('.ruster')
    if (old) old.remove()
    const box = newDiv('ruster', horizon)
    const cv = document.createElement('canvas')
    cv.width = 24
    cv.height = 24
    box.appendChild(cv)
    newDiv('mark', box) // 头顶的像素感叹号
    const pop = () => {
      if (asleepIn(horizon)) return // 段落滚出视口就不画（画了也没人看）
      const e = D.enemies[Math.floor(Math.random() * D.enemies.length)]
      paintGrid(cv, decodePlain(e.sprite), 0)
      // 只在两端探头，避免和地平线上的固定队伍挤在一起
      const bw = box.offsetWidth || 0
      const hw = horizon.clientWidth || 0
      const room = Math.max(0, Math.min(56, hw * 0.14))
      const left = Math.random() < 0.5 ? 8 + Math.random() * room : hw - bw - 8 - Math.random() * room
      box.style.setProperty('--rx', Math.round(Math.max(4, left)) + 'px')
      box.style.setProperty('--c', (D.meta.tierColor && D.meta.tierColor[e.tier]) || '#8FA3B8')
      box.title = e.name + (e.tierLabel ? '（' + e.tierLabel + '）' : '') + (e.mechText ? ' · ' + e.mechText : '')
      box.classList.add('up')
      window.setTimeout(() => box.classList.remove('up'), 3600)
    }
    window.clearInterval(rustleTimer)
    if (rustleIo) rustleIo.disconnect()
    rustleIo = null
    if (reduce) return
    // 一滑到这一段就先来一只（不然可能要干等满 9 秒才见到彩蛋），之后每 9 秒一只
    if ('IntersectionObserver' in window) {
      rustleIo = new IntersectionObserver(
        (ens) => {
          if (ens[0] && ens[0].isIntersecting) window.setTimeout(pop, 700)
        },
        { threshold: 0.35 },
      )
      rustleIo.observe(horizon)
    } else {
      window.setTimeout(pop, 2600)
    }
    rustleTimer = window.setInterval(pop, 9000)
  }
  buildRustle()

  // 每段一个主题场景：装置摆在上下边缘（不压内容），颜色跟各段"地方"走
  function buildScenes() {
    // 插在段落最前面：这样它一定在 .horizon / .sec-edge 这些后来居上的装置之下
    const makeBg = (sel) => {
      const sec = document.querySelector(sel)
      if (!sec) return null
      const bg = newDiv('bg')
      sec.insertBefore(bg, sec.firstChild)
      newDiv('wash', bg) // 主题光晕（冷暖由各段的 --wash 决定）
      return { sec: sec, bg: bg }
    }

    // 1) #how 编辑器房：像素网格地面（飘浮的代码像素沿用首屏那套装置）
    const how = makeBg('#how')
    if (how) {
      newDiv('grid', how.bg)
      newDiv('gridline', how.bg)
    }

    // 2) #bugs 夜里草地：顶部树影 + 26 只萤火虫
    const bugs = makeBg('#bugs')
    if (bugs) {
      const w = Math.max(320, Math.round(bugs.sec.clientWidth))
      const CH = 156 // 树冠高度（makeSvg 会写成内联高度，所以这里和 CSS 必须一致）
      const canopy = makeSvg(w, CH)
      canopy.setAttribute('class', 'canopy')
      const hs = []
      for (let x = 0; x < w; x++) {
        const v = 74 + 44 * Math.sin(x / 71 + 0.7) + 26 * Math.sin(x / 23 + 2.5) + 16 * Math.sin(x / 9 + 1.1)
        hs.push(Math.max(10, Math.round(v / 3) * 3))
      }
      const cp = document.createElementNS(NS, 'path')
      cp.setAttribute('d', ridgePath(hs, CH))
      cp.setAttribute('fill', '#060D12')
      canopy.appendChild(cp)
      // 树冠边缘一条月光高光
      const rim = document.createElementNS(NS, 'path')
      rim.setAttribute('d', ridgePath(hs, CH))
      rim.setAttribute('fill', 'none')
      rim.setAttribute('stroke', '#7FE3DA')
      rim.setAttribute('stroke-width', '1')
      rim.setAttribute('opacity', '0.42')
      canopy.appendChild(rim)
      bugs.bg.appendChild(canopy)

      const trunks = newDiv('trunks', bugs.bg)
      ;[11, 26, 53, 72, 89].forEach((pct, i) => {
        const t = document.createElement('i')
        t.style.left = pct + '%'
        t.style.height = 62 + (i % 3) * 36 + 'px'
        t.style.width = 9 + (i % 2) * 6 + 'px'
        trunks.appendChild(t)
      })

      const fly = newDiv('fly', bugs.bg)
      const rnd = mulberry32(99)
      for (let i = 0; i < 26; i++) {
        const s = document.createElement('i')
        if (rnd() < 0.25) s.className = 'big'
        s.style.setProperty('--x', Math.round(rnd() * 100) + '%')
        s.style.setProperty('--y', Math.round(8 + rnd() * 80) + '%')
        s.style.setProperty('--d', (3 + rnd() * 5).toFixed(1) + 's')
        s.style.setProperty('--t', (-rnd() * 8).toFixed(1) + 's')
        fly.appendChild(s)
      }
    }

    // 3) #look 屏墙：背景一排暗屏 + 一条扫掠线（很淡，只为托出截图）
    const look = makeBg('#look')
    if (look) {
      const mon = newDiv('monitors', look.bg)
      mon.style.opacity = '.8'
      const rnd = mulberry32(2026)
      // 排成 3 列 × 2 行的"屏墙"，比散点更像一回事
      for (let i = 0; i < 6; i++) {
        const s = document.createElement('i')
        if (rnd() < 0.4) s.className = 'on'
        s.style.setProperty('--x', 3 + (i % 3) * 32 + Math.round(rnd() * 3) + '%')
        s.style.setProperty('--y', 6 + Math.floor(i / 3) * 30 + Math.round(rnd() * 5) + '%')
        s.style.setProperty('--w', Math.round(140 + rnd() * 90) + 'px')
        s.style.setProperty('--h', Math.round(84 + rnd() * 54) + 'px')
        mon.appendChild(s)
      }
      newDiv('sweep', look.bg)
    }

    // 4) #shijiu 家里的暖光：一串挂灯（中间自然下垂）+ 地板线
    const shijiu = makeBg('#shijiu')
    if (shijiu) {
      newDiv('wire', shijiu.bg)
      const lights = newDiv('lights', shijiu.bg)
      for (let i = 0; i < 8; i++) {
        const t = i / 7
        const s = document.createElement('i')
        s.style.setProperty('--x', (8 + t * 84).toFixed(1) + '%')
        s.style.setProperty('--y', (6 + Math.sin(t * Math.PI) * 26).toFixed(0) + 'px')
        s.style.setProperty('--d', (4 + (i % 3) * 1.4).toFixed(1) + 's')
        s.style.setProperty('--t', (-i * 0.7).toFixed(1) + 's')
        if (i % 3 === 1) s.style.setProperty('--c', '#FFB86B')
        if (i % 3 === 2) s.style.setProperty('--c', '#FF8F6B')
        lights.appendChild(s)
      }
      newDiv('floorline', shijiu.bg)
      newDiv('floorpool', shijiu.bg)
    }

    // 5) #install 机房：两侧机架（带闪灯）+ 竖向数据流
    const install = makeBg('#install')
    if (install) {
      ;['l', 'r'].forEach((side) => {
        const rack = newDiv('rack ' + side, install.bg)
        const rnd = mulberry32(side === 'l' ? 5 : 9)
        for (let i = 0; i < 11; i++) {
          const s = document.createElement('i')
          if (rnd() < 0.35) s.className = 'on'
          s.style.top = (i * 9 + 2) + '%'
          rack.appendChild(s)
        }
      })
      const rain = newDiv('rain', install.bg)
      const rnd = mulberry32(31)
      for (let i = 0; i < 7; i++) {
        const s = document.createElement('i')
        s.style.setProperty('--x', Math.round(6 + rnd() * 88) + '%')
        s.style.setProperty('--h', Math.round(14 + rnd() * 26) + 'px')
        s.style.setProperty('--d', (2.4 + rnd() * 2).toFixed(1) + 's')
        s.style.setProperty('--t', (-rnd() * 4).toFixed(1) + 's')
        rain.appendChild(s)
      }
    }

    // 6) #privacy 关着门的那间：栅栏 + 灯柱（绿灯慢闪）+ 一把锁
    const priv = makeBg('#privacy')
    if (priv) {
      newDiv('fence', priv.bg)
      newDiv('fencecap', priv.bg)
      newDiv('cone', priv.bg)
      newDiv('post', priv.bg)
      newDiv('posthead', priv.bg)
      const lock = makeSvg(16, 18)
      lock.setAttribute('class', 'lock')
      // 像素图放大要整数倍：16×18 → 72×81（4.5 倍不整，用 4 倍 = 64×72）
      lock.style.width = '64px'
      lock.style.height = '72px'
      px(lock, 5, 0, 6, 2, '#5C7CA8')
      px(lock, 4, 2, 2, 5, '#5C7CA8')
      px(lock, 10, 2, 2, 5, '#5C7CA8')
      px(lock, 1, 7, 14, 11, '#24354F')
      px(lock, 2, 8, 12, 9, '#1B2740')
      px(lock, 7, 11, 2, 3, '#7FE3DA')
      priv.bg.appendChild(lock)
    }

    // 7) #support 夜市小摊：条纹遮阳篷 + 五只挂灯
    const support = makeBg('#support')
    if (support) {
      newDiv('counter', support.bg)
      newDiv('awning', support.bg)
      newDiv('teeth', support.bg)
      newDiv('teeth2', support.bg)
      const hangs = newDiv('hangs', support.bg)
      for (let i = 0; i < 5; i++) {
        const s = document.createElement('i')
        s.style.setProperty('--x', (13 + i * 19).toFixed(0) + '%')
        s.style.setProperty('--d', (3 + (i % 2) * 1.6 + i * 0.3).toFixed(1) + 's')
        s.style.setProperty('--t', (-i * 1.1).toFixed(1) + 's')
        if (i % 2) s.style.setProperty('--c', '#FFD9A8')
        hangs.appendChild(s)
      }
    }
  }
  buildScenes()

  // 顶栏轨道上的小拾玖：鼠标在顶栏上滑动时，它跟着走并左右转身
  function buildWalker() {
    const bar = document.querySelector('.top-in')
    const grid = window.NIBBLE_DEMO ? decodePlain(window.NIBBLE_DEMO.player) : null
    if (!bar || !grid) return
    // 24x24 → 12x12（每 2x2 取出现最多的非空色）
    const mini = []
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const counts = {}
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const c = grid[(y * 2 + sy) * 24 + (x * 2 + sx)]
            if (c) counts[c] = (counts[c] || 0) + 1
          }
        }
        mini.push(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null)
      }
    }
    const svg = makeSvg(12, 12)
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        if (mini[y * 12 + x]) px(svg, x, y, 1, 1, mini[y * 12 + x])
      }
    }
    const walker = newDiv('walker', bar)
    walker.appendChild(svg)
    let lastX = 0
    let stopTimer = 0
    bar.addEventListener('mousemove', (e) => {
      const r = bar.getBoundingClientRect()
      const nx = Math.max(0, Math.min(r.width - 12, e.clientX - r.left - 6))
      walker.classList.toggle('flip', nx < lastX)
      lastX = nx
      walker.style.setProperty('--wx', Math.round(nx) + 'px')
      walker.classList.add('step')
      window.clearTimeout(stopTimer)
      stopTimer = window.setTimeout(() => walker.classList.remove('step'), 340)
    })
  }
  buildWalker()

  // 滚动入场：元素进视口时"像素式跳出"。
  // 用滚动扫描而不是 IntersectionObserver —— 点导航锚点会瞬间跳过大段内容，
  // IO 对"一次跨过去"的元素不会回调，那些元素就会永远停在 opacity:0。
  function buildReveal() {
    const els = [
      ...document.querySelectorAll('.sec h2, .sec h3, .sec .lede, .sec .fine, .card, .quote, .stats, .shot, .who, .plain, .rarity, .support, .wall-wrap, .wall-group, .cmds'),
    ]
    document.documentElement.classList.add('js')
    els.forEach((el) => el.classList.add('rv'))
    const pending = els
    const show = () => {
      const limit = window.innerHeight * 0.94
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].getBoundingClientRect().top < limit) {
          pending[i].classList.add('in')
          pending.splice(i, 1)
        }
      }
      if (!pending.length) window.removeEventListener('scroll', onScroll)
    }
    let timer = 0
    function onScroll() {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        show()
      }, 60)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', show)
    show()
  }
  buildReveal()

  // 顶栏底部 24 格滚动进度（呼应扩展里的赛季进度条）
  function buildProgress() {
    const host = document.querySelector('.top')
    if (!host) return
    const bar = newDiv('pbar', host)
    for (let i = 0; i < 24; i++) bar.appendChild(document.createElement('i'))
    const cells = [...bar.children]
    let max = 1
    let last = -1
    const measure = () => (max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight))
    const upd = () => {
      // 只在"亮/灭"真的翻转时才写 class：滚动里读 scrollHeight 会强制同步布局，
      // 24 格逐帧重写更是白烧样式计算（这是长任务的主要来源之一）
      const lit = Math.round(Math.min(1, Math.max(0, window.scrollY / max)) * 24)
      if (lit === last) return
      for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i < lit)
      last = lit
    }
    let queued = false
    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        upd()
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', () => {
      measure()
      onScroll()
    })
    measure()
    upd()
  }
  buildProgress()

  /* ------------------------------------------------------------ 1.6) 滚动即一天
     整页是一条"黄昏 → 夜 → 深夜"的线：以视口 40% 处那条线为准，它落在哪一段，
     现在就是那一段的时段；只改"天光"（CSS 变量），段落自己的地色一律不动。
     用 scroll 监听而不是 IntersectionObserver —— 点导航跳转时也要立刻跟上。 */
  const TOD = [
    ['.hero', 'dusk'], ['#how', 'dusk'],
    ['#bugs', 'night'], ['#look', 'night'], ['#shijiu', 'night'],
    ['#install', 'deep'], ['#privacy', 'deep'], ['#support', 'deep'], ['.page-foot', 'deep'],
  ]
  function buildTod() {
    const rows = TOD.map((r) => ({ el: document.querySelector(r[0]), tod: r[1] })).filter((r) => r.el)
    if (!rows.length) return
    let cur = ''
    let tops = []
    let measured = -1e9
    const upd = () => {
      // 段的绝对位置最多每 400ms 重量一次：在滚动回调里读 offsetTop 会强制同步布局，
      // 每个滚动事件量一次 = 每帧全页回流（实测能吃掉三分之一的长任务时间）。
      // 之所以不是"只量一次"，是因为首屏那张结果卡展开后整页高度会变。
      const now = performance.now()
      if (now - measured > 400) {
        tops = rows.map((r) => r.el.offsetTop)
        measured = now
      }
      const line = window.scrollY + window.innerHeight * 0.4
      let tod = rows[0].tod
      for (let i = 0; i < rows.length; i++) if (tops[i] <= line) tod = rows[i].tod
      if (tod !== cur) {
        cur = tod
        document.documentElement.setAttribute('data-tod', tod)
      }
    }
    let queued = false
    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        upd()
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('load', onScroll) // 字体/图片落位后高度会变，再量一次
    upd()
  }
  buildTod()

  /* ------------------------------------------------------------ 1.7) 出视口即暂停动画
     滚出视口的段落整段冻结（CSS 的 [data-idle] 规则）：手机上省下上百个动画节点的开销，
     观感零损失——看不见的地方本来就不该在动。rootMargin 提前唤醒，滑进来时已经在动了。 */
  function buildIdle() {
    if (!('IntersectionObserver' in window)) return
    const io = new IntersectionObserver(
      (ens) => ens.forEach((en) => en.target.toggleAttribute('data-idle', !en.isIntersecting)),
      { rootMargin: '160px 0px' },
    )
    document.querySelectorAll('.hero, .sec, .page-foot').forEach((el) => io.observe(el))
  }
  buildIdle()

  // #how：背景那扇很淡的编辑器窗口（行号 + 代码行条，颜色深浅随机但固定种子）
  function buildGhostCode() {
    const sec = document.getElementById('how')
    if (!sec) return
    const box = newDiv('ghost-code', sec)
    const bar = newDiv('gc-top', box)
    ;['led led-r', 'led led-y', 'led led-g'].forEach((c) => newDiv(c, bar))
    const lines = newDiv('gc-lines', box)
    const rnd = mulberry32(4242)
    for (let i = 0; i < 15; i++) {
      const line = newDiv('gc-line', lines)
      newDiv('gc-no', line).textContent = String(i + 1)
      const code = newDiv('gc-code', line)
      code.style.marginLeft = (1 + Math.floor(rnd() * 3)) * 14 + 'px'
      code.style.width = (18 + Math.floor(rnd() * 46)) + '%'
      code.style.background = rnd() < 0.2 ? '#4ecdc42e' : '#ffffff0f'
    }
  }
  buildGhostCode()

  // #how：那行代码滑进视口后才开始"打字"
  function buildTypebar() {
    const bar = document.getElementById('typebar')
    if (!bar) return
    const start = () => {
      if (bar.getBoundingClientRect().top < window.innerHeight * 0.92) {
        bar.classList.add('on')
        window.removeEventListener('scroll', start)
      }
    }
    window.addEventListener('scroll', start, { passive: true })
    start()
  }
  buildTypebar()

  /* ------------------------------------------------------------ 2) 演示驱动 */
  const D = window.NIBBLE_DEMO
  // 演示面板存在性探测：旧结构是 #player canvas，场景化升级后改探 #scene（scene canvas）
  const hasDemo = !!(D && D.meta && D.enemies && D.weapons && document.getElementById('scene'))
  if (!hasDemo) return

  const M = D.meta
  const rnd = Math.random
  const ENEMY = {}
  D.enemies.forEach((e) => (ENEMY[e.id] = e))
  const WEAPON = {}
  D.weapons.forEach((w) => (WEAPON[w.id] = w))

  // 压缩网格（palette + base36 rows）→ pet.js 要的 576 长度扁平色值数组
  function decodeSprite(sp) {
    const out = new Array(576)
    if (!sp) return out
    for (let r = 0; r < 24; r++) {
      const row = sp.rows[r] || ''
      for (let c = 0; c < 24; c++) {
        const ch = row[c]
        out[r * 24 + c] = ch && ch !== '.' ? sp.palette[parseInt(ch, 36)] || null : null
      }
    }
    return out
  }

  // nibble.js tintGrid 的等价实现（史诗 +35% 紫 / 传说 +55% 金）
  const h2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase()
  function tint(flat, hex, strength) {
    const tr = parseInt(hex.slice(1, 3), 16)
    const tg = parseInt(hex.slice(3, 5), 16)
    const tb = parseInt(hex.slice(5, 7), 16)
    return flat.map((c) => {
      if (!c) return null
      const r = parseInt(c.slice(1, 3), 16) * (1 - strength) + tr * strength
      const g = parseInt(c.slice(3, 5), 16) * (1 - strength) + tg * strength
      const b = parseInt(c.slice(5, 7), 16) * (1 - strength) + tb * strength
      return '#' + h2(r) + h2(g) + h2(b)
    })
  }

  const cache = { player: null, enemy: {}, weapon: {} }
  const playerGrid = () => (cache.player = cache.player || decodeSprite(D.player))
  function enemySprite(id, rarity) {
    const key = id + '|' + rarity
    if (cache.enemy[key]) return cache.enemy[key]
    let g = decodeSprite(ENEMY[id] && ENEMY[id].sprite)
    if (rarity === 'epic') g = tint(g, '#E040E0', 0.35)
    else if (rarity === 'legendary') g = tint(g, '#FFD700', 0.55)
    cache.enemy[key] = g
    return g
  }
  function weaponSprite(id) {
    if (!cache.weapon[id]) cache.weapon[id] = decodeSprite(WEAPON[id] && WEAPON[id].sprite)
    return cache.weapon[id]
  }

  /* —— 数值（照抄 nibble.js / enemies.js / weapons.js）—— */
  const xpNeed = (lv) => 20 + (lv - 1) * 15
  const baseHp = (lv) => Math.round(21 + lv * 5.95)
  const playerAtk = (lv) => Math.round(4 + lv * 1.2)

  function enemyMaxHp(lv, entry, rarity) {
    const mul = (M.tierMul[entry.tier] || 1) * (M.rarityMul[rarity] || 1)
    return Math.max(6, Math.round(baseHp(lv) * mul * (0.9 + rnd() * 0.2)))
  }
  function rollRarity(lv) {
    const b = Math.min((lv - 1) * 0.01, 0.12)
    const r = rnd()
    if (r < 0.7 - b * 2) return 'common'
    if (r < 0.9 - b) return 'rare'
    if (r < 0.98) return 'epic'
    return 'legendary'
  }
  function rollWeapon(pity) {
    const rarity = rollRarity(pity)
    const pool = D.weapons.filter((w) => w.rarity === rarity)
    const weapon = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))]
    return { weapon, pity: rarity === 'epic' || rarity === 'legendary' ? 0 : pity + 1 }
  }
  function tierWeight(lv) {
    return { common: 100 - Math.min(40, lv * 2), elite: lv < 6 ? 0 : Math.min(45, (lv - 4) * 4), boss: lv < 15 ? 0 : Math.min(12, lv - 13) }
  }
  function pickTier(lv) {
    const w = tierWeight(lv)
    const total = w.common + w.elite + w.boss
    if (total <= 0) return 'common'
    let r = rnd() * total
    for (const t of ['common', 'elite', 'boss']) {
      r -= w[t]
      if (r < 0) return t
    }
    return 'common'
  }
  function poolOf(tier, lv) {
    const pool = D.enemies.filter((e) => e.tier === tier && e.minLv <= lv)
    return pool.length ? pool : D.enemies.filter((e) => e.tier === 'common')
  }
  function pickEnemy(lv) {
    const pool = poolOf(pickTier(lv), lv)
    return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))]
  }
  function bestOwned(owned) {
    let best = null
    for (const id of Object.keys(owned)) {
      const w = WEAPON[id]
      if (w && (!best || w.power > best.power)) best = w
    }
    return best
  }
  function shownWeapon() {
    const owned = s.arsenal.owned
    if (s.equipped && WEAPON[s.equipped] && owned[s.equipped]) return WEAPON[s.equipped]
    return bestOwned(owned)
  }

  /* —— 演示存档（假进度，只为让图鉴一打开就有层次）—— */
  const s = {
    level: D.demo.level,
    exp: D.demo.exp,
    battles: 0,
    defeats: 0,
    enemy: null,
    // 连击（与扩展 nibble.js 的 STREAK 规则一致：≤10 分钟连续；断连静默归一）
    // 初始给 8 连：演示自动攻击两下内就能看到「起势」光环与 ×N 徽标，访客不用干等 22 秒
    streak: { count: 8, lastAt: Date.now() },
    arsenal: { owned: Object.assign({}, D.demo.owned), pity: D.demo.pity },
    equipped: null,
    lastDrop: null,
    bestiary: { seen: Object.assign({}, D.demo.seen), defeated: Object.assign({}, D.demo.defeated) },
    lastLog: 'Nibble 待命中…（在 IDE 里：向 CodeBuddy 提问即可发动攻击）',
  }

  function spawnEnemy(entry, rarity) {
    const e = entry || pickEnemy(s.level)
    const r = rarity || rollRarity(s.level)
    const maxHp = enemyMaxHp(s.level, e, r)
    s.enemy = { type: e.id, rarity: r, hp: maxHp, maxHp: maxHp, shieldLeft: (e.mech && e.mech.shield) || 0, splitDone: false }
    const rec = s.bestiary.seen[e.id]
    if (rec) rec.count += 1
    else s.bestiary.seen[e.id] = { first: 0, count: 1 }
  }

  // 开局：一只史诗「竞态幽灵」，血条打到三成 —— 观众一进来就能看到打斗，十几秒内能见到一次掉落
  ;(function startBattle() {
    if (!ENEMY[D.demo.current]) D.demo.current = D.enemies[0].id
    const e = ENEMY[D.demo.current]
    const maxHp = enemyMaxHp(s.level, e, 'epic')
    s.enemy = { type: e.id, rarity: 'epic', hp: Math.max(1, Math.round(maxHp * 0.3)), maxHp: maxHp, shieldLeft: (e.mech && e.mech.shield) || 0, splitDone: false }
  })()

  /* —— 一次攻击：nibble.js attack() 的浏览器端复刻 —— */
  let pendingDrop = null

  // 连击档位与加成（照抄 nibble.js 的常量：<10 隐形；≥10 起势每连 +1% 封顶 +30%；≥25 燃；≥50 超载）
  const STREAK_WINDOW = 10 * 60 * 1000
  function streakOf() {
    const now = Date.now()
    const cnt = now - s.streak.lastAt <= STREAK_WINDOW ? s.streak.count : 0
    const tier = cnt >= 50 ? 3 : cnt >= 25 ? 2 : cnt >= 10 ? 1 : 0
    const bonus = cnt >= 10 ? Math.min(10 + (cnt - 10), 30) : 0
    return { count: cnt, tier: tier, bonus: bonus }
  }

  function attack() {
    const e = s.enemy
    const info = ENEMY[e.type]
    const mech = info.mech || {}
    const w = shownWeapon()
    // 连击：本次攻击先计入，再按新连击结算（与扩展 attack() 同序）
    const now = Date.now()
    s.streak.count = now - s.streak.lastAt <= STREAK_WINDOW ? s.streak.count + 1 : 1
    s.streak.lastAt = now
    const sk = streakOf()
    const tag = sk.tier ? '（×' + sk.count + ' 连击' + (sk.tier >= 3 ? ' · 超载' : sk.tier >= 2 ? ' · 火力全开' : '') + '）' : ''
    const atk = Math.max(1, playerAtk(s.level) * (1 + ((w ? w.power : 0) + sk.bonus) / 100))
    s.battles += 1

    let dmg = Math.max(1, Math.round(atk * (0.9 + rnd() * 0.2)))
    const notes = []
    if (mech.dodge && rnd() < mech.dodge) {
      dmg = 0
      notes.push('闪避')
    } else {
      if (e.shieldLeft > 0) {
        dmg = Math.max(1, Math.round(dmg / 2))
        e.shieldLeft -= 1
        notes.push('护盾格挡')
      }
      if (mech.armor) {
        const before = dmg
        dmg = Math.max(1, dmg - mech.armor)
        if (dmg < before) notes.push('护甲 ' + mech.armor)
      }
    }
    e.hp = Math.max(0, e.hp - dmg)
    s.lastDmg = dmg // 伤害飘字用（0 = 未命中）
    const note = notes.length ? '（' + notes.join('·') + '）' : ''

    if (e.hp > 0) {
      let log = 'Nibble 攻击！' + info.name + ' -' + dmg + ' HP' + note + tag
      if (mech.regen) {
        const healed = Math.min(mech.regen, e.maxHp - e.hp)
        if (healed > 0) {
          e.hp += healed
          log += '　💚 ' + info.name + ' 自愈 +' + healed + ' HP'
        }
      }
      s.lastLog = log
      return
    }

    if (mech.split && !e.splitDone) {
      e.splitDone = true
      const childHp = Math.max(1, Math.round(e.maxHp * 0.5))
      e.maxHp = childHp
      e.hp = childHp
      e.shieldLeft = 0
      s.lastLog = '🧬 ' + info.name + ' 受创分裂！重置为 ' + childHp + ' HP（分裂体 ×2）'
      return
    }

    // 击败
    e.hp = 0
    s.defeats += 1
    const firstTime = !s.bestiary.defeated[e.type]
    s.bestiary.defeated[e.type] = (s.bestiary.defeated[e.type] || 0) + 1
    if (!s.bestiary.seen[e.type]) s.bestiary.seen[e.type] = { first: 0, count: 1 }

    const gain = 6 + Math.round(e.maxHp * 0.6)
    s.exp += gain
    let ups = 0
    while (s.exp >= xpNeed(s.level)) {
      s.exp -= xpNeed(s.level)
      s.level += 1
      ups += 1
    }

    let log = '击败 ' + info.name + '（' + info.tierLabel + '·' + M.rarityLabel[e.rarity] + '）！' + tag
    log += firstTime ? '🆕 收录进怪物库' : '怪物库 ×' + s.bestiary.defeated[e.type]
    log += ' +' + gain + 'XP'
    if (ups > 0) log += '　⬆ 升级 Lv ' + s.level + '！'

    const drop = rollWeapon(s.arsenal.pity)
    s.arsenal.pity = drop.pity
    // ≥25 连「燃」：保底额外推进 1 步（与扩展一致）
    if (sk.tier >= 2) s.arsenal.pity = Math.min(M.pityLimit, s.arsenal.pity + 1)
    s.arsenal.owned[drop.weapon.id] = (s.arsenal.owned[drop.weapon.id] || 0) + 1
    s.lastDrop = { id: drop.weapon.id, at: Date.now() }
    log += '　✦ 获得 ' + drop.weapon.rarityLabel + '·' + drop.weapon.name + '！'

    spawnEnemy()
    const next = ENEMY[s.enemy.type]
    log += '　新的野生 ' + next.name + '（' + next.tierLabel + '·' + M.rarityLabel[s.enemy.rarity] + '）出现'
    s.lastLog = log
    pendingDrop = {
      type: 'drop',
      name: drop.weapon.name,
      rarity: drop.weapon.rarity,
      color: drop.weapon.color,
      rarityLabel: drop.weapon.rarityLabel,
      story: drop.weapon.story,
      sprite: weaponSprite(drop.weapon.id),
    }
  }

  /* —— 组装发往 pet.js 的消息（字段与 extension.js buildState() 一一对应）—— */
  let lastBestiaryKey = ''
  let lastOwnedCount = -1

  function buildState() {
    const e = s.enemy
    const info = ENEMY[e.type]
    const w = shownWeapon()
    const ownedCount = Object.keys(s.arsenal.owned).length
    const summary = {
      owned: ownedCount,
      total: M.weaponTotal,
      pity: s.arsenal.pity,
      pityLimit: M.pityLimit,
      ownedMap: s.arsenal.owned,
      equipped: s.equipped,
      shown: w ? { id: w.id, name: w.name, rarity: w.rarity, power: w.power } : null,
      atkBase: playerAtk(s.level),
      atkTotal: Math.round(playerAtk(s.level) * (1 + (w ? w.power : 0) / 100)),
      last: s.lastDrop
        ? {
            id: s.lastDrop.id,
            name: WEAPON[s.lastDrop.id].name,
            rarity: WEAPON[s.lastDrop.id].rarity,
            power: WEAPON[s.lastDrop.id].power,
            story: WEAPON[s.lastDrop.id].story,
            at: s.lastDrop.at,
          }
        : null,
    }
    return {
      player: playerGrid(),
      enemy: enemySprite(e.type, e.rarity),
      level: s.level,
      exp: s.exp,
      xpNeed: xpNeed(s.level),
      hp: e.hp,
      maxHp: e.maxHp,
      enemyType: e.type,
      enemyName: info.name,
      enemyTier: info.tier,
      enemyTierLabel: info.tierLabel,
      enemyMech: info.mechText,
      rarityLabel: M.rarityLabel[e.rarity],
      rarity: e.rarity,
      rarityColor: M.rarityColor[e.rarity],
      battles: s.battles,
      defeats: s.defeats,
      log: s.lastLog,
      // 连击（面板光环/徽标/飘字用）；key 带上连击数，涨连击也要推新 state
      streak: streakOf().count,
      streakTier: streakOf().tier,
      streakBonus: streakOf().bonus,
      lastDmg: Math.max(0, Number(s.lastDmg) || 0),
      key: e.type + '|' + e.rarity + '|' + e.maxHp + '|' + s.battles + '|' + (s.equipped || '') + '|' + (w ? w.id : '') + '|' + streakOf().count,
      arsenal: summary,
      weaponSprite: w ? weaponSprite(w.id) : null,
      weaponName: w ? w.name : null,
      weaponRarity: w ? w.rarity : null,
      weaponPower: w ? w.power : 0,
      weaponColor: w ? w.color : null,
    }
  }

  function arsenalData() {
    const sprites = {}
    D.weapons.forEach((w) => (sprites[w.id] = weaponSprite(w.id)))
    const st = buildState()
    return {
      type: 'arsenalData',
      owned: s.arsenal.owned,
      pity: s.arsenal.pity,
      pityLimit: M.pityLimit,
      equipped: s.equipped,
      shown: st.arsenal.shown,
      atkBase: st.arsenal.atkBase,
      atkTotal: st.arsenal.atkTotal,
      list: D.weapons,
      sprites: sprites,
    }
  }

  function bestiaryData() {
    const sprites = {}
    D.enemies.forEach((e) => (sprites[e.id] = enemySprite(e.id, 'common')))
    return {
      type: 'bestiaryData',
      seen: s.bestiary.seen,
      defeated: s.bestiary.defeated,
      current: s.enemy.type,
      list: D.enemies.map((e) => ({ id: e.id, name: e.name, tier: e.tier, minLv: e.minLv, story: e.story, mechText: e.mechText })),
      sprites: sprites,
    }
  }

  // 官网这一侧就充当宿主：pet.js 通过 acquireVsCodeApi() 把消息发到这里
  const post = (msg) => window.postMessage(msg)
  let frame = 0
  let lungeTicks = 0
  let dissolveTicks = 0
  let lastBattles = -1
  let lastDefeats = -1
  let lastKey = ''
  let lastStreakTier = -1

  function beat() {
    const st = buildState()
    frame = (frame + 1) % 2
    if (lastBattles !== -1 && st.battles > lastBattles) lungeTicks = 3
    if (lastDefeats !== -1 && st.defeats > lastDefeats) dissolveTicks = 6
    lastBattles = st.battles
    lastDefeats = st.defeats
    if (lungeTicks > 0) lungeTicks--
    if (dissolveTicks > 0) dissolveTicks--
    // 超载演出：连击档位「跨入 ≥50」的那一次推一条 burst（与 extension.js 同规则）
    const burst = lastStreakTier >= 0 && lastStreakTier < 3 && st.streakTier >= 3
    lastStreakTier = st.streakTier

    if (st.key !== lastKey) {
      lastKey = st.key
      post(Object.assign({ type: 'state' }, st))
    }
    if (burst) post({ type: 'burst', combo: st.streak })
    if (pendingDrop) {
      post(pendingDrop)
      pendingDrop = null
    }
    if (st.defeats !== lastOwnedCount) {
      lastOwnedCount = st.defeats
      post(arsenalData())
    }
    const bkey = Object.keys(s.bestiary.seen).length + '|' + Object.keys(s.bestiary.defeated).length
    if (bkey !== lastBestiaryKey) {
      lastBestiaryKey = bkey
      post(bestiaryData())
    }
    post({
      type: 'tick',
      frame: frame,
      lunge: lungeTicks > 0,
      blink: (st.rarity === 'rare' || st.rarity === 'legendary') && frame === 0,
      dissolve: dissolveTicks > 0,
      hp: st.hp,
      maxHp: st.maxHp,
      level: st.level,
      log: st.log,
    })
  }

  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (!msg) return
        if (msg.type === 'ready') {
          post(Object.assign({ type: 'state' }, buildState()))
          post(arsenalData())
          post(bestiaryData())
          beat()
          return
        }
        if (msg.type === 'attack') {
          attack()
          beat()
          return
        }
        if (msg.type === 'equip') {
          s.equipped = msg.id && s.arsenal.owned[msg.id] ? msg.id : null
          lastKey = '' // 强制重推 state
          post(Object.assign({ type: 'state' }, buildState()))
          post(arsenalData())
          beat()
        }
      },
    }
  }

  // 节拍：默认 700ms（与扩展 nibble.tickMs 默认一致）
  // 自动出手：真产品是"每次提问打一下"，官网没人提问，所以每 2.2 秒自动打一下，
  // 让页面自己动起来；访客可以随时点「攻击一次」抢节奏。
  // 面板滚出视口 / 标签页在后台时不打（这是"出视口即暂停"里最花钱的那一块：
  // 它每拍都要重算存档、发消息、重画面板）。判在定时器内部，所以回来时会自己恢复 —— 
  // 原来用 visibilitychange + clearInterval 的写法切走一次就再也回不来了。
  const heroAwake = () => !asleepIn(document.querySelector('.hero'))
  window.setInterval(() => {
    if (heroAwake()) beat()
  }, 700)
  if (!reduce) {
    window.setInterval(() => {
      if (heroAwake()) {
        attack()
        beat()
      }
    }, 2200)
    window.setTimeout(() => {
      attack()
      beat()
    }, 900)
  }

  // 演示窗口下方的说明：让观众知道这是假存档，顺手展示图鉴规模
  const note = document.getElementById('demoNote')
  if (note) {
    note.textContent =
      '假存档 · Lv ' + s.level + ' · 图鉴 ' + Object.keys(s.bestiary.seen).length + '/' + M.enemyTotal +
      ' · 武器 ' + Object.keys(s.arsenal.owned).length + '/' + M.weaponTotal
  }

  /* ------------------------------------------------------------ 2.5) 把你今天遇到的 Bug 丢给它
     输入一句真实报错 → 命中 40 只真怪之一 → 生成假名 + 确定性战报 → 就地换掉面板里那只
     （走的是与 IDE 完全相同的 state 消息，pet.js 不知道区别）。
     隐私口径：纯前端计算，不上传、不联网、不写 localStorage；
     只有访客自己点「复制分享链接」时，那句话才会进 URL。 */
  const BUG = D.bug || null
  if (BUG) {
    const bugIn = document.getElementById('bugin')
    const bugGo = document.getElementById('buggo')
    const bugCard = document.getElementById('bugcard')
    const bugEx = document.getElementById('bugEx')
    const bugEl = {
      art: document.getElementById('bcArt'),
      name: document.getElementById('bcName'),
      sub: document.getElementById('bcSub'),
      rep: document.getElementById('bcRep'),
      copy: document.getElementById('bcCopy'),
      tip: document.getElementById('bcTip'),
    }

    // FNV-1a：同一句话永远得到同一只怪、同一个假名、同一份战报（这样链接分享才有意义）
    function bugHash(str) {
      let h = 2166136261
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return h >>> 0
    }

    // 生成名里的"牌"：优先用命中的那个关键词（它最能说明问题），否则取输入里最长的一段代码词
    function bugToken(text, word) {
      if (word && word.length <= 16) return word
      const ascii = text.match(/[A-Za-z_$][A-Za-z0-9_$.]{2,15}/g)
      if (ascii) return ascii.sort((a, b) => b.length - a.length)[0]
      const cjk = text.match(/[\u4e00-\u9fa5]{2,6}/)
      return cjk ? cjk[0] : ''
    }

    // 命中词越长越具体（"内存一直涨"比"内存"更说明问题）
    function bugMatch(text) {
      const low = text.toLowerCase()
      let best = null
      let bestLen = 0
      for (const id of Object.keys(BUG.words)) {
        for (const w of BUG.words[id]) {
          if (w && w.length > bestLen && low.indexOf(w.toLowerCase()) >= 0) {
            bestLen = w.length
            best = { id: id, word: w }
          }
        }
      }
      return best
    }

    function bugMake(text) {
      const hit = bugMatch(text)
      const h = bugHash(text)
      const id = hit ? hit.id : BUG.fallback[h % BUG.fallback.length]
      const entry = ENEMY[id]
      const roll = h % 100
      const rarity = roll < 70 ? 'common' : roll < 88 ? 'rare' : roll < 97 ? 'epic' : 'legendary'
      const token = bugToken(text, hit ? hit.word : '')
      const pre = BUG.prefix[(h >>> 8) % BUG.prefix.length]
      const sufs = BUG.suffix[entry.tier] || BUG.suffix.common
      const suf = sufs[(h >>> 16) % sufs.length]
      // 假名走"代号式"：〈前缀〉的〈档位生物〉 · 〈你的词〉
      // —— 中文长词直接黏后缀会读不通（「内存一直涨魔」），这样排任何长度都顺
      const base = /的$/.test(pre) ? pre.slice(0, -1) : pre
      const alias = base + '的' + suf + (token ? ' · ' + token : '')
      const maxHp = Math.max(6, Math.round(baseHp(s.level) * (M.tierMul[entry.tier] || 1) * (M.rarityMul[rarity] || 1)))
      return { id: id, entry: entry, rarity: rarity, alias: alias, maxHp: maxHp }
    }

    // 战报里的"预计几击"：照抄 attack() 的规则算，不含随机（闪避按期望折算）
    function bugSim(entry, maxHp) {
      const w = shownWeapon()
      const atk = Math.max(1, Math.round(playerAtk(s.level) * (1 + (w ? w.power : 0) / 100)))
      const mech = entry.mech || {}
      const per = Math.max(1, atk - (mech.armor || 0))
      const regen = mech.regen || 0
      if (regen && per <= regen) return { atk: atk, per: per, regen: regen, stuck: true, hits: 0, weapon: w }
      let hp = maxHp
      let shieldLeft = mech.shield || 0
      let split = !!mech.split
      let swings = 0
      while (hp > 0 && swings < 999) {
        swings++
        if (shieldLeft > 0) {
          hp -= Math.max(1, Math.round(per / 2))
          shieldLeft--
        } else {
          hp -= per
        }
        if (hp <= 0) {
          if (split) {
            split = false
            hp = Math.round(maxHp * 0.5)
          } else break
        }
        if (regen) hp = Math.min(maxHp, hp + regen)
      }
      return {
        atk: atk,
        per: per,
        regen: 0,
        stuck: false,
        hits: mech.dodge ? Math.ceil(swings / (1 - mech.dodge)) : swings,
        dodge: mech.dodge || 0,
        shield: mech.shield || 0,
        split: !!mech.split,
        weapon: w,
      }
    }

    // 24x24 色值数组 → 内联 SVG（同色横向合并成一条 rect，和 favicon 一个套路）
    function bugArt(flat) {
      const rects = []
      for (let r = 0; r < 24; r++) {
        let c = 0
        while (c < 24) {
          const col = flat[r * 24 + c]
          if (!col) {
            c++
            continue
          }
          let run = 1
          while (c + run < 24 && flat[r * 24 + c + run] === col) run++
          rects.push('<rect x="' + c + '" y="' + r + '" width="' + run + '" height="1" fill="' + col + '"/>')
          c += run
        }
      }
      return '<svg viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">' + rects.join('') + '</svg>'
    }

    function bugShareUrl(text) {
      return location.origin + location.pathname + '?bug=' + encodeURIComponent(text)
    }

    function bugLines(m, sim) {
      const e = m.entry
      const out = [
        // 真身与机制并成一行：手机上少一行就少一屏的滚动
        '真身：' + e.name + '（' + e.tierLabel + '·' + M.rarityLabel[m.rarity] + '）· 出没 Lv ' + e.minLv +
          ' · 机制：' + (e.mechText || '无特殊机制，只会挨打'),
      ]
      if (sim.stuck) {
        out.push('打不动：它每回合自愈 +' + sim.regen + '，你一次只有 ' + sim.per + ' 点（先去升个级或换把更强的武器）')
      } else {
        out.push(
          '你的伤害 ' + sim.atk + '（含 ' + (sim.weapon ? sim.weapon.name + ' +' + sim.weapon.power + '%' : '空手') +
            '），它 ' + m.maxHp + ' HP → 预计 <b>' + sim.hits + '</b> 击' +
            (sim.dodge ? '（含闪避期望）' : ''),
        )
        if (sim.split) out.push('注意：它受创会分裂，第二形态还有一半血')
      }
      if (e.story) out.push('Bug 纪要：' + e.story)
      return out
    }

    function bugApply(text, shared) {
      const m = bugMake(text)
      spawnEnemy(m.entry, m.rarity)
      s.enemy.maxHp = m.maxHp
      s.enemy.hp = m.maxHp
      s.enemy.shieldLeft = (m.entry.mech && m.entry.mech.shield) || 0
      s.lastLog =
        '遭遇「' + m.alias + '」：' + m.entry.name + '（' + m.entry.tierLabel + '·' + M.rarityLabel[m.rarity] +
        '）— 你的 Bug 变成它了'
      const sim = bugSim(m.entry, m.maxHp)
      if (bugEl.art) bugEl.art.innerHTML = bugArt(enemySprite(m.id, m.rarity))
      if (bugEl.name) bugEl.name.textContent = m.alias
      if (bugEl.sub) {
        bugEl.sub.textContent =
          m.entry.name + ' · ' + m.entry.tierLabel + ' · ' + M.rarityLabel[m.rarity] + ' · 你的 Bug 编号 #' + bugHash(text).toString(36).slice(0, 5)
        bugEl.sub.style.color = M.rarityColor[m.rarity] || 'var(--hearth)'
      }
      if (bugEl.rep) bugEl.rep.innerHTML = bugLines(m, sim).map((t) => '<li>' + t + '</li>').join('')
      if (bugEl.copy) bugEl.copy.dataset.copy = bugShareUrl(text)
      if (bugEl.tip) {
        bugEl.tip.textContent = shared
          ? '这是别人丢过来的 Bug（链接里带着原话）。'
          : '同一句话永远生成同一只怪；点「复制分享链接」发给朋友，他打开就是这一只。'
      }
      if (bugCard) bugCard.classList.remove('hidden')
      post(Object.assign({ type: 'state' }, buildState()))
      post(bestiaryData())
      attack() // 当场打一下：面板里会立刻出现这一击
      beat()
      return m
    }

    function bugSubmit() {
      const text = (bugIn && bugIn.value ? bugIn.value : '').trim().slice(0, 120)
      if (!text) return
      bugApply(text, false)
      if (bugCard) bugCard.scrollIntoView({ block: 'nearest' })
    }

    if (bugIn && bugGo) {
      bugGo.disabled = !bugIn.value.trim() // 空输入时按钮不可点，省掉一个报错态
      bugIn.addEventListener('input', () => (bugGo.disabled = !bugIn.value.trim()))
      bugIn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          bugSubmit()
        }
      })
      bugGo.addEventListener('click', bugSubmit)
    }

    // 示例：点一下就替访客填好并立刻开打
    if (bugEx && bugEx.appendChild) {
      BUG.examples.forEach((ex) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = ex
        b.addEventListener('click', () => {
          if (bugIn) bugIn.value = ex
          if (bugGo) bugGo.disabled = false
          bugApply(ex, false)
          if (bugCard) bugCard.scrollIntoView({ block: 'nearest' })
        })
        bugEx.appendChild(b)
      })
    }

    // 分享链接：复制那一刻才把这句话写进地址栏（之前地址栏是干净的）
    if (bugEl.copy) {
      bugEl.copy.addEventListener('click', () => {
        if (bugIn && bugIn.value.trim() && window.history && history.replaceState) {
          history.replaceState(null, '', bugShareUrl(bugIn.value.trim().slice(0, 120)))
        }
      })
    }

    // 打开别人分享的链接：同一句话 → 同一只怪，输入框也回填好
    const shared = new URLSearchParams(location.search).get('bug')
    if (shared) {
      const text = shared.trim().slice(0, 120)
      if (bugIn) bugIn.value = text
      if (bugGo) bugGo.disabled = !text
      if (text) bugApply(text, true)
    }
  }

  /* ------------------------------------------------------------ 3) 小交互 */
  // 怪物名单：点任意一只 → 滚到演示并切到怪物库（block:start + CSS scroll-margin 兜住吸顶导航）
  document.querySelectorAll('.pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      post({ type: 'view', view: 'bestiary' })
      const demo = document.getElementById('demo')
      // 用瞬时滚动：平滑滚动在部分环境（如无头浏览器）会被忽略，宁可"一定跳得到"
      if (demo) demo.scrollIntoView({ block: 'start' })
    })
  })

  // 复制命令
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy || ''
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch { /* 忽略 */ }
        document.body.removeChild(ta)
      }
      const old = btn.textContent
      btn.textContent = '已复制'
      btn.classList.add('done')
      window.setTimeout(() => {
        btn.textContent = old
        btn.classList.remove('done')
      }, 1400)
    })
  })

  // 导航高亮
  const links = [...document.querySelectorAll('.nav a')]
  const map = {}
  links.forEach((a) => (map[a.getAttribute('href').slice(1)] = a))
  const targets = Object.keys(map).map((id) => document.getElementById(id)).filter(Boolean)
  if ('IntersectionObserver' in window && targets.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            links.forEach((a) => a.removeAttribute('aria-current'))
            const a = map[en.target.id]
            if (a) a.setAttribute('aria-current', 'true')
          }
        })
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    targets.forEach((t) => io.observe(t))
  }
})()
