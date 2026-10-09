'use strict'
// pet.js —— 面板的绘制与动画。既能在 IDE 的 Webview 里跑（收扩展发来的帧），
// 也能被预览页独立打开（用 window.__NIBBLE_MOCK__ 自走演示）。
;(function () {
  const hasHost = typeof acquireVsCodeApi === 'function'
  const api = hasHost ? acquireVsCodeApi() : null

  const $ = (id) => document.getElementById(id)
  const canvasP = $('player')
  const canvasE = $('enemy')
  const SIZE = 24

  let state = null
  let tick = { frame: 0, lunge: false, blink: false, dissolve: false }

  // 把 24x24 的扁平颜色数组画到 canvas 上（'' 表示透空）
  function drawSprite(canvas, flatGrid, shiftX, shiftY, hidden) {
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, SIZE, SIZE)
    if (!flatGrid || hidden) return
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const color = flatGrid[r * SIZE + c]
        if (!color) continue
        const x = c + shiftX
        const y = r + shiftY
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue
        ctx.fillStyle = color
        ctx.fillRect(x, y, 1, 1)
      }
    }
  }

  function render() {
    if (!state) return
    // 玩家：攻击时前冲 2px，待机时隔帧下沉 1px（上下浮动）
    const lunge = tick.lunge
    drawSprite(canvasP, state.player, lunge ? 2 : 0, lunge ? 0 : (tick.frame ? 1 : 0), false)
    // 敌人：稀有度亮点闪烁 / 击败时隔帧消散
    drawSprite(canvasE, state.enemy, 0, 0, tick.dissolve && tick.frame % 2 === 0)

    $('lv').textContent = 'Lv ' + state.level
    const ratio = Math.max(0, state.hp) / Math.max(1, state.maxHp)
    const bar = $('hpbar')
    bar.style.width = Math.round(ratio * 100) + '%'
    bar.style.background = ratio > 0.5 ? '#4ECDC4' : ratio > 0.25 ? '#FFE066' : '#FF6B6B'
    $('hpnum').textContent = state.hp + '/' + state.maxHp
    const name = $('ename')
    name.textContent = state.enemyName + '（' + state.rarityLabel + '）'
    name.style.color = state.rarityColor || '#FFB86B'
    $('log').textContent = state.log || 'Nibble 待命中…'
  }

  function applyState(msg) {
    state = Object.assign({}, state, msg)
    render()
  }

  if (hasHost) {
    window.addEventListener('message', (e) => {
      const msg = e.data || {}
      if (msg.type === 'state') applyState(msg)
      else if (msg.type === 'tick') {
        tick = msg
        if (state) {
          state.hp = msg.hp
          state.maxHp = msg.maxHp
          state.level = msg.level
          state.log = msg.log
        }
        render()
      }
    })
    const btnAttack = $('attack')
    if (btnAttack) btnAttack.onclick = () => api.postMessage({ type: 'attack' })
    const btn = $('reset')
    if (btn) btn.onclick = () => api.postMessage({ type: 'reset' })
    const btnExpand = $('expand')
    if (btnExpand) btnExpand.onclick = () => api.postMessage({ type: 'expand' })
    api.postMessage({ type: 'ready' })
    return
  }

  // ———— 独立预览：无宿主时用注入的假数据自走演示 ————
  const mock = typeof window !== 'undefined' ? window.__NIBBLE_MOCK__ : null
  if (mock) {
    state = Object.assign({ level: 1, hp: 24, maxHp: 40, enemyName: '蝙蝠', rarityLabel: '普通', rarityColor: '#FFB86B', log: 'Nibble 攻击！野生 蝙蝠 -8 HP' }, mock)
    let f = 0
    let lunge = 0
    render()
    setInterval(() => {
      f = (f + 1) % 2
      if (lunge > 0) lunge--
      tick = { frame: f, lunge: lunge > 0, dissolve: false }
      render()
    }, 700)
    setInterval(() => {
      const dmg = 4 + Math.floor(Math.random() * 7)
      state.hp -= dmg
      if (state.hp <= 0) {
        state.hp = state.maxHp
        state.log = '击败野生 ' + state.enemyName + '！捕获成功 +48XP　新的野生 出现'
      } else {
        state.log = 'Nibble 攻击！野生 ' + state.enemyName + ' -' + dmg + ' HP'
      }
      lunge = 3
      render()
    }, 2600)
  }
})()
