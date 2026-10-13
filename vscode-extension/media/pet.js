'use strict'
// pet.js —— 面板的绘制与动画。既能在 IDE 的 Webview 里跑（收扩展发来的帧），
// 也能被预览页独立打开（用 window.__NIBBLE_MOCK__ 自走演示）。
// 视图：战斗（小生物 + 手持武器 + 战利品 toast）/ 武器库（80 格收集图鉴）。
;(function () {
  const hasHost = typeof acquireVsCodeApi === 'function'
  const api = hasHost ? acquireVsCodeApi() : null

  const $ = (id) => document.getElementById(id)
  const canvasP = $('player')
  const canvasE = $('enemy')
  const canvasW = $('weapon')
  const SIZE = 24

  let state = null
  let tick = { frame: 0, lunge: false, blink: false, dissolve: false }
  let view = 'battle'
  let arsenal = null // { owned, pity, pityLimit, list, sprites }
  let selectedId = null // 武器库中当前选中的武器（详情卡展示它的故事）
  let bestiary = null // { seen, defeated, list, sprites } 怪物库（遭遇 → 击败双状态）
  let selectedEnemyId = null // 怪物库中当前选中的怪物

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function rgba(hex, a) {
    const h = String(hex || '#FFE066').replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
  }

  const RARITY_KEY = { 普通: 'common', 稀有: 'rare', 史诗: 'epic', 传说: 'legendary' }
  const RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }
  const RARITY_TEXT_COLOR = { common: '#FFB86B', rare: '#FFE066', epic: '#E040E0', legendary: '#FFD700' }

  // 战斗日志：✦ 获得 的掉落片段按稀有度着色
  function setLog(text) {
    const el = $('log')
    // 清掉后端文案里的 emoji 与 markdown 星号：像素风里 emoji 破功（部分字体还会渲染成方块），
    // 星号则是后端写日志时留下的（原本只在"✦ 获得"那一处做特殊处理）
    const txt = (text || 'Nibble 待命中…')
      .replace(/🆕/g, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const m = txt.match(/✦ 获得 (普通|稀有|史诗|传说)·(.+?)！/)
    const color = m ? RARITY_TEXT_COLOR[RARITY_KEY[m[1]]] : null
    if (m && color) {
      el.innerHTML =
        escapeHtml(txt.slice(0, m.index)) +
        '<span style="color:' + color + ';font-weight:600">✦ 获得 ' + m[1] + '·' + escapeHtml(m[2]) + '！</span>' +
        escapeHtml(txt.slice(m.index + m[0].length))
    } else {
      el.textContent = txt
    }
  }

  function render() {
    if (!state) return
    // 玩家：攻击时前冲 2px，待机时隔帧下沉 1px（上下浮动）
    const lunge = tick.lunge
    // 新面板里角色由场景（scene.js）绘制，#player/#enemy 两个 canvas 已不存在 → 取空则跳过。
    // 官网首屏复用本文件、它的 DOM 里这两个 canvas 还在，行为不变。
    if (canvasP) drawSprite(canvasP, state.player, lunge ? 2 : 0, lunge ? 0 : (tick.frame ? 1 : 0), false)
    // 敌人：稀有度亮点闪烁 / 击败时隔帧消散
    if (canvasE) drawSprite(canvasE, state.enemy, 0, 0, tick.dissolve && tick.frame % 2 === 0)
    // 装备槽：单独格子展示当前携带的武器（已装备 → 否则跟随最近获得）
    if (canvasW) {
      const has = !!state.weaponSprite
      const power = state.weaponPower || 0
      const slot = $('slot')
      if (slot) {
        slot.classList.toggle('empty', !has)
        slot.style.borderColor = has ? state.weaponColor || 'var(--line)' : ''
        slot.style.boxShadow = has ? '0 0 10px ' + rgba(state.weaponColor, 0.35) : 'none'
        slot.title = has
          ? state.weaponName + '（' + (RARITY_LABEL[state.weaponRarity] || '') + '· 战力 +' + power + '%）· 点击更换武器'
          : '点击去武器库选择武器'
      }
      drawSprite(canvasW, state.weaponSprite, 0, 0, !has)
      const nameEl = $('slotName')
      if (nameEl) nameEl.textContent = has ? state.weaponName + ' +' + power + '%' : '未装备'
    }
    const atkEl = $('atk')
    if (atkEl) {
      const a = (state.arsenal && state.arsenal.atkTotal) || 0
      // 不用 emoji：彩色 emoji 在像素场景里最破功，而且部分字体下会渲染成方块
      atkEl.textContent = a ? '攻击 ' + a : ''
    }
    const wpnEl = $('wpn')
    if (wpnEl) {
      wpnEl.textContent = state.weaponSprite
        ? state.weaponName + ' +' + (state.weaponPower || 0) + '%'
        : ''
    }

    $('lv').textContent = 'Lv ' + state.level
    // 主角头顶的经验条（新面板用；旧面板没有这个节点，取空则跳过）
    const expEl = $('expbar')
    if (expEl) {
      const need = Math.max(1, state.xpNeed || 1)
      expEl.style.width = Math.max(0, Math.min(100, Math.round(((state.exp || 0) / need) * 100))) + '%'
    }
    const ratio = Math.max(0, state.hp) / Math.max(1, state.maxHp)
    const bar = $('hpbar')
    bar.style.width = Math.round(ratio * 100) + '%'
    bar.style.background = ratio > 0.5 ? '#4ECDC4' : ratio > 0.25 ? '#FFE066' : '#FF6B6B'
    $('hpnum').textContent = state.hp + '/' + state.maxHp
    const name = $('ename')
    name.textContent =
      state.enemyName + '（' + (state.enemyTierLabel || '小怪') + '·' + state.rarityLabel + '）'
    name.style.color = state.rarityColor || '#FFB86B'
    name.title = state.enemyMech || ''
    setLog(state.log)
  }

  function applyState(msg) {
    state = Object.assign({}, state, msg)
    render()
  }

  // —— 视图切换：战斗 / 武器库 / 怪物库 ——
  function switchView(v) {
    view = v === 'arsenal' || v === 'bestiary' ? v : 'battle'
    const b = $('battleView'); const a = $('arsenalView'); const m = $('bestiaryView')
    if (!b || !a || !m) return
    b.classList.toggle('hidden', view !== 'battle')
    a.classList.toggle('hidden', view !== 'arsenal')
    m.classList.toggle('hidden', view !== 'bestiary')
    const tb = $('tabBattle'); const ta = $('tabArsenal'); const tm = $('tabBestiary')
    if (tb) tb.classList.toggle('active', view === 'battle')
    if (ta) ta.classList.toggle('active', view === 'arsenal')
    if (tm) tm.classList.toggle('active', view === 'bestiary')
    if (view === 'arsenal') renderArsenal()
    if (view === 'bestiary') renderBestiary()
  }

  const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary']

  function makeCell(w, n) {
    const cell = document.createElement('div')
    cell.className = 'wcell' + (n ? ' owned' : ' locked')
    cell.dataset.id = w.id
    if (w.id === selectedId) cell.classList.add('sel')
    cell.title = n ? w.name + (n > 1 ? ' ×' + n : '') : w.name + '（未收集）'
    const cv = document.createElement('canvas')
    cv.width = SIZE
    cv.height = SIZE
    drawSprite(cv, arsenal.sprites[w.id], 0, 0, false)
    if (!n) {
      // 未收集：暗剪影（不再叠 '?'，减少噪点）
      const ctx = cv.getContext('2d')
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = '#20263a'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.globalCompositeOperation = 'source-over'
    } else {
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.background = RARITY_TEXT_COLOR[w.rarity]
      cell.appendChild(dot)
    }
    cell.appendChild(cv)
    if (n > 1) {
      const badge = document.createElement('span')
      badge.className = 'cnt'
      badge.textContent = '×' + n
      cell.appendChild(badge)
    }
    if (n && arsenal.equipped === w.id) {
      const eq = document.createElement('span')
      eq.className = 'eq'
      eq.textContent = '★'
      cell.appendChild(eq)
    }
    cell.onclick = () => selectWeapon(w.id)
    return cell
  }

  function renderArsenal() {
    if (!arsenal || !arsenal.list) return
    const owned = arsenal.owned || {}
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 }
    const totals = { common: 0, rare: 0, epic: 0, legendary: 0 }
    const byR = { common: [], rare: [], epic: [], legendary: [] }
    arsenal.list.forEach((w) => {
      totals[w.rarity]++
      byR[w.rarity].push(w)
      if (owned[w.id]) counts[w.rarity]++
    })
    // 统计行：总数 + 各档计数（带色点）+ 保底
    const uniq = Object.keys(owned).length
    $('alegend').innerHTML =
      '<span class="atotal">⚔ ' + uniq + '/' + arsenal.list.length + '</span>' +
      (arsenal.atkTotal
        ? '<span class="achip">🗡 攻击 ' + arsenal.atkTotal +
          (arsenal.shown ? '（+' + arsenal.shown.power + '%）' : '') + '</span>'
        : '') +
      RARITY_ORDER.map(
        (r) =>
          '<span class="achip"><i style="background:' + RARITY_TEXT_COLOR[r] + '"></i>' +
          RARITY_LABEL[r] + ' ' + counts[r] + '/' + totals[r] + '</span>',
      ).join('') +
      '<span class="apity">保底 ' + arsenal.pity + '/' + arsenal.pityLimit + '</span>'
    // 进度条：分段宽度按各档总数比例，填充按收集率
    const segs = $('abar').children
    RARITY_ORDER.forEach((r, i) => {
      const seg = segs[i]
      if (!seg) return
      seg.style.flexGrow = String(totals[r] || 1)
      const fill = seg.firstElementChild
      fill.style.background = RARITY_TEXT_COLOR[r]
      fill.style.width = (totals[r] ? Math.round((counts[r] / totals[r]) * 100) : 0) + '%'
    })
    // 分组网格：普通 → 稀有 → 史诗 → 传说
    const wrap = $('agroups')
    wrap.textContent = ''
    RARITY_ORDER.forEach((r) => {
      if (!byR[r].length) return
      const group = document.createElement('div')
      group.className = 'agroup'
      const head = document.createElement('div')
      head.className = 'aghead'
      head.innerHTML =
        '<i style="background:' + RARITY_TEXT_COLOR[r] + '"></i>' +
        RARITY_LABEL[r] + ' ' + counts[r] + '/' + totals[r]
      const grid = document.createElement('div')
      grid.className = 'agrid'
      byR[r].forEach((w) => grid.appendChild(makeCell(w, owned[w.id] || 0)))
      group.appendChild(head)
      group.appendChild(grid)
      wrap.appendChild(group)
    })
    renderDetail()
  }

  // —— 武器详情卡：点格子看这把武器的「回忆杀」故事 ——
  function selectWeapon(id) {
    selectedId = id
    const cells = document.querySelectorAll('#agroups .wcell')
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('sel', cells[i].dataset.id === selectedId)
    }
    renderDetail()
  }

  function renderDetail() {
    const el = $('adetail')
    if (!el || !arsenal || !arsenal.list) return
    const w = arsenal.list.filter((x) => x.id === selectedId)[0] || null
    const icon = $('adetailIcon')
    const nameEl = $('adetailName')
    const storyEl = $('adetailStory')
    const eqBtn = $('aEquip')
    const autoBtn = $('aAuto')
    if (!w) {
      drawSprite(icon, null, 0, 0, true)
      nameEl.textContent = '—'
      nameEl.style.color = 'var(--text)'
      storyEl.textContent = '点选下方格子，查看这把武器的故事'
      el.style.borderColor = 'var(--line)'
      if (eqBtn) eqBtn.classList.add('hidden')
      if (autoBtn) autoBtn.classList.add('hidden')
      return
    }
    const n = (arsenal.owned && arsenal.owned[w.id]) || 0
    const color = RARITY_TEXT_COLOR[w.rarity]
    el.style.borderColor = n ? color : 'var(--line)'
    if (!n) {
      const cv = icon
      drawSprite(cv, arsenal.sprites[w.id], 0, 0, false)
      const ctx = cv.getContext('2d')
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = '#20263a'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.globalCompositeOperation = 'source-over'
      nameEl.textContent = '？？？ （' + RARITY_LABEL[w.rarity] + '·未收集·战力 +' + (w.power || 0) + '%）'
      nameEl.style.color = 'var(--dim)'
      storyEl.textContent = '还没得到它。它藏在战利品里，多击败几只敌人试试运气吧。'
      if (eqBtn) eqBtn.classList.add('hidden')
      if (autoBtn) autoBtn.classList.add('hidden')
      return
    }
    drawSprite(icon, arsenal.sprites[w.id], 0, 0, false)
    const isActive = !!(arsenal.shown && arsenal.shown.id === w.id)
    nameEl.textContent =
      w.name + '　' + RARITY_LABEL[w.rarity] + '　战力 +' + (w.power || 0) + '%' + (n > 1 ? '　×' + n : '')
    nameEl.style.color = color
    storyEl.textContent = (w.story || '（这把武器还没有故事）') + (isActive ? '　⚡ 当前生效中' : '')
    // 装备按钮：已装备则置灰显示 ✓；装备了别的武器时提供"跟随最近获得"
    const isEquipped = arsenal.equipped === w.id
    if (eqBtn) {
      eqBtn.classList.remove('hidden')
      eqBtn.textContent = isEquipped ? '✓ 已装备' : '装备此武器'
      eqBtn.disabled = isEquipped
    }
    if (autoBtn) autoBtn.classList.toggle('hidden', !arsenal.equipped)
  }

  // —— 怪物库视图：遭遇（灰调）→ 击败（彩色）双状态图鉴 ——
  const TIER_ORDER = ['common', 'elite', 'boss']
  const TIER_LABEL = { common: '小怪', elite: '精英', boss: '头目' }
  const TIER_COLOR = { common: '#8FA3B8', elite: '#C08BE0', boss: '#F0A04B' }

  // 暗剪影 / 灰调：在像素形状上叠一层颜色（source-atop 只作用于非透空像素）
  function grayCover(cv, color) {
    const ctx = cv.getContext('2d')
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.globalCompositeOperation = 'source-over'
  }

  function makeBCell(e, seen, n) {
    const cell = document.createElement('div')
    cell.className = 'wcell ' + (n > 0 ? 'owned' : seen ? 'seen' : 'locked')
    cell.dataset.id = e.id
    if (e.id === selectedEnemyId) cell.classList.add('sel')
    cell.title = seen
      ? e.name + (n > 0 ? ' · 击败 ' + n + ' 次' : ' · 已遭遇，尚未击败')
      : '？？？（未遭遇）'
    const cv = document.createElement('canvas')
    cv.width = SIZE
    cv.height = SIZE
    drawSprite(cv, bestiary.sprites[e.id], 0, 0, false)
    if (n > 0) {
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.background = TIER_COLOR[e.tier]
      cell.appendChild(dot)
    } else {
      grayCover(cv, seen ? '#39415a' : '#20263a') // 已遭遇=灰调，未遭遇=更暗
    }
    cell.appendChild(cv)
    if (n > 1) {
      const badge = document.createElement('span')
      badge.className = 'cnt'
      badge.textContent = '×' + n
      cell.appendChild(badge)
    }
    cell.onclick = () => selectEnemy(e.id)
    return cell
  }

  function renderBestiary() {
    if (!bestiary || !bestiary.list) return
    const seen = bestiary.seen || {}
    const defeated = bestiary.defeated || {}
    const counts = { common: 0, elite: 0, boss: 0 }
    const totals = { common: 0, elite: 0, boss: 0 }
    const byT = { common: [], elite: [], boss: [] }
    bestiary.list.forEach((e) => {
      totals[e.tier] = (totals[e.tier] || 0) + 1
      if (byT[e.tier]) byT[e.tier].push(e)
      if (defeated[e.id]) counts[e.tier]++
    })
    const seenN = bestiary.list.filter((e) => seen[e.id]).length
    const defN = bestiary.list.filter((e) => defeated[e.id]).length
    $('blegend').innerHTML =
      '<span class="atotal">📖 ' + seenN + '/' + bestiary.list.length + '</span>' +
      TIER_ORDER.map(
        (t) =>
          '<span class="achip"><i style="background:' + TIER_COLOR[t] + '"></i>' +
          TIER_LABEL[t] + ' ' + counts[t] + '/' + totals[t] + '</span>',
      ).join('') +
      '<span class="apity">已击败 ' + defN + '</span>'
    // 进度条：分段宽度按各 tier 总数比例，填充按击败率
    const segs = $('bbar').children
    TIER_ORDER.forEach((t, i) => {
      const seg = segs[i]
      if (!seg) return
      seg.style.flexGrow = String(totals[t] || 1)
      const fill = seg.firstElementChild
      fill.style.background = TIER_COLOR[t]
      fill.style.width = (totals[t] ? Math.round((counts[t] / totals[t]) * 100) : 0) + '%'
    })
    // 分组网格：小怪 → 精英 → 头目
    const wrap = $('bgroups')
    wrap.textContent = ''
    TIER_ORDER.forEach((t) => {
      if (!byT[t] || !byT[t].length) return
      const group = document.createElement('div')
      group.className = 'agroup'
      const head = document.createElement('div')
      head.className = 'aghead'
      head.innerHTML =
        '<i style="background:' + TIER_COLOR[t] + '"></i>' +
        TIER_LABEL[t] + ' ' + counts[t] + '/' + totals[t]
      const grid = document.createElement('div')
      grid.className = 'agrid'
      byT[t].forEach((e) => grid.appendChild(makeBCell(e, !!seen[e.id], defeated[e.id] || 0)))
      group.appendChild(head)
      group.appendChild(grid)
      wrap.appendChild(group)
    })
    renderBDetail()
  }

  function selectEnemy(id) {
    selectedEnemyId = id
    const cells = document.querySelectorAll('#bgroups .wcell')
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('sel', cells[i].dataset.id === selectedEnemyId)
    }
    renderBDetail()
  }

  // —— 怪物详情卡：像素图 + tier + 遭遇/击败记录 + Bug 故事 ——
  function renderBDetail() {
    const el = $('bdetail')
    if (!el || !bestiary || !bestiary.list) return
    const e = bestiary.list.filter((x) => x.id === selectedEnemyId)[0] || null
    const icon = $('bdetailIcon')
    const nameEl = $('bdetailName')
    const storyEl = $('bdetailStory')
    storyEl.style.whiteSpace = 'pre-line'
    if (!e) {
      drawSprite(icon, null, 0, 0, true)
      nameEl.textContent = '—'
      nameEl.style.color = 'var(--text)'
      storyEl.textContent = '点选下方格子，查看这只怪物的「Bug 纪要」'
      el.style.borderColor = 'var(--line)'
      return
    }
    const seen = (bestiary.seen && bestiary.seen[e.id]) || null
    const n = (bestiary.defeated && bestiary.defeated[e.id]) || 0
    drawSprite(icon, bestiary.sprites[e.id], 0, 0, false)
    if (!n) grayCover(icon, seen ? '#39415a' : '#20263a')
    el.style.borderColor = n ? TIER_COLOR[e.tier] : 'var(--line)'
    if (!seen) {
      nameEl.textContent = '？？？　未遭遇'
      nameEl.style.color = 'var(--dim)'
      storyEl.textContent = '还没遇到过它。继续向 CodeBuddy 提问，它会自己找上门来。'
      return
    }
    nameEl.textContent =
      e.name + '　' + (TIER_LABEL[e.tier] || '') + (n ? '　击败 ×' + n : '　尚未击败')
    nameEl.style.color = n ? TIER_COLOR[e.tier] : 'var(--dim)'
    const parts = [e.story || '（这只怪物还没有故事）']
    if (e.mechText) parts.push('【机制】' + e.mechText)
    parts.push('【记录】遭遇 ×' + (seen.count || 1) + '　击败 ×' + n)
    storyEl.textContent = parts.join('\n')
  }

  // —— 战利品 toast（史诗以上带震动，传说再加金光）——
  let toastTimer = null
  let fxTimer = null
  function showDrop(msg) {
    const toast = $('toast')
    if (!toast) return
    drawSprite($('toastIcon'), msg.sprite, 0, 0, !msg.sprite)
    const t = $('toastText')
    const head = escapeHtml('获得 ' + (msg.rarityLabel || '') + '·' + msg.name + '！')
    t.innerHTML = msg.story
      ? head + '<span class="story">' + escapeHtml(msg.story) + '</span>'
      : head
    t.style.color = msg.color || '#E6EDF3'
    toast.style.borderColor = msg.color || 'var(--line)'
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600)
    const stage = document.querySelector('.stage')
    if (stage && (msg.rarity === 'epic' || msg.rarity === 'legendary')) {
      stage.classList.remove('shake', 'gold')
      stage.classList.add('shake')
      if (msg.rarity === 'legendary') stage.classList.add('gold')
      clearTimeout(fxTimer)
      fxTimer = setTimeout(() => stage.classList.remove('shake', 'gold'), 2200)
    }
  }

  // —— 宿主消息处理（IDE Webview 与本地预览共用同一套逻辑）——
  function onMessage(msg) {
    if (!msg) return
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
    } else if (msg.type === 'drop') showDrop(msg)
    else if (msg.type === 'arsenalData') {
      arsenal = {
        owned: msg.owned,
        pity: msg.pity,
        pityLimit: msg.pityLimit,
        equipped: msg.equipped || null,
        shown: msg.shown || null,
        atkBase: msg.atkBase,
        atkTotal: msg.atkTotal,
        list: msg.list,
        sprites: msg.sprites,
      }
      if (!selectedId) {
        // 默认选中：最近获得的那把 → 否则当前携带的 → 否则第一把已收集 → 否则列表第一把
        const lastId = state && state.arsenal && state.arsenal.last ? state.arsenal.last.id : null
        const ownedIds = msg.list.filter((w) => msg.owned && msg.owned[w.id]).map((w) => w.id)
        selectedId =
          (lastId && msg.owned && msg.owned[lastId] ? lastId : null) ||
          (msg.shown ? msg.shown.id : null) ||
          ownedIds[0] ||
          (msg.list[0] && msg.list[0].id) ||
          null
      }
      if (view === 'arsenal') renderArsenal()
    } else if (msg.type === 'bestiaryData') {
      bestiary = {
        seen: msg.seen || {},
        defeated: msg.defeated || {},
        list: msg.list || [],
        sprites: msg.sprites || {},
      }
      if (!selectedEnemyId) {
        // 默认选中：当前正在战斗的那只 → 否则第一只已遭遇 → 否则列表第一个
        const cur = msg.current || null
        const seenIds = (msg.list || []).filter((e) => msg.seen && msg.seen[e.id]).map((e) => e.id)
        selectedEnemyId =
          (cur && msg.seen && msg.seen[cur] ? cur : null) ||
          seenIds[0] ||
          ((msg.list || [])[0] ? msg.list[0].id : null)
      }
      if (view === 'bestiary') renderBestiary()
    } else if (msg.type === 'view') switchView(msg.view)
  }

  // —— 视图切换 / 更换武器入口：IDE 与本地预览都需要 ——
  const bindTabs = () => {
    const tabBattle = $('tabBattle')
    if (tabBattle) tabBattle.onclick = () => switchView('battle')
    const tabArsenal = $('tabArsenal')
    if (tabArsenal) tabArsenal.onclick = () => switchView('arsenal')
    const tabBestiary = $('tabBestiary')
    if (tabBestiary) tabBestiary.onclick = () => switchView('bestiary')
    // 点装备槽 / 「更换武器」按钮 → 跳到武器库并选中当前携带的武器，方便更换
    const goChangeWeapon = () => {
      const id = state && state.arsenal && state.arsenal.shown ? state.arsenal.shown.id : null
      switchView('arsenal')
      if (id && arsenal) selectWeapon(id)
    }
    const slotEl = $('slot')
    if (slotEl) slotEl.onclick = goChangeWeapon
    const btnChange = $('changeWpn')
    if (btnChange) btnChange.onclick = goChangeWeapon
  }
  bindTabs()
  // 初始视图显式设一次：面板一打开就必须是战斗页。
  // 不加这行时，本地预览曾出现首帧被判成 hidden、场景整个不可见的情况
  // ——真机首帧由宿主消息驱动，本地预览没有宿主，需要这里兜底。
  switchView('battle')

  if (hasHost) {
    window.addEventListener('message', (e) => onMessage(e.data || {}))
    const btnAttack = $('attack')
    if (btnAttack) btnAttack.onclick = () => api.postMessage({ type: 'attack' })
    const btn = $('reset')
    if (btn) btn.onclick = () => api.postMessage({ type: 'reset' })
    const btnExpand = $('expand')
    if (btnExpand) btnExpand.onclick = () => api.postMessage({ type: 'expand' })
    const eqBtn = $('aEquip')
    if (eqBtn) eqBtn.onclick = () => { if (selectedId) api.postMessage({ type: 'equip', id: selectedId }) }
    const autoBtn = $('aAuto')
    if (autoBtn) autoBtn.onclick = () => api.postMessage({ type: 'equip', id: null })
    api.postMessage({ type: 'ready' })
    return
  }

  // ———— 独立预览：无宿主时用注入的假数据自走演示 ————
  const mock = typeof window !== 'undefined' ? window.__NIBBLE_MOCK__ : null
  if (mock) {
    state = Object.assign({ level: 1, hp: 24, maxHp: 40, enemyName: '空指针幽灵', enemyTierLabel: '小怪', rarityLabel: '普通', rarityColor: '#FFB86B', log: 'Nibble 攻击！空指针幽灵 -8 HP' }, mock)
    // 预览页可注入额外消息（怪物库/武器库数据），走与宿主完全相同的一套逻辑
    const queued = (typeof window !== 'undefined' && window.__NIBBLE_MOCK_MSGS__) || []
    queued.forEach((m) => onMessage(m))
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
        state.log = '击败 **' + state.enemyName + '**（小怪·普通）！🆕 收录进怪物库 +42XP　✦ 获得 稀有·重构之刃！　新的野生 无尽轮回蛇（小怪·普通）出现'
        showDrop({ name: '重构之刃', rarity: 'rare', rarityLabel: '稀有', color: '#FFE066', sprite: state.weaponSprite })
      } else {
        state.log = 'Nibble 攻击！' + state.enemyName + ' -' + dmg + ' HP'
      }
      lunge = 3
      render()
    }, 2600)
  }
})()
