'use strict'
// home-data.js — 小屋（家园）系统的数据层：投影常量 / 槽位元数据 / 5 套皮肤 / 挂点 / 默认布局
//
// 口径（很重要，别改错方向）：
//   房间只有一个，槽位固定；5 套是同一组槽位上的 5 种装潢皮肤。
//   不是「工位 / 办公室 / 机房」那种功能场景 —— 每套都是同一间屋子的另一种材质与色调。
//
// 硬约束：同一槽位跨 5 套的 size / sprite / zHeight / interact 必须完全一致，
//   否则玩家摆好的布局一换套装就会错位。皮肤只能提供「颜色 + 轮廓性格 shape」，
//   不能改占格、不能改锚点、不能改高度。
//
// 坐标约定：
//   世界坐标 (gx, gy) 落在地板平面上，gx ∈ [0, COLS)，gy ∈ [0, ROWS)；
//   gy 小 = 屏幕上方（远），gx 大 = 屏幕右侧；z 是离地高度，单位「格」。
//   等距 2:1 投影：sx = (gx - gy) * TILE_W/2，sy = (gx + gy) * TILE_H/2 - z * Z_UNIT

;(function (root) {
  // ============================================================
  // 投影与房间常量
  // ============================================================
  var TILE_W = 32 // 一格菱形在屏幕上的宽
  var TILE_H = 16 // 一格菱形在屏幕上的高（2:1）
  var Z_UNIT = 16 // 一「格高度」在屏幕上折算多少像素

  var COLS = 10
  var ROWS = 8

  // 房间中心（浮点格坐标）：投影后减掉它，让 (0,0) 落在画面中心的房间中点
  var CENTER_GX = (COLS - 1) / 2
  var CENTER_GY = (ROWS - 1) / 2
  var ORIGIN_X = (CENTER_GX - CENTER_GY) * (TILE_W / 2) // 16
  var ORIGIN_Y = (CENTER_GX + CENTER_GY) * (TILE_H / 2) // 64

  // 世界画布的逻辑尺寸（房间菱形 288×144，再容下家具高度与墙面）
  var FLOOR_H = (COLS + ROWS) * (TILE_H / 2) // 144
  // 地面菱形之上留出的高度：墙面 + 最高家具都画在这段里
  var PAD_Y = Z_UNIT * 5 // 80
  var WORLD_W = (COLS + ROWS) * (TILE_W / 2) // 288
  var WORLD_H = FLOOR_H + PAD_Y // 224

  // 房间底图覆盖的世界像素矩形（纹理图与它一一对应，1:1）
  //   x = -ROWS*HW - HW：菱形最左顶点在 worldX = -ROWS*HW - ORIGIN_X，再补半格
  //   y = -ORIGIN_Y - PAD_Y：向下含地面菱形，向上含墙面
  var ROOM_RECT = {
    x: -ROWS * (TILE_W / 2) - TILE_W / 2, // -144
    y: -ORIGIN_Y - PAD_Y, // -144
    w: WORLD_W,
    h: WORLD_H,
  }

  // 缩放只允许整数倍：非整数倍会让像素糊掉（scene.js 也是这个口径）
  var ZOOM_STEPS = [1, 2, 3]
  var ZOOM_DEFAULT = 2

  // 稀有度配色必须与 nibble.js 的 RARITY_COLOR 一致，否则玩家对稀有度的判断会分裂
  var RARITY_COLOR = {
    common: '#FFB86B',
    rare: '#FFE066',
    epic: '#E040E0',
    legendary: '#FFD700',
  }
  var RARITY_LABEL = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' }
  var RARITY_ORDER = ['common', 'rare', 'epic', 'legendary']

  // ============================================================
  // 槽位元数据表（9 槽）
  //   kind: floor / wall / obj / rug
  //   size: [宽格, 深格]，obj 与 rug 的占地；floor/wall 是整个房间
  //   sprite: 占位精灵的像素尺寸 [w, h]，锚点恒为「底边中点」
  //   zHeight: 遮挡高度（格），等距深度排序与落影用
  //   interact: 家具前方站立点的相对偏移（格），第一版没人用，是「留开口」用的
  //   block: 是否写入 occupancy
  //   light: 光照锚点的相对位置（0..1 沿精灵包围盒），null = 不发光
  // ============================================================
  var SLOTS = [
    {
      id: 'floor',
      name: '地板',
      kind: 'floor',
      size: [COLS, ROWS],
      sprite: [WORLD_W, WORLD_H],
      zHeight: 0,
      block: false,
      interact: null,
      light: null,
    },
    {
      id: 'wallBack',
      name: '后墙',
      kind: 'wall',
      side: 'back', // 沿 gx 方向，贴在 gy = 0 那一侧
      size: [COLS, 1],
      sprite: [WORLD_W, Z_UNIT * 4],
      zHeight: Z_UNIT * 4,
      block: false,
      interact: null,
      light: null,
    },
    {
      id: 'wallLeft',
      name: '左墙',
      kind: 'wall',
      side: 'left', // 沿 gy 方向，贴在 gx = 0 那一侧
      size: [1, ROWS],
      sprite: [WORLD_W, Z_UNIT * 4],
      zHeight: Z_UNIT * 4,
      block: false,
      interact: null,
      light: null,
    },
    {
      id: 'bed',
      name: '床铺',
      kind: 'obj',
      size: [2, 2],
      sprite: [80, 62],
      zHeight: 1.2,
      block: true,
      interact: [0.5, 1.6], // 站在床前方
      light: null,
    },
    {
      id: 'desk',
      name: '桌子',
      kind: 'obj',
      size: [2, 1],
      sprite: [70, 50],
      zHeight: 1.0,
      block: true,
      interact: [1.0, 1.4],
      light: null,
    },
    {
      id: 'chair',
      name: '椅子',
      kind: 'obj',
      size: [1, 1],
      sprite: [38, 42],
      zHeight: 1.0,
      block: true,
      interact: [0.5, 1.2],
      light: null,
    },
    {
      id: 'lamp',
      name: '灯',
      kind: 'obj',
      size: [1, 1],
      sprite: [30, 52],
      zHeight: 1.4,
      block: true,
      interact: null,
      light: [0.5, 0.16], // 灯光在精灵偏上位置
    },
    {
      id: 'rug',
      name: '地毯',
      kind: 'rug', // 铺在地板上，可踩过，不写 occupancy
      size: [3, 2],
      sprite: [108, 54],
      zHeight: 0,
      block: false,
      interact: null,
      light: null,
    },
    {
      id: 'deco',
      name: '摆件',
      kind: 'obj',
      size: [1, 1],
      sprite: [34, 40],
      zHeight: 1.0,
      block: true,
      interact: null,
      light: null,
    },
  ]

  var SLOT_INDEX = {}
  for (var i = 0; i < SLOTS.length; i++) SLOT_INDEX[SLOTS[i].id] = SLOTS[i]

  // ============================================================
  // 通用装饰（20 种）
  //   与 5 套装潢无关：走一套中性配色，放哪套屋里都成立。
  //   每种最多摆 1 件，总件数受 EXTRA_MAX 限制。
  //   尺寸按「视觉高度」分档，不按占格：书架要 68 高，杯子只要 24 高。
  // ============================================================
  function extra(id, name, w, h, opts) {
    var o = opts || {}
    return {
      id: id,
      name: name,
      kind: 'extra',
      rarity: o.rarity || 'common',
      size: o.size || [1, 1],
      sprite: [w, h],
      zHeight: o.z == null ? 1 : o.z,
      block: o.block !== false,
      interact: o.interact || null,
      light: o.light || null,
    }
  }

  var EXTRAS = [
    // —— 1×1 小件（前 6 件是开局赠送，稀有度为普通）——
    extra('plant', '绿植盆栽', 38, 42, { z: 1.2, rarity: 'common' }),
    extra('books', '一摞书', 38, 26, { z: 0.6, rarity: 'common' }),
    extra('mug', '马克杯', 38, 22, { z: 0.4, rarity: 'common' }),
    extra('globe', '地球仪', 38, 40, { z: 1.1, rarity: 'common' }),
    extra('boxes', '纸箱堆', 38, 34, { z: 0.9, rarity: 'common' }),
    extra('floorlamp', '落地灯', 38, 58, { z: 1.6, rarity: 'common', light: [0.5, 0.14] }),
    extra('guitar', '木吉他', 38, 56, { z: 1.5, rarity: 'rare' }),
    extra('tank', '小鱼缸', 38, 36, { z: 1.0, rarity: 'rare' }),
    extra('catbed', '猫窝', 38, 26, { z: 0.5, rarity: 'rare' }),
    extra('coffee', '咖啡机', 38, 34, { z: 0.9, rarity: 'rare' }),
    // —— 2×1 中件 ——
    extra('shelf', '书架', 70, 68, { size: [2, 1], z: 2.0, rarity: 'epic' }),
    extra('sofa', '双人沙发', 70, 46, { size: [2, 1], z: 1.0, rarity: 'rare' }),
    extra('cabinet', '矮柜', 70, 34, { size: [2, 1], z: 0.8, rarity: 'rare' }),
    extra('screen', '屏风', 70, 66, { size: [2, 1], z: 1.9, rarity: 'epic' }),
    extra('turntable', '唱片机柜', 70, 38, { size: [2, 1], z: 0.9, rarity: 'rare' }),
    extra('foldingtable', '折叠桌', 70, 40, { size: [2, 1], z: 1.0, rarity: 'rare' }),
    // —— 2×2 大件 ——
    extra('wardrobe', '大衣柜', 80, 62, { size: [2, 2], z: 2.2, rarity: 'epic' }),
    extra('bigshelf', '靠墙大书架', 80, 62, { size: [2, 2], z: 2.2, rarity: 'epic' }),
    extra('beanbag', '懒人沙发', 80, 54, { size: [2, 2], z: 0.8, rarity: 'epic' }),
    extra('cattree', '猫爬架', 80, 62, { size: [2, 2], z: 2.0, rarity: 'legendary' }),
  ]

  var EXTRA_INDEX = {}
  for (var e = 0; e < EXTRAS.length; e++) EXTRA_INDEX[EXTRAS[e].id] = EXTRAS[e]

  // 统一索引：套内 6 件 + 20 件装饰，渲染/命中/拖拽只认这个。
  // key 用 slot id（套内）或 extra id（装饰），两者不重名。
  var PIECE_INDEX = {}
  for (var p = 0; p < SLOTS.length; p++) {
    if (SLOTS[p].kind === 'floor' || SLOTS[p].kind === 'wall') continue
    PIECE_INDEX[SLOTS[p].id] = SLOTS[p]
  }
  for (var q = 0; q < EXTRAS.length; q++) PIECE_INDEX[EXTRAS[q].id] = EXTRAS[q]

  // 额外装饰的件数上限。房间 10×8 = 80 格，固定 6 件占 9 格；
  // 再多就挡死后排（等距视角只有前 3 排真看得见），16 件是「丰富但不堵」的上限。
  var EXTRA_MAX = 16

  // 仓库抽屉宽度（px）。autoFit 用它给房间让位，CSS 也用它定宽 —— 一处改，两处生效。
  var DEPOT_W = 336

  // ============================================================
  // 槽位物品：5 系列 × 8 槽位 = 40 件
  //   每件是「某个槽位的一种外观」，稀有度跟随系列。
  //   当前搭配 = skins[槽位] = 物品 id（逐件挑，不是整屋切换）。
  //   「一套风格」是集齐 8 件后的自然结果，不是切换单位。
  // ============================================================
  var SKIN_SLOTS = [
    { key: 'floor', name: '地板' },
    { key: 'wall', name: '墙纸' },
    { key: 'bed', name: '床铺' },
    { key: 'desk', name: '桌子' },
    { key: 'chair', name: '椅子' },
    { key: 'lamp', name: '灯' },
    { key: 'rug', name: '地毯' },
    { key: 'deco', name: '摆件' },
  ]

  var SLOT_NAME = {}
  for (var sn = 0; sn < SKIN_SLOTS.length; sn++) SLOT_NAME[SKIN_SLOTS[sn].key] = SKIN_SLOTS[sn].name

  var ITEMS = []
  var ITEM_INDEX = {}
  // 装饰不依赖 SETS，先进索引
  for (var ei = 0; ei < EXTRAS.length; ei++) {
    ITEM_INDEX[EXTRAS[ei].id] = EXTRAS[ei]
  }
  // 槽位物品要用 SETS，但 SETS 定义在文件更下面 —— 抽成函数，等它定义完再调。
  function buildSlotItems() {
    for (var si = 0; si < SETS.length; si++) {
      var series = SETS[si]
      for (var sj = 0; sj < SKIN_SLOTS.length; sj++) {
        var slotKey = SKIN_SLOTS[sj].key
        var itemId = series.id + '_' + slotKey
        var item = {
          id: itemId,
          series: series.id,
          slot: slotKey,
          rarity: series.rarity,
          kind: 'skin',
          name: series.name + '·' + SLOT_NAME[slotKey],
        }
        ITEMS.push(item)
        ITEM_INDEX[itemId] = item
      }
    }
  }

  // 开局：整套暖木（普通）+ 6 件普通装饰，不然新玩家进屋什么都没有
  var DEFAULT_SKINS = {}
  var DEFAULT_OWNED = {}
  for (var dk = 0; dk < SKIN_SLOTS.length; dk++) {
    var k0 = SKIN_SLOTS[dk].key
    DEFAULT_SKINS[k0] = 'wood_' + k0
    DEFAULT_OWNED['wood_' + k0] = true
  }
  for (var de = 0; de < EXTRAS.length; de++) {
    if (EXTRAS[de].rarity === 'common') DEFAULT_OWNED[EXTRAS[de].id] = true
  }

  // 某系列包含的 8 件 id（判断「集齐可一键应用」用）
  function itemsOfSeries(seriesId) {
    var out = []
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].series === seriesId) out.push(ITEMS[i].id)
    return out
  }

  // 房间底图的缓存键：地板与墙纸可以来自不同系列，所以是二元组。
  // 这个 key 必须由 scene(drawList)、atlas(ensureRoom)、gl(纹理表) 三处共用 ——
  // 各写各的字符串拼法就会对不上（踩过一次：房间整个不画，只剩黑底）。
  function roomKey(floorSeries, wallSeries) {
    return (floorSeries || 'wood') + '|' + (wallSeries || 'wood')
  }

  // 物品 id → 系列（装饰没有系列，返回 ''）
  function seriesOfItem(itemId) {
    var it = ITEM_INDEX[itemId]
    return it && it.series ? it.series : ''
  }

  // 可拖动 / 可更换的槽位（地板与两面墙固定，不参与拖动）
  var MOVABLE_SLOT_IDS = ['bed', 'desk', 'chair', 'lamp', 'rug', 'deco']

  // 门位：角色未来的入场格。第一版没有人使用，但门位与占用表必须现在就存在。
  var DOOR = { gx: 0, gy: ROWS - 1 }

  // 墙面挂点：3 个武器位 + 2 个怪物挂画位，跨套装共享，不随皮肤移动。
  //   wall: 'back' 沿 gx / 'left' 沿 gy
  //   along: 0..1 沿墙起点→终点的比例
  //   z: 离地高度（格）。墙高 3.2 格，挂点重心取 1.7 左右才不会顶到墙檐。
  //   分布刻意分开：3 个武器后排、1 张挂画后排、1 张挂画左墙 —— 都挤在后墙会糊成一片。
  var WALL_MOUNTS = [
    { id: 'weapon1', kind: 'weapon', label: '武器 1', wall: 'back', along: 0.2, z: 1.7 },
    { id: 'weapon2', kind: 'weapon', label: '武器 2', wall: 'back', along: 0.4, z: 1.7 },
    { id: 'weapon3', kind: 'weapon', label: '武器 3', wall: 'back', along: 0.6, z: 1.7 },
    { id: 'picture1', kind: 'enemy', label: '挂画 1', wall: 'back', along: 0.82, z: 1.7 },
    { id: 'picture2', kind: 'enemy', label: '挂画 2', wall: 'left', along: 0.45, z: 1.7 },
  ]

  // ============================================================
  // 5 套皮肤
  //   每套提供：稀有度、材质配色、每件家具的名字、每件家具的轮廓性格 shape
  //   shape 只影响占位精灵的程序化轮廓，不改尺寸；接真实美术后由贴图取代
  // ============================================================
  var SETS = [
    {
      id: 'wood',
      name: '暖木晨光',
      rarity: 'common',
      desc: '原木、米白棉麻、竹编。刚搬进来的那种干净早晨。',
      palette: {
        // 地板比家具暗一档：家具主体是米白与浅木，地板太亮会和它们糊成一片
        floor: '#9C7342',
        floorAlt: '#8F6939',
        wall: '#D8C4A2',
        wallAlt: '#CDB795',
        trim: '#6E4C31',
        base: '#B98A56',
        light: '#D9AE7C',
        dark: '#7C5636',
        accent: '#F0E0C4',
        glow: '#FFC98A',
      },
      names: { bed: '松木软床', desk: '原木桌', chair: '竹编椅', lamp: '藤罩台灯', rug: '棉麻毯', deco: '陶盆绿植' },
      shape: { bed: 'soft', desk: 'panel', chair: 'soft', lamp: 'shade', rug: 'plain', deco: 'pot' },
    },
    {
      id: 'study',
      name: '旧书房',
      rarity: 'rare',
      desc: '深胡桃、旧皮革、黄铜。台灯一开就是深夜。',
      palette: {
        floor: '#6B4A32',
        floorAlt: '#5C3F2A',
        wall: '#7A5B45',
        wallAlt: '#6B4E3B',
        trim: '#3A2617',
        base: '#6B4A32',
        light: '#8F6A48',
        dark: '#40291B',
        accent: '#C9A46A',
        glow: '#FFB45E',
      },
      names: { bed: '胡桃木床', desk: '黄铜书桌', chair: '旧皮椅', lamp: '铜罩台灯', rug: '旧花毯', deco: '书堆' },
      shape: { bed: 'frame', desk: 'panel', chair: 'frame', lamp: 'shade', rug: 'pattern', deco: 'stack' },
    },
    {
      id: 'moss',
      name: '苔石小屋',
      rarity: 'rare',
      desc: '粗石、苔藓、藤条。天窗漏下一道冷白。',
      palette: {
        floor: '#7C8B72',
        floorAlt: '#6D7C64',
        wall: '#8E9A86',
        wallAlt: '#7C8874',
        trim: '#4E5A48',
        base: '#7C8B72',
        light: '#A3B096',
        dark: '#4E5A48',
        accent: '#C8D3BC',
        glow: '#CFE8CE',
      },
      names: { bed: '干草铺', desk: '石台', chair: '藤椅', lamp: '苔石灯', rug: '编织毯', deco: '蕨类' },
      shape: { bed: 'soft', desk: 'stone', chair: 'weave', lamp: 'stone', rug: 'weave', deco: 'fern' },
    },
    {
      id: 'neon',
      name: '霓虹夜宵',
      rarity: 'epic',
      desc: '拉丝金属、半透亚克力、走线。屏幕的光比灯亮。',
      palette: {
        floor: '#3A3350',
        floorAlt: '#2F2942',
        wall: '#3E3556',
        wallAlt: '#332B48',
        trim: '#1F1A2E',
        base: '#3A3350',
        light: '#5A5178',
        dark: '#1F1A2E',
        accent: '#8AF0E8',
        glow: '#B27CFF',
      },
      names: { bed: '胶囊床', desk: '亚克力桌', chair: '电竞椅', lamp: 'LED 灯管', rug: '网格毯', deco: '机箱' },
      shape: { bed: 'pod', desk: 'panel', chair: 'frame', lamp: 'tube', rug: 'grid', deco: 'box' },
    },
    {
      id: 'star',
      name: '星海浮屋',
      rarity: 'legendary',
      desc: '半透明、自发光、无重力。家具是浮着的。',
      palette: {
        floor: '#4A3A6B',
        floorAlt: '#3D2F5A',
        wall: '#4E3D72',
        wallAlt: '#413260',
        trim: '#2A1F45',
        base: '#4A3A6B',
        light: '#7B62A8',
        dark: '#2A1F45',
        accent: '#D8C4FF',
        glow: '#FFE9A8',
      },
      names: { bed: '云榻', desk: '悬浮台', chair: '光椅', lamp: '星灯', rug: '星尘毯', deco: '水晶' },
      shape: { bed: 'float', desk: 'float', chair: 'float', lamp: 'star', rug: 'stars', deco: 'crystal' },
    },
  ]

  var SET_INDEX = {}
  for (var j = 0; j < SETS.length; j++) SET_INDEX[SETS[j].id] = SETS[j]

  // SETS 就位，现在可以把 40 件槽位物品建出来了
  buildSlotItems()

  // ============================================================
  // 默认布局（第一刀用；不落盘，刷新回默认）
  // ============================================================
  var DEFAULT_LAYOUT = [
    { slot: 'rug', gx: 2, gy: 3 },
    { slot: 'bed', gx: 0, gy: 1 },
    { slot: 'desk', gx: 6, gy: 0 },
    { slot: 'chair', gx: 6, gy: 1 },
    { slot: 'lamp', gx: 9, gy: 0 },
    { slot: 'deco', gx: 0, gy: 6 },
  ]

  var DEFAULT_SET = 'wood'

  // ============================================================
  // 布局校验：占格是否合法（越界 / 与已放置物件重叠）
  //   ignoreSlot 用于拖动：先把自己从占用里摘掉再试填
  // ============================================================
  function cellsOf(gx, gy, size) {
    var out = []
    for (var x = 0; x < size[0]; x++) {
      for (var y = 0; y < size[1]; y++) out.push([gx + x, gy + y])
    }
    return out
  }

  function inRoom(gx, gy, size) {
    return gx >= 0 && gy >= 0 && gx + size[0] <= COLS && gy + size[1] <= ROWS
  }

  var API = {
    TILE_W: TILE_W,
    TILE_H: TILE_H,
    Z_UNIT: Z_UNIT,
    COLS: COLS,
    ROWS: ROWS,
    CENTER_GX: CENTER_GX,
    CENTER_GY: CENTER_GY,
    ORIGIN_X: ORIGIN_X,
    ORIGIN_Y: ORIGIN_Y,
    FLOOR_H: FLOOR_H,
    PAD_Y: PAD_Y,
    ROOM_RECT: ROOM_RECT,
    WORLD_W: WORLD_W,
    WORLD_H: WORLD_H,
    ZOOM_STEPS: ZOOM_STEPS,
    ZOOM_DEFAULT: ZOOM_DEFAULT,
    RARITY_COLOR: RARITY_COLOR,
    RARITY_LABEL: RARITY_LABEL,
    RARITY_ORDER: RARITY_ORDER,
    SLOTS: SLOTS,
    SLOT_INDEX: SLOT_INDEX,
    EXTRAS: EXTRAS,
    EXTRA_INDEX: EXTRA_INDEX,
    PIECE_INDEX: PIECE_INDEX,
    EXTRA_MAX: EXTRA_MAX,
    DEPOT_W: DEPOT_W,
    SKIN_SLOTS: SKIN_SLOTS,
    SLOT_NAME: SLOT_NAME,
    ITEMS: ITEMS,
    ITEM_INDEX: ITEM_INDEX,
    DEFAULT_SKINS: DEFAULT_SKINS,
    DEFAULT_OWNED: DEFAULT_OWNED,
    itemsOfSeries: itemsOfSeries,
    seriesOfItem: seriesOfItem,
    roomKey: roomKey,
    MOVABLE_SLOT_IDS: MOVABLE_SLOT_IDS,
    DOOR: DOOR,
    WALL_MOUNTS: WALL_MOUNTS,
    SETS: SETS,
    SET_INDEX: SET_INDEX,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    DEFAULT_SET: DEFAULT_SET,
    cellsOf: cellsOf,
    inRoom: inRoom,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  else root.NibbleHomeData = API
})(typeof window !== 'undefined' ? window : globalThis)
