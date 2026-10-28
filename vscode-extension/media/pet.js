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
  let skills = null // { owned, pity, slots, expect, combos, list, sprites } 技能书（50 本 + 4 槽）
  let selectedSkillId = null // 技能书页当前选中的那本
  // 施放管线（第五刀·表现）：命中帧之前冻结"出手前的旧值"（先出手、再打击）。
  //   phase 由宿主 tick.castPhase 报；敌方 HP 冻到命中帧、玩家 HP 冻到反击帧（没反击就冻到命中帧）、
  //   击杀的怪名再续几帧（等场景把那只怪消散完才让位给新怪）。
  let pipe = null
  let castMsg = null // 最近一次 cast 消息（命中帧的抖屏要读它的 tier/fx）
  let killName = null // 击杀消散期间继续显示的"被打死那只"（含名字/档位/稀有度）
  let killNameTicks = 0 // killName 的剩余帧数
  let lastDefeats = null // 上一次的击杀数：增加时让小屋播庆祝（actor 内部 30 秒节流）

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
    // 技能书 4 槽 + 倍率/组合（倍率不含标签；标签与组合的实战效果见 10 文档 3.2.1）
    renderBattleSlots()
    const ksumEl = $('ksum')
    if (ksumEl) {
      ksumEl.textContent = skills && skills.filled
        ? '技能 ' + skills.filled + '/4 倍率 ×' + skills.expect.toFixed(2) + (skills.combos.length ? ' 组合 ' + skills.combos.length : '')
        : ''
    }

    $('lv').textContent = 'Lv ' + state.level
    // 主角头顶的经验条（新面板用；旧面板没有这个节点，取空则跳过）
    const expEl = $('expbar')
    if (expEl) {
      const need = Math.max(1, state.xpNeed || 1)
      expEl.style.width = Math.max(0, Math.min(100, Math.round(((state.exp || 0) / need) * 100))) + '%'
    }
    // 施放管线（第五刀）：命中帧之前显示出手前的旧值（击杀的怪名续到消散结束）
    const hold = killName
    const dHp = pipe && pipe.phase < pipe.impactAt ? pipe.hpBefore : state.hp
    const dMax = pipe && pipe.phase < pipe.impactAt ? pipe.maxHpBefore || state.maxHp : state.maxHp
    const ratio = Math.max(0, dHp) / Math.max(1, dMax)
    const bar = $('hpbar')
    bar.style.width = Math.round(ratio * 100) + '%'
    bar.style.background = ratio > 0.5 ? '#4ECDC4' : ratio > 0.25 ? '#FFE066' : '#FF6B6B'
    // 数值区显示**玩家** HP（第三刀）：敌方血量由上面的敌方血条表达
    const hpnumEl = $('hpnum')
    if (hpnumEl) {
      const rawPhp = typeof state.playerHp === 'number' ? state.playerHp : null
      const php = pipe && pipe.phase < pipe.playerAt && rawPhp !== null ? pipe.playerHpBefore : rawPhp
      const pmax = state.playerMaxHp || 0
      hpnumEl.textContent = php === null ? '' : 'HP ' + php + '/' + pmax
      hpnumEl.title = '玩家血量：被怪物反击扣减，击杀回满；见底会被击退（零惩罚）'
      hpnumEl.style.color = php !== null && pmax && php / pmax <= 0.3 ? '#FF6B6B' : ''
    }
    const name = $('ename')
    const dName = hold ? hold.name : state.enemyName
    const dTier = hold ? hold.tierLabel : state.enemyTierLabel
    const dRarity = hold ? hold.rarityLabel : state.rarityLabel
    name.textContent = dName + '（' + (dTier || '小怪') + '·' + dRarity + '）'
    name.style.color = (hold && hold.color) || state.rarityColor || '#FFB86B'
    name.title = state.enemyMech || ''
    setLog(state.log)
  }

  function applyState(msg) {
    state = Object.assign({}, state, msg)
    render()
  }

  // —— 视图切换：战斗 / 武器库 / 怪物库 / 技能书 / 小屋 ——
  // 官网复用同一份 pet.js，但 DOM 里没有小屋节点，所以 home 相关一律判空。
  function switchView(v) {
    view = v === 'arsenal' || v === 'bestiary' || v === 'skill' || v === 'home' ? v : 'battle'
    const b = $('battleView'); const a = $('arsenalView'); const m = $('bestiaryView'); const k = $('skillView')
    const h = $('homeView')
    if (!b || !a || !m) return
    b.classList.toggle('hidden', view !== 'battle')
    a.classList.toggle('hidden', view !== 'arsenal')
    m.classList.toggle('hidden', view !== 'bestiary')
    if (k) k.classList.toggle('hidden', view !== 'skill')
    if (h) h.classList.toggle('hidden', view !== 'home')
    const tb = $('tabBattle'); const ta = $('tabArsenal'); const tm = $('tabBestiary'); const tk = $('tabSkill')
    const th = $('tabHome')
    if (tb) tb.classList.toggle('active', view === 'battle')
    if (ta) ta.classList.toggle('active', view === 'arsenal')
    if (tm) tm.classList.toggle('active', view === 'bestiary')
    if (tk) tk.classList.toggle('active', view === 'skill')
    if (th) th.classList.toggle('active', view === 'home')
    if (view === 'arsenal') renderArsenal()
    if (view === 'bestiary') renderBestiary()
    if (view === 'skill') renderSkills()
    // 小屋只在激活时跑渲染循环，切走必须停，避免和宿主的 tick() 抢主线程
    if (window.NibbleHome) {
      if (view === 'home') window.NibbleHome.mount()
      else window.NibbleHome.unmount()
    }
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

  // ———— 技能书页：进度条 / 图例 / 4 槽 / 详情卡（含槽位按钮）/ 分组网格 ————
  function skillById(id) {
    if (!skills || !skills.list) return null
    for (let i = 0; i < skills.list.length; i++) if (skills.list[i].id === id) return skills.list[i]
    return null
  }

  function combosWith(tags) {
    const all = (skills && skills.combosAll) || []
    return all.filter((c) => c.tags.every((k) => tags[k])).map((c) => ({ id: c.id, name: c.name, desc: c.desc }))
  }

  // 标签在当前稀有度下的实际效果文案（弱档 = 普通/稀有，强档 = 史诗/传说）
  function tagDescOf(sk) {
    const strong = sk.rarity === 'epic' || sk.rarity === 'legendary'
    const d = skills.tagDesc && skills.tagDesc[sk.tag]
    return d ? d[strong ? 'strong' : 'weak'] : ''
  }

  function makeSkillCell(sk, n) {
    const cell = document.createElement('div')
    cell.className = 'wcell' + (n ? ' owned' : ' locked')
    cell.dataset.id = sk.id
    if (sk.id === selectedSkillId) cell.classList.add('sel')
    cell.title = n
      ? sk.name + (n > 1 ? ' ×' + n : '') + '（' + sk.tagLabel + '）'
      : sk.name + '（未收集）'
    const cv = document.createElement('canvas')
    cv.width = SIZE
    cv.height = SIZE
    drawSprite(cv, skills.sprites[sk.id], 0, 0, false)
    if (!n) {
      // 未收集：暗剪影（与武器/怪物一致）
      const ctx = cv.getContext('2d')
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = '#20263a'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.globalCompositeOperation = 'source-over'
    } else {
      const dot = document.createElement('span')
      dot.className = 'dot'
      dot.style.background = RARITY_TEXT_COLOR[sk.rarity]
      cell.appendChild(dot)
    }
    cell.appendChild(cv)
    if (n > 1) {
      const badge = document.createElement('span')
      badge.className = 'cnt'
      badge.textContent = '×' + n
      cell.appendChild(badge)
    }
    if (skills.slots.indexOf(sk.id) >= 0) {
      const eq = document.createElement('span')
      eq.className = 'eq'
      eq.textContent = '★'
      cell.appendChild(eq)
    }
    cell.onclick = () => selectSkill(sk.id)
    return cell
  }

  // 技能页的 4 个槽位：点一下卸下（换装免费可逆 = 护栏 ②）
  function renderSkillSlotsView() {
    const wrap = $('kslotsView')
    if (!wrap) return
    wrap.textContent = ''
    const title = document.createElement('span')
    title.className = 'ktitle'
    title.textContent = '上阵'
    wrap.appendChild(title)
    for (let i = 0; i < 4; i++) {
      const id = skills.slots[i] || null
      const sk = id ? skillById(id) : null
      const box = document.createElement('div')
      box.className = 'kslotView' + (sk ? '' : ' empty')
      const cv = document.createElement('canvas')
      cv.width = SIZE
      cv.height = SIZE
      drawSprite(cv, sk ? skills.sprites[sk.id] : null, 0, 0, !sk)
      box.appendChild(cv)
      const nm = document.createElement('span')
      nm.className = 'kname'
      nm.textContent = sk ? sk.name : '空槽 ' + (i + 1)
      box.appendChild(nm)
      box.title = sk ? '点击卸下「' + sk.name + '」' : '空槽：出手时按普攻（不惩罚）'
      box.onclick = () => { if (sk && api) api.postMessage({ type: 'skillEquip', id: null, slot: i }) }
      wrap.appendChild(box)
    }
    const exp = document.createElement('span')
    exp.className = 'kexp'
    exp.textContent = skills.filled ? '倍率 ×' + skills.expect.toFixed(2) : '空槽 = 普攻（不惩罚）'
    wrap.appendChild(exp)
  }

  function renderSkills() {
    if (!skills || !skills.list) return
    const owned = skills.owned || {}
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 }
    const totals = { common: 0, rare: 0, epic: 0, legendary: 0 }
    const byR = { common: [], rare: [], epic: [], legendary: [] }
    skills.list.forEach((sk) => {
      totals[sk.rarity]++
      byR[sk.rarity].push(sk)
      if (owned[sk.id]) counts[sk.rarity]++
    })
    const uniq = Object.keys(owned).length
    $('klegend').innerHTML =
      '<span class="atotal">✦ ' + uniq + '/' + skills.list.length + '</span>' +
      (skills.filled ? '<span class="achip">倍率 ×' + skills.expect.toFixed(2) + '（不含标签）</span>' : '') +
      (skills.combos.length
        ? '<span class="achip">组合 ' + skills.combos.map((c) => c.name).join(' · ') + '</span>'
        : '') +
      RARITY_ORDER.map(
        (r) =>
          '<span class="achip"><i style="background:' + RARITY_TEXT_COLOR[r] + '"></i>' +
          RARITY_LABEL[r] + ' ' + counts[r] + '/' + totals[r] + '</span>',
      ).join('') +
      '<span class="apity">保底 ' + skills.pity + '/' + skills.pityLimit + '</span>'
    const segs = $('kbar').children
    RARITY_ORDER.forEach((r, i) => {
      const seg = segs[i]
      if (!seg) return
      seg.style.flexGrow = String(totals[r] || 1)
      const fill = seg.firstElementChild
      fill.style.background = RARITY_TEXT_COLOR[r]
      fill.style.width = (totals[r] ? Math.round((counts[r] / totals[r]) * 100) : 0) + '%'
    })
    renderSkillSlotsView()
    const wrap = $('kgroups')
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
      byR[r].forEach((sk) => grid.appendChild(makeSkillCell(sk, owned[sk.id] || 0)))
      group.appendChild(head)
      group.appendChild(grid)
      wrap.appendChild(group)
    })
    renderSkillDetail()
  }

  function selectSkill(id) {
    selectedSkillId = id
    const cells = document.querySelectorAll('#kgroups .wcell')
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('sel', cells[i].dataset.id === selectedSkillId)
    }
    renderSkillDetail()
  }

  function renderSkillDetail() {
    const sk = skillById(selectedSkillId)
    const cv = $('kdetailIcon')
    if (cv) drawSprite(cv, sk ? skills.sprites[sk.id] : null, 0, 0, !sk)
    const nameEl = $('kdetailName')
    const storyEl = $('kdetailStory')
    const btns = $('kdetailBtns')
    if (!btns) return
    btns.textContent = ''
    if (!sk) {
      if (nameEl) nameEl.textContent = '—'
      if (storyEl) storyEl.textContent = '点选下方格子，查看这本技能书的注记与可触发的组合'
      return
    }
    const owned = skills.owned && skills.owned[sk.id]
    if (nameEl) nameEl.textContent = sk.name + '　' + RARITY_LABEL[sk.rarity] + '·' + sk.tagLabel
    const tags = {}
    skills.slots.forEach((id) => {
      const s2 = skillById(id)
      if (s2) tags[s2.tag] = true
    })
    const now = combosWith(tags)
    if (skills.slots.indexOf(sk.id) < 0) tags[sk.tag] = true
    const after = combosWith(tags)
    const added = after.filter((c) => !now.some((n2) => n2.id === c.id))
    const parts = []
    parts.push('【倍率】×' + sk.power.toFixed(2) + '　【出手权重】' + sk.weight)
    parts.push('【标签】' + sk.tagLabel + '：' + tagDescOf(sk))
    if (sk.story) parts.push(sk.story)
    if (added.length) parts.push('【上阵后触发】' + added.map((c) => c.name + '：' + c.desc).join('；'))
    else if (now.length) parts.push('【已触发组合】' + now.map((c) => c.name).join(' · '))
    if (storyEl) storyEl.textContent = parts.join('\n')
    if (!owned) {
      const tip = document.createElement('span')
      tip.className = 'aname'
      tip.textContent = '未收集'
      btns.appendChild(tip)
      return
    }
    // 4 个槽位按钮单独一行（跟在故事文本下面）：按钮文案长，挤在右侧会把正文压窄
    const host = (storyEl && storyEl.parentNode) || btns
    const oldRow = document.getElementById('kslotBtns')
    if (oldRow && oldRow.parentNode) oldRow.parentNode.removeChild(oldRow)
    const row = document.createElement('div')
    row.id = 'kslotBtns'
    row.className = 'kslotBtns'
    for (let i = 0; i < 4; i++) {
      const cur = skills.slots[i] || null
      const curSk = cur ? skillById(cur) : null
      const equippedHere = cur === sk.id
      const b = document.createElement('button')
      b.textContent = equippedHere
        ? '卸下（槽 ' + (i + 1) + '）'
        : '装到槽 ' + (i + 1) + (curSk ? '：换下 ' + curSk.name : '')
      b.onclick = () => {
        if (api) api.postMessage({ type: 'skillEquip', id: equippedHere ? null : sk.id, slot: i })
      }
      row.appendChild(b)
    }
    host.appendChild(row)
    const auto = document.createElement('button')
    auto.textContent = '一键推荐'
    auto.onclick = () => { if (api) api.postMessage({ type: 'skillAuto' }) }
    btns.appendChild(auto)
  }

  // 战斗页右下角的 4 槽（空槽显示序号；素材缺失时留空，不报错）
  function renderBattleSlots() {
    const wrap = $('kslotWrap')
    if (!wrap) return
    const cells = wrap.children
    const slots = (skills && skills.slots) || [null, null, null, null]
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      const sk = slots[i] ? skillById(slots[i]) : null
      cell.classList.toggle('empty', !sk)
      const cv = cell.querySelector('canvas')
      if (cv) drawSprite(cv, sk ? skills.sprites[sk.id] : null, 0, 0, !sk)
      cell.style.borderColor = sk ? RARITY_TEXT_COLOR[sk.rarity] || '' : ''
      cell.title = sk
        ? sk.name + '（' + RARITY_LABEL[sk.rarity] + '·' + sk.tagLabel + '）· 点击去技能书页更换'
        : '空槽（按普攻）· 点击去技能书页装配'
    }
  }

  // 导航上的技能书计数 + 首次引导高亮（"有书但一本没上阵"）
  function syncNavSkill() {
    const el = $('navSkill')
    if (el) {
      el.textContent = skills && skills.list ? Object.keys(skills.owned || {}).length + '/' + skills.list.length : ''
    }
    const tab = $('tabSkill')
    if (tab) tab.classList.toggle('hl', !!(skills && skills.guide))
  }

  // —— 被击退演出（第三刀）：闪白 + 场景抖动，跳变显隐、不做过渡 ——
  let kbFlashTimer = null
  let kbShakeTimer = null
  function playKnockback() {
    const flash = $('flash')
    if (flash) {
      flash.classList.remove('hidden')
      clearTimeout(kbFlashTimer)
      kbFlashTimer = setTimeout(() => flash.classList.add('hidden'), 420)
    }
    const stage = document.querySelector('.stage')
    if (stage) {
      stage.classList.remove('shake')
      stage.classList.add('shake')
      clearTimeout(kbShakeTimer)
      kbShakeTimer = setTimeout(() => stage.classList.remove('shake'), 700)
    }
  }

  // —— 技能施放（第四刀·表现）：施放横幅 + 战斗页 4 槽高亮 ——
  // 让"这一击用了哪本书"可见：这是技能系统唯一的即时反馈，缺了它玩家不知道技能生效了。
  // 硬规矩照 09/10：跳变显隐、不做过渡；槽位高亮走 box-shadow（borderColor 被稀有度色占用）。
  let castBanTimer = null
  let castSlotTimer = null
  let castShakeTimer = null
  function playCast(msg) {
    const heavy = (msg.tier || 1) >= 3
    const fx = msg.fx || {}
    // ① 4 槽高亮：抽中哪本，哪一格亮起
    const wrap = $('kslotWrap')
    if (wrap && typeof msg.slot === 'number' && msg.slot >= 0) {
      for (let i = 0; i < wrap.children.length; i++) wrap.children[i].classList.toggle('cast', i === msg.slot)
      clearTimeout(castSlotTimer)
      castSlotTimer = setTimeout(() => {
        for (let i = 0; i < wrap.children.length; i++) wrap.children[i].classList.remove('cast')
      }, 1200)
    }
    // ② 施放横幅：书图标 + 书名 + 标签（重档标注"重击"，必暴加"暴击"）
    const ban = $('castBan')
    if (ban) {
      const nm = $('castName')
      const tg = $('castTag')
      const ic = $('castIcon')
      if (nm) nm.textContent = msg.name || ''
      if (tg) {
        tg.textContent = (msg.tagLabel || '') + (heavy ? ' · 重击' : '') + (fx.crit ? ' · 暴击' : '')
      }
      if (ic) {
        // 书图标：满格 24 网格直接铺上（没有就不占位——老宿主/无 mock 的页面）
        if (msg.icon && msg.icon.length) {
          const ictx = ic.getContext('2d')
          ictx.clearRect(0, 0, 24, 24)
          for (let i = 0; i < msg.icon.length; i++) {
            if (!msg.icon[i]) continue
            ictx.fillStyle = msg.icon[i]
            ictx.fillRect(i % 24, (i / 24) | 0, 1, 1)
          }
          ic.classList.remove('hidden')
        } else {
          ic.classList.add('hidden')
        }
      }
      ban.style.setProperty('--castc', msg.color || '#ffd75e')
      ban.classList.toggle('heavy', heavy)
      ban.classList.remove('hidden')
      clearTimeout(castBanTimer)
      castBanTimer = setTimeout(() => ban.classList.add('hidden'), 1200)
    }
    // ③ 重档 / 必暴的抖屏挪到了**命中帧**（见 onMessage 的 tick 分支）——
    //    收到 cast 就抖会早于"打击"，管线的口径是先出手、再打击
  }

  // 抖一下（复用掉落 toast 的 .stage.shake，不新增动画）
  function shakeStage() {
    const stage = document.querySelector('.stage')
    if (!stage) return
    stage.classList.remove('shake')
    stage.classList.add('shake')
    clearTimeout(castShakeTimer)
    castShakeTimer = setTimeout(() => stage.classList.remove('shake'), 400)
  }

  // —— 战利品 toast（史诗以上带震动，传说再加金光）——
  let toastTimer = null
  let fxTimer = null
  // 击杀演出期间先挂起：等飞书落地（scene.js 推 bookLanded）再弹——提示与"打飞→碎裂→飞书"同一拍。
  // 兜底 3.2s：万一场景层没跑（旧面板/异常），提示不能丢。
  let pendingDrop = null
  let pendingDropTimer = null
  function flushDrop() {
    const m = pendingDrop
    pendingDrop = null
    clearTimeout(pendingDropTimer)
    if (m) showDropNow(m)
  }
  function showDrop(msg) {
    if (msg.kind === 'skill' && pipe && castMsg && castMsg.killed) {
      pendingDrop = msg
      clearTimeout(pendingDropTimer)
      pendingDropTimer = setTimeout(flushDrop, 3200)
      return
    }
    showDropNow(msg)
  }
  function showDropNow(msg) {
    const toast = $('toast')
    if (!toast) return
    drawSprite($('toastIcon'), msg.sprite, 0, 0, !msg.sprite)
    const t = $('toastText')
    const isSkill = msg.kind === 'skill'
    const head = escapeHtml((isSkill ? '获得技能书 ' : '获得 ') + (msg.rarityLabel || '') + '·' + msg.name + '！')
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
    // 小屋（家园）存档跟着 tick/state 一起到。applyHome 只在第一次生效，
    // 之后以本地摆放为准，重复调用是空操作。
    if (msg.home && window.NibbleHome) {
      window.NibbleHome.applyHome(msg.home)
      // 久别状态（落灰/趴睡/醒来）每次 state 都要同步，不能像布局那样只认第一次
      if (window.NibbleHome.setMood) window.NibbleHome.setMood(msg.home)
    }
    if (msg.type === 'state') applyState(msg)
    else if (msg.type === 'tick') {
      tick = msg
      if (state) {
        state.hp = msg.hp
        state.maxHp = msg.maxHp
        state.level = msg.level
        state.log = msg.log
        // 风险层（第三刀）：玩家血量随每次攻击变化
        if (typeof msg.playerHp === 'number') state.playerHp = msg.playerHp
        if (typeof msg.playerMaxHp === 'number') state.playerMaxHp = msg.playerMaxHp
      }
      // 击杀庆祝（小屋表演层）：defeats 增加即触发，actor 内部做 30 秒节流
      if (typeof msg.defeats === 'number') {
        if (lastDefeats !== null && msg.defeats > lastDefeats && window.NibbleHome) window.NibbleHome.celebrate()
        lastDefeats = msg.defeats
      }
      if (killNameTicks > 0 && --killNameTicks === 0) killName = null
      if (pipe) {
        // 相位由宿主报（tick.castPhase）；没有该字段的老宿主按 tick 计数兜底推进
        pipe.phase = typeof msg.castPhase === 'number' && msg.castPhase >= 0 ? msg.castPhase : pipe.phase + 1
        if (!pipe.hitDone && pipe.phase >= pipe.impactAt) {
          pipe.hitDone = true // 命中帧：血条/玩家 HP 在 render 里解冻；重档/必暴这时才抖屏
          if (castMsg && ((castMsg.tier || 1) >= 3 || (castMsg.fx && castMsg.fx.crit))) shakeStage()
        }
        if (pipe.phase >= pipe.frames) pipe = null
      }
      render()
    } else if (msg.type === 'drop') showDrop(msg)
    else if (msg.type === 'bookLanded') flushDrop() // 飞书落地：挂起的技能书提示这时才弹
    else if (msg.type === 'knockback') playKnockback()
    else if (msg.type === 'cast') {
      // 技能出手（第五刀·施放管线）：横幅/槽位高亮立即播（这是"起手"），
      // 血条与击杀换怪冻结到命中帧（hitDone），画面在 scene.js
      const frames = msg.frames || 3
      const impactAt = msg.impactAt == null ? 2 : msg.impactAt
      pipe = {
        frames,
        impactAt,
        phase: 0,
        hitDone: false,
        hpBefore: typeof msg.hpBefore === 'number' ? msg.hpBefore : state ? state.hp : 0,
        maxHpBefore: typeof msg.maxHpBefore === 'number' ? msg.maxHpBefore : state ? state.maxHp : 1,
        playerHpBefore: typeof msg.playerHpBefore === 'number' ? msg.playerHpBefore : state ? state.playerHp : 0,
        // 玩家只会被反击扣血：有反击帧就冻到末帧，否则命中帧解冻
        playerAt: msg.countered ? frames - 1 : impactAt,
      }
      castMsg = msg
      if (msg.killed && msg.killedEnemy) {
        killName = msg.killedEnemy
        killNameTicks = frames + 7 // 管线帧 + 消散 6 帧
      }
      playCast(msg)
    }
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
      // 小屋的墙面陈列直接复用这份精灵数据，不再单独向后端要
      if (window.NibbleHome) window.NibbleHome.setAssets('weapons', msg.list, msg.sprites, msg.owned)
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
      if (window.NibbleHome) window.NibbleHome.setAssets('enemies', msg.list, msg.sprites, msg.defeated)
      if (view === 'bestiary') renderBestiary()
    } else if (msg.type === 'skillData') {
      skills = {
        owned: msg.owned || {},
        pity: msg.pity || 0,
        pityLimit: msg.pityLimit || 30,
        slots: msg.slots || [null, null, null, null],
        filled: (msg.slots || []).filter(Boolean).length, // 空槽 = 普攻，不参与抽签
        expect: msg.expect || 1,
        combos: msg.combos || [],
        guide: !!msg.guide,
        list: msg.list || [],
        sprites: msg.sprites || {},
        tags: msg.tags || {},
        tagDesc: msg.tagDesc || {},
        combosAll: msg.combosAll || [],
      }
      if (!selectedSkillId) {
        // 默认选中：最近获得的那本 → 已上阵的第一本 → 第一本已收集 → 列表第一本
        const lastId = state && state.skills && state.skills.last ? state.skills.last.id : null
        const ownedIds = (msg.list || []).filter((x) => msg.owned && msg.owned[x.id]).map((x) => x.id)
        selectedSkillId =
          (lastId && msg.owned && msg.owned[lastId] ? lastId : null) ||
          (msg.slots || []).filter(Boolean)[0] ||
          ownedIds[0] ||
          ((msg.list || [])[0] ? msg.list[0].id : null) ||
          null
      }
      syncNavSkill()
      renderBattleSlots()
      if (view === 'skill') renderSkills()
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
    const tabSkill = $('tabSkill')
    if (tabSkill) tabSkill.onclick = () => switchView('skill')
    const tabHome = $('tabHome')
    if (tabHome) tabHome.onclick = () => switchView('home')
    // 战斗页右下角的 4 槽：点任意格子 → 技能书页（并选中槽里那本，方便换）
    const strip = $('kslotWrap')
    if (strip) {
      strip.onclick = () => {
        const first = skills && skills.slots ? skills.slots.filter(Boolean)[0] : null
        switchView('skill')
        if (first && skills) selectSkill(first)
      }
    }
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
    // 小屋布局变更 → 一条消息落盘（松手/换套装才发，不在拖动过程中连续写）
    if (window.NibbleHome) {
      window.NibbleHome.setCommit((home) => api.postMessage({ type: 'homeSave', home }))
      // 久别醒来的演出播完 → 回写 seen（否则每次启动都重演一遍）
      window.NibbleHome.setWakeSeen((at) => api.postMessage({ type: 'homeWakeSeen', at }))
    }
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
    // 预览页可注入技能施放样张（make-preview 注入 __NIBBLE_PREVIEW_CASTS__ 时轮播展示）
    const demoCasts = (typeof window !== 'undefined' && window.__NIBBLE_PREVIEW_CASTS__) || null
    let dc = 0
    // 预览页没有宿主：把本地模拟的 tick / 施放广播到 window，让画布层（scene.js）也跟着动。
    // 真机里这些消息由宿主同时推给两个模块，这里只补预览页缺的那一半（pet.js 只在有宿主时才监听 window）。
    const broadcast = (m) => {
      try { window.dispatchEvent(new MessageEvent('message', { data: m })) } catch { /* 老环境忽略 */ }
    }
    // 预览页没有宿主，pet.js 自己不监听 window；飞书落地这条由 scene.js 推回来，单独补一条
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'bookLanded') flushDrop()
    })
    // 预览页自己模拟宿主的相位时钟（真机由 tick.castPhase 驱动）
    let pipePhase = -1
    let pipeFrames = 0
    render()
    setInterval(() => {
      if (holdCasts) return
      f = (f + 1) % 2
      if (lunge > 0) lunge--
      if (pipePhase >= 0 && ++pipePhase >= pipeFrames) pipePhase = -1
      tick = { frame: f, lunge: lunge > 0, dissolve: false }
      // tick 也要走一遍 onMessage：施放管线的相位推进在 pet.js 的 tick 分支里（与真机同一条路）
      const tm = Object.assign({ type: 'tick', hp: state.hp, maxHp: state.maxHp, level: state.level, log: state.log, playerHp: state.playerHp, playerMaxHp: state.playerMaxHp, castPhase: pipePhase }, tick)
      onMessage(tm)
      broadcast(tm)
    }, 700)
    setInterval(() => {
      if (holdCasts) return
      const dmg = 4 + Math.floor(Math.random() * 7)
      const hpBefore = state.hp
      const phpBefore = typeof state.playerHp === 'number' ? state.playerHp : 0
      state.hp = Math.max(0, state.hp - dmg)
      const killed = state.hp <= 0
      state.lastDmg = dmg
      let killedDrop = null
      if (killed) {
        state.hp = state.maxHp
        state.log = '击败 **' + state.enemyName + '**（小怪·普通）！🆕 收录进怪物库 +42XP　✦ 获得 稀有·重构之刃！　新的野生 无尽轮回蛇（小怪·普通）出现'
        // 预览页演"掉落飞书"：真机由宿主推 drop(kind:'skill')，这里自己造一条同样的消息。
        // 顺序也照真机——先推 cast 再推 drop（反了的话提示不会等飞书落地）
        const book = skills && skills.list && skills.list.length ? skills.list[0] : null
        killedDrop = {
          type: 'drop', kind: 'skill',
          name: book ? book.name : '重构之刃',
          rarity: book ? book.rarity : 'rare',
          rarityLabel: '稀有',
          color: '#7FC8FF',
          sprite: (book && skills.sprites && skills.sprites[book.id]) || state.weaponSprite,
        }
      } else {
        // 未击杀 → 怪物会反击（第三刀）：预览页给一点固定的小额反击，玩家 HP 在反击帧才解冻
        if (phpBefore > 0) state.playerHp = Math.max(1, phpBefore - (2 + Math.floor(Math.random() * 4)))
        state.log = 'Nibble 攻击！' + state.enemyName + ' -' + dmg + ' HP'
      }
      // 技能施放样张（仅预览页）：轮播 12 个招式原语，消息带全管线字段（与真机同一条数据通路）
      if (demoCasts && demoCasts.length) {
        const cm = demoCasts[dc++ % demoCasts.length]
        const frames = 3 + (cm.fx && cm.fx.chase ? 1 : 0) + (killed ? 0 : 1)
        const m = Object.assign({ type: 'cast' }, cm, {
          frames,
          impactAt: 2,
          countered: !killed,
          hpBefore,
          maxHpBefore: state.maxHp,
          playerHpBefore: phpBefore,
          killed,
          killedEnemy: killed
            ? {
                type: state.enemyType || 'mock', tier: state.enemyTier || 'common',
                name: state.enemyName, tierLabel: state.enemyTierLabel || '小怪',
                rarityLabel: state.rarityLabel, color: state.rarityColor,
                sprite: state.enemy,
              }
            : null,
        })
        onMessage(m)
        broadcast(m)
        if (!killed) state.log = 'Nibble 用「' + cm.name + '」攻击！' + state.enemyName + ' -' + dmg + ' HP'
        pipePhase = 0
        pipeFrames = frames
      }
      // 掉落跟在 cast 后面推（与宿主同序）：pet.js 会把"获得技能书"的提示挂到飞书落地再弹
      if (killedDrop) {
        showDrop(killedDrop)
        broadcast(killedDrop)
      }
      lunge = 3
      render()
    }, 2600)
    // 调试钩子（对齐 scene-lab 的 window.__lab）：自动化核对管线用——
    //   __nibbleDemo.cast(msg) 手动发一发施放（相位随后由 700ms 演示节拍推进）
    //   __nibbleDemo.setEnemyHp(v) 直接改敌方 HP（冻结/解冻的对照值）
    //   __nibbleDemo.hold(true) 暂停演示自己的攻击循环（700ms 节拍照走，管线照推进）
    let holdCasts = false
    window.__nibbleDemo = {
      cast(msg) {
        const frames = msg.frames || 3
        const m = Object.assign({ type: 'cast', frames, impactAt: 2 }, msg)
        if (typeof m.dmg === 'number') state.lastDmg = m.dmg
        onMessage(m)
        broadcast(m)
        pipePhase = 0
        pipeFrames = frames
        lunge = 3
        render()
      },
      setEnemyHp(v) {
        state.hp = v
        render()
      },
      hold(v) {
        holdCasts = !!v
      },
      // 手动走一拍（hold 时用）：phase = tick.castPhase；省略则按当前演示相位。
      // 注意不能把模块级 tick 摊进来——它已被 onMessage 赋成上一条 tick 消息，会把旧 castPhase 盖回来
      step(phase) {
        const tm = {
          type: 'tick', frame: 0, lunge: false, dissolve: false,
          hp: state.hp, maxHp: state.maxHp, level: state.level, log: state.log,
          playerHp: state.playerHp, playerMaxHp: state.playerMaxHp,
          castPhase: typeof phase === 'number' ? phase : pipePhase,
        }
        onMessage(tm)
        broadcast(tm)
      },
    }
    // 预览页快捷键：K 把当前怪打到 1 血——下一击必击杀，用来当场核对"打飞 / 碎裂 / 飞书"
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'k' && e.key !== 'K') return
      state.hp = 1
      render()
    })
  }
})()
