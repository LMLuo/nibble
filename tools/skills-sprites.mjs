// tools/skills-sprites.mjs — 技能书素材构建（构建期工具，运行时零依赖）
// 流程：排列图（AI 生成，绿底）→ 等分切片 → 裁剪缩放 24x24 → 调色板压缩
//       → plugins/nibble/hooks/skills-pixels.js + preview/skills/ 校验拼图
// 源图存于 legacy-mods/assets/skills/sheets/，切片存于 .../cells/。
// 切片/缩放/调色板的公共逻辑在 tools/pixel-sheet.mjs（与武器素材管线共用一份）。
// 用法: node tools/skills-sprites.mjs
//
// 加一本书：把排列图丢进 sheets/ → 在下面 SHEETS 追加一条（按左→右、上→下的顺序填 ids）→ 重跑本脚本 + npm run sync
// 注意：AI 生成图按「提示词前缀 + 时间戳」命名，前缀相同的两张会互相覆盖 —— 一次只发一张、或让前缀各不相同。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPixelModule } from './pixel-sheet.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEETS_DIR = path.join(root, 'legacy-mods', 'assets', 'skills', 'sheets')
const CELLS_DIR = path.join(root, 'legacy-mods', 'assets', 'skills', 'cells')
const PREVIEW_DIR = path.join(root, 'legacy-mods', 'tools', 'preview', 'skills')
const OUT_FILE = path.join(root, 'plugins', 'nibble', 'hooks', 'skills-pixels.js')

// 排列图清单：按阅读顺序（左→右、上→下）列出每格对应的技能书 id
const SHEETS = [
  // —— 普通（20 本）——
  {
    rarity: 'common', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-32-41.png',
    ids: ['print_debug', 'try_catch', 'rubber_duck', 'git_blame'],
  },
  {
    rarity: 'common', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-38-56.png',
    ids: ['console_log', 'todo_comment', 'sleep_retry', 'regex_magic'],
  },
  {
    rarity: 'common', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-38-58.png',
    ids: ['hotfix_tape', 'force_push', 'paste_stackoverflow', 'off_by_one_patch'],
  },
  {
    rarity: 'common', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-38-57.png',
    ids: ['mock_data', 'semicolon_ward', 'print_sleep', 'assert_self'],
  },
  {
    rarity: 'common', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-39-25.png',
    ids: ['if_else_tower', 'reboot_chant', 'linter_shield', 'comment_out'],
  },

  // —— 稀有（15 本）——
  {
    rarity: 'rare', cols: 2, rows: 2,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-33-12.png',
    ids: ['stack_trace', 'stress_test', 'shadow_strike', 'shield_aura'],
  },
  {
    rarity: 'rare', cols: 2, rows: 2,
    file: 'RA1_rare_skillbook_sheet__pixe_2026-10-14T06-39-58.png',
    ids: ['null_check', 'retry_backoff', 'type_guard', 'log_trace'],
  },
  {
    rarity: 'rare', cols: 2, rows: 2,
    file: 'RA2_profiler_skillbook_sheet___2026-10-14T06-39-55.png',
    ids: ['memory_profiler', 'graceful_degrade', 'binary_search', 'cache_warm'],
  },
  {
    rarity: 'rare', cols: 3, rows: 1,
    file: 'RA3_defensive_skillbook_trio___2026-10-14T06-39-56.png',
    ids: ['load_balancer', 'breakpoint_trap', 'unit_test_ward'],
  },

  // —— 史诗（10 本）——
  {
    rarity: 'epic', cols: 2, rows: 1,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-34-23.png',
    ids: ['crit_focus', 'combo_finisher'],
  },
  {
    rarity: 'epic', cols: 2, rows: 2,
    file: 'EP1_jeweled_spellbook_sheet__p_2026-10-14T06-40-26.png',
    ids: ['arch_master', 'schema_guard', 'zero_downtime', 'race_radar'],
  },
  {
    rarity: 'epic', cols: 2, rows: 2,
    file: 'EP2_chaos_spellbook_sheet__pix_2026-10-14T06-40-18.png',
    ids: ['profiler_blade', 'chaos_monkey', 'drain_life_patch', 'overload_burst'],
  },

  // —— 传说（5 本）——
  {
    rarity: 'legendary', cols: 2, rows: 1,
    file: 'Pixel_art_sprite_sheet_on_a_fl_2026-10-14T06-34-22.png',
    ids: ['hello_world', 'root_access'],
  },
  {
    rarity: 'legendary', cols: 3, rows: 1,
    file: 'LG1_legendary_golden_tome_trio_2026-10-14T06-40-25.png',
    ids: ['gc_finalizer', 'immutable_truth', 'infinite_refactor'],
  },
]

buildPixelModule({
  sheets: SHEETS,
  sheetsDir: SHEETS_DIR,
  cellsDir: CELLS_DIR,
  previewDir: PREVIEW_DIR,
  outFile: OUT_FILE,
  dataVar: 'SKILL_PIXEL_DATA',
  generator: 'skills-sprites.mjs',
  sourceDir: 'legacy-mods/assets/skills/sheets/',
  unit: '本',
})
