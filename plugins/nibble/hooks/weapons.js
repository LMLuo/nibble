'use strict'
// weapons.js — 武器库数据 + 掉落逻辑（纯收集，不影响任何战斗数值）
// 设计文档：docs/游戏升级规划/07-武器库收集系统设计.md
// 加武器 = 在 WEAPONS 数组追加 {id, name, rarity} + 在 legacy-mods/assets/weapons/ 补素材重跑构建。

const { WEAPON_PIXEL_DATA } = require('./weapons-pixels')
const { STORIES } = require('./weapons-stories')

const WEAPONS = [
  // —— 普通（40）：日常开发工具风 ——
  { id: 'nullptr_dagger', name: '空指针匕首', rarity: 'common' },
  { id: 'comment_knife', name: '注释小刀', rarity: 'common' },
  { id: 'enter_hammer', name: '回车锤', rarity: 'common' },
  { id: 'indent_sword', name: '缩进短剑', rarity: 'common' },
  { id: 'semicolon_spear', name: '分号长枪', rarity: 'common' },
  { id: 'bracket_axe', name: '括号斧', rarity: 'common' },
  { id: 'todo_dart', name: '便签飞镖', rarity: 'common' },
  { id: 'log_stick', name: '日志木棍', rarity: 'common' },
  { id: 'cache_bow', name: '缓存猎弓', rarity: 'common' },
  { id: 'loop_blade', name: '循环环刃', rarity: 'common' },
  { id: 'string_whip', name: '字符串软鞭', rarity: 'common' },
  { id: 'bug_net', name: '捕虫网', rarity: 'common' },
  { id: 'pipe_wrench', name: '管道扳手', rarity: 'common' },
  { id: 'regex_ruler', name: '正则直尺', rarity: 'common' },
  { id: 'compile_hammer', name: '编译锤', rarity: 'common' },
  { id: 'stack_spoon', name: '栈勺', rarity: 'common' },
  { id: 'heap_fork', name: '堆叉', rarity: 'common' },
  { id: 'byte_dart', name: '字节飞镖', rarity: 'common' },
  { id: 'hook_scythe', name: '钩子镰', rarity: 'common' },
  { id: 'shell_fork', name: 'Shell 餐叉', rarity: 'common' },
  { id: 'macro_mallet', name: '宏木槌', rarity: 'common' },
  { id: 'script_scalpel', name: '脚本手术刀', rarity: 'common' },
  { id: 'patch_shovel', name: '补丁铲', rarity: 'common' },
  { id: 'merge_paddle', name: '合并桨', rarity: 'common' },
  { id: 'diff_dagger', name: '差异匕首', rarity: 'common' },
  { id: 'branch_staff', name: '分支木杖', rarity: 'common' },
  { id: 'clone_cudgel', name: '克隆棍', rarity: 'common' },
  { id: 'commit_chisel', name: '提交凿', rarity: 'common' },
  { id: 'tag_card', name: '标签飞牌', rarity: 'common' },
  { id: 'stash_spear', name: '贮藏长矛', rarity: 'common' },
  { id: 'lint_broom', name: '检查扫帚', rarity: 'common' },
  { id: 'format_fan', name: '格式化折扇', rarity: 'common' },
  { id: 'indent_pick', name: '缩进冰锥', rarity: 'common' },
  { id: 'token_pick', name: '令签字签', rarity: 'common' },
  { id: 'pixel_pick', name: '像素镐', rarity: 'common' },
  { id: 'var_vane', name: '变量风向标', rarity: 'common' },
  { id: 'func_fork', name: '函数叉', rarity: 'common' },
  { id: 'polyfill_pebble', name: '垫片石子', rarity: 'common' },
  { id: 'case_club', name: '分支木棒', rarity: 'common' },
  { id: 'alpha_arrow', name: '首发箭', rarity: 'common' },

  // —— 稀有（25）：进阶概念风 ——
  { id: 'refactor_blade', name: '重构之刃', rarity: 'rare' },
  { id: 'recursion_bow', name: '递归长弓', rarity: 'rare' },
  { id: 'cache_dart', name: '缓存飞镖', rarity: 'rare' },
  { id: 'async_halberd', name: '异步长戟', rarity: 'rare' },
  { id: 'hash_hammer', name: '哈希重锤', rarity: 'rare' },
  { id: 'bitwise_claw', name: '位运算爪', rarity: 'rare' },
  { id: 'inline_rapier', name: '内联细剑', rarity: 'rare' },
  { id: 'coroutine_whip', name: '协程长鞭', rarity: 'rare' },
  { id: 'mutex_mace', name: '互斥锤', rarity: 'rare' },
  { id: 'promise_pike', name: 'Promise 骑枪', rarity: 'rare' },
  { id: 'lambda_fist', name: 'λ 拳套', rarity: 'rare' },
  { id: 'stack_slicer', name: '栈切片刀', rarity: 'rare' },
  { id: 'heap_harvester', name: '堆收割者', rarity: 'rare' },
  { id: 'pointer_partisan', name: '指针长矛', rarity: 'rare' },
  { id: 'closure_cleaver', name: '闭包砍刀', rarity: 'rare' },
  { id: 'stream_saber', name: '流光军刀', rarity: 'rare' },
  { id: 'socket_spear', name: '套接字矛', rarity: 'rare' },
  { id: 'daemon_dagger', name: '守护进程匕首', rarity: 'rare' },
  { id: 'kernel_knife', name: '内核小刀', rarity: 'rare' },
  { id: 'thread_thresher', name: '线程打谷刃', rarity: 'rare' },
  { id: 'buffer_broadsword', name: '缓冲巨剑', rarity: 'rare' },
  { id: 'parser_chakram', name: '解析飞轮', rarity: 'rare' },
  { id: 'regex_rapier', name: '正则迅捷剑', rarity: 'rare' },
  { id: 'opcode_scepter', name: '操作码权杖', rarity: 'rare' },
  { id: 'query_quiver', name: '查询箭袋', rarity: 'rare' },

  // —— 史诗（12）：底层灾难具象化 ——
  { id: 'deadlock_warhammer', name: '死锁战锤', rarity: 'epic' },
  { id: 'entropy_staff', name: '熵减法杖', rarity: 'epic' },
  { id: 'regex_edge', name: '正则之刃·万千匹配', rarity: 'epic' },
  { id: 'segfault_scythe', name: '段错误镰', rarity: 'epic' },
  { id: 'overflow_glaive', name: '溢出关刀', rarity: 'epic' },
  { id: 'race_blade', name: '竞态之刃', rarity: 'epic' },
  { id: 'leak_maul', name: '内存泄漏巨锤', rarity: 'epic' },
  { id: 'null_cataclysm', name: '空值天灾', rarity: 'epic' },
  { id: 'infinity_lance', name: '无穷循环圣枪', rarity: 'epic' },
  { id: 'quantum_debug_blade', name: '量子调试刃', rarity: 'epic' },
  { id: 'gc_guillotine', name: 'GC 处刑斧', rarity: 'epic' },
  { id: 'bigo_blade', name: '大 O 之刃', rarity: 'epic' },

  // —— 传说（3）：不进保底，真·稀有 ——
  { id: 'debug_zero', name: '归零圣剑·零号机', rarity: 'legendary' },
  { id: 'heat_death', name: '熵之终焉·热寂', rarity: 'legendary' },
  { id: 'genesis_commit', name: '创世提交·初始哈希', rarity: 'legendary' },
]

const WEAPON_INDEX = {}
for (const w of WEAPONS) {
  WEAPON_INDEX[w.id] = w
  w.story = STORIES[w.id] || '' // 回忆杀小故事（weapons-stories.js）
}

const WEAPON_TOTAL = WEAPONS.length
const RARITY_COUNTS = { common: 0, rare: 0, epic: 0, legendary: 0 }
for (const w of WEAPONS) RARITY_COUNTS[w.rarity] += 1

// 掉率与保底
const RARITY_DROP = { common: 0.7, rare: 0.22, epic: 0.07, legendary: 0.01 }
const PITY_LIMIT = 40 // 连续 40 次未出史诗以上 → 下次必出史诗

function pickByRarity(rarity) {
  const pool = []
  for (const w of WEAPONS) if (w.rarity === rarity) pool.push(w)
  return pool[Math.floor(Math.random() * pool.length)]
}

function rollRarity(pity) {
  if ((Number(pity) || 0) + 1 >= PITY_LIMIT) return 'epic'
  const r = Math.random()
  if (r < RARITY_DROP.common) return 'common'
  if (r < RARITY_DROP.common + RARITY_DROP.rare) return 'rare'
  if (r < RARITY_DROP.common + RARITY_DROP.rare + RARITY_DROP.epic) return 'epic'
  return 'legendary'
}

// 输入当前保底计数，返回 { weapon, pity }：出史诗/传说后清零，其余 +1
function rollWeapon(pity) {
  const cur = Number(pity) || 0
  const rarity = rollRarity(cur)
  return {
    weapon: pickByRarity(rarity),
    pity: rarity === 'epic' || rarity === 'legendary' ? 0 : cur + 1,
  }
}

// 裁剪到内容包围盒 + 等比放大到指定内框（默认填满 24x24），统一各素材的留白差异
// box：内框边长。满格用于战斗槽（显眼），17 用于图鉴网格（细长剑与胖锤视觉重量一致，不参差）
function fitToBox(grid, box) {
  const N = grid.length
  const B = Math.max(2, Math.min(N, box || N))
  let minX = N, minY = N, maxX = -1, maxY = -1
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!grid[y][x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return grid
  const cw = maxX - minX + 1
  const chh = maxY - minY + 1
  const scale = Math.min(B / cw, B / chh)
  const dw = Math.max(1, Math.round(cw * scale))
  const dh = Math.max(1, Math.round(chh * scale))
  const ox = Math.floor((N - dw) / 2)
  const oy = Math.floor((N - dh) / 2)
  const out = Array.from({ length: N }, () => new Array(N).fill(null))
  for (let ty = 0; ty < dh; ty++) {
    for (let tx = 0; tx < dw; tx++) {
      const sx = minX + Math.min(cw - 1, Math.floor((tx * cw) / dw))
      const sy = minY + Math.min(chh - 1, Math.floor((ty * chh) / dh))
      out[oy + ty][ox + tx] = grid[sy][sx]
    }
  }
  return out
}

// 素材：24x24 颜色网格（AI 生成像素画，见 tools/weapons-sprites.mjs）。缺素材返回 null。
// mode：true/'full' 填满 24（战斗装备槽）；'box' 缩放到 17 内框（图鉴网格，统一视觉重量）；falsy 原始留白
const SPRITE_CACHE = new Map()
function weaponSpriteGrid(id, mode) {
  const key = id + '|' + (mode === true ? 'full' : mode || 'raw')
  if (SPRITE_CACHE.has(key)) return SPRITE_CACHE.get(key)
  const data = WEAPON_PIXEL_DATA[id]
  let grid = null
  if (data) {
    grid = data.rows.map((row) => [...row].map((ch) => (ch === '.' ? null : data.palette[parseInt(ch, 36)] || null)))
    if (mode === 'box') grid = fitToBox(grid, 17)
    else if (mode) grid = fitToBox(grid, 24)
  }
  SPRITE_CACHE.set(key, grid)
  return grid
}

module.exports = {
  WEAPONS, WEAPON_INDEX, WEAPON_TOTAL, RARITY_COUNTS, RARITY_DROP, PITY_LIMIT, rollWeapon,
  weaponSpriteGrid, WEAPON_PIXEL_DATA,
}
