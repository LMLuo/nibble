// tools/weapons-sprites.mjs — 武器素材构建（构建期工具，运行时零依赖）
// 流程：排列图（AI 生成，绿底）→ 等分切片 → 裁剪缩放 24x24 → 调色板压缩
//       → plugins/nibble/hooks/weapons-pixels.js + preview/weapons/ 校验拼图
// 源图存于 legacy-mods/assets/weapons/sheets/，切片存于 .../cells/。
// 切片/缩放/调色板的公共逻辑在 tools/pixel-sheet.mjs（与技能书素材管线共用一份）。
// 用法: node tools/weapons-sprites.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPixelModule } from './pixel-sheet.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEETS_DIR = path.join(root, 'legacy-mods', 'assets', 'weapons', 'sheets')
const CELLS_DIR = path.join(root, 'legacy-mods', 'assets', 'weapons', 'cells')
const PREVIEW_DIR = path.join(root, 'legacy-mods', 'tools', 'preview', 'weapons')
const OUT_FILE = path.join(root, 'plugins', 'nibble', 'hooks', 'weapons-pixels.js')

// 排列图清单：按阅读顺序（左→右、上→下）列出每格对应的武器 id。
// 换/加素材：改这里 + 重放排列图，重跑本脚本即可。
const SHEETS = [
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-01.png',
    ids: ['nullptr_dagger', 'comment_knife', 'enter_hammer', 'indent_sword', 'semicolon_spear', 'bracket_axe', 'todo_dart', 'log_stick'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-03.png',
    ids: ['cache_bow', 'loop_blade', 'string_whip', 'bug_net', 'pipe_wrench', 'regex_ruler', 'compile_hammer', 'stack_spoon'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-07.png',
    ids: ['heap_fork', 'byte_dart', 'hook_scythe', 'shell_fork', 'macro_mallet', 'script_scalpel', 'patch_shovel', 'merge_paddle'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-16.png',
    ids: ['diff_dagger', 'branch_staff', 'clone_cudgel', 'commit_chisel', 'tag_card', 'stash_spear', 'lint_broom', 'format_fan'],
  },
  {
    rarity: 'common', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-59.png',
    ids: ['indent_pick', 'token_pick', 'pixel_pick', 'var_vane', 'func_fork', 'polyfill_pebble', 'case_club', 'alpha_arrow'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-41-58.png',
    ids: ['refactor_blade', 'recursion_bow', 'cache_dart', 'async_halberd', 'hash_hammer', 'bitwise_claw', 'inline_rapier', 'coroutine_whip'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-42-01.png',
    ids: ['mutex_mace', 'promise_pike', 'lambda_fist', 'stack_slicer', 'heap_harvester', 'pointer_partisan', 'closure_cleaver', 'stream_saber'],
  },
  {
    rarity: 'rare', cols: 4, rows: 2,
    file: 'Sprite_sheet_of_8_different_re_2026-10-10T01-42-08.png',
    ids: ['socket_spear', 'daemon_dagger', 'kernel_knife', 'thread_thresher', 'buffer_broadsword', 'parser_chakram', 'regex_rapier', 'opcode_scepter'],
  },
  {
    rarity: 'rare', cols: 1, rows: 1,
    file: 'Sprite_sheet_with_a_single_ret_2026-10-10T01-42-30.png',
    ids: ['query_quiver'],
  },
  {
    rarity: 'epic', cols: 3, rows: 2,
    file: 'Sprite_sheet_of_6_different_re_2026-10-10T01-51-45.png',
    ids: ['deadlock_warhammer', 'entropy_staff', 'regex_edge', 'segfault_scythe', 'overflow_glaive', 'race_blade'],
  },
  {
    rarity: 'epic', cols: 3, rows: 2,
    file: 'Sprite_sheet_of_6_different_re_2026-10-10T01-51-43.png',
    ids: ['leak_maul', 'null_cataclysm', 'infinity_lance', 'quantum_debug_blade', 'gc_guillotine', 'bigo_blade'],
  },
  {
    rarity: 'legendary', cols: 3, rows: 1,
    file: 'Sprite_sheet_of_3_different_re_2026-10-10T01-51-48.png',
    ids: ['debug_zero', 'heat_death', 'genesis_commit'],
  },
]

buildPixelModule({
  sheets: SHEETS,
  sheetsDir: SHEETS_DIR,
  cellsDir: CELLS_DIR,
  previewDir: PREVIEW_DIR,
  outFile: OUT_FILE,
  dataVar: 'WEAPON_PIXEL_DATA',
  generator: 'weapons-sprites.mjs',
  sourceDir: 'legacy-mods/assets/weapons/sheets/',
  unit: '把',
})
