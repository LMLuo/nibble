'use strict'
// skills-stories.js — 50 本技能书的"技能注记"（每本 ≤40 字）
// 与 weapons-stories.js 同风格但更短：一句话讲清这本"书"在讲什么道理。
// 展示位置：技能库详情卡（选中格子时显示在书名下方）。

const STORIES = {
  // —— 普通（20）——
  print_debug: '加一行 print，Bug 自己就现身了——它怕被看见。',
  try_catch: '不知道为什么炸？先接住它。接住了，就还能下班。',
  rubber_duck: '讲给鸭子听，讲到第三句，你自己就找到答案了。',
  git_blame: '谁写的这行？git 一指，整个群安静了。',
  console_log: '控制台说是什么，它就是什么。别猜。',
  todo_comment: '// TODO: 明天修。明天的你，会比今天更强一点。',
  sleep_retry: '失败就睡一秒再来——大多数重试都发生在深夜。',
  regex_magic: '一次写对的正则没赢过；改到第八次才对的，赢麻了。',
  hotfix_tape: '线上不能停，先贴一层胶带。胶带也是生产力。',
  force_push: '--force 一出，评审靠边站（事后记得请同事喝奶茶）。',
  paste_stackoverflow: 'Ctrl+C 是学习，Ctrl+V 是理解。',
  off_by_one_patch: '数组下标从 0 开始，人类从 1 开始，战争从此开始。',
  mock_data: '先跑通流程，再说真实数据——反正迟早要改。',
  semicolon_ward: '加不加分号都对；但加上它，你心里踏实。',
  print_sleep: '日志打了一堆，问题没复现——但至少你在努力。',
  assert_self: 'assert(我是对的)，跑一次就知道并不是。',
  if_else_tower: '一层层 else 叠上去，塔顶的风很冷。',
  reboot_chant: '重启能解决九成问题，剩下那一成要重装。',
  linter_shield: '格式先对齐，气场就赢了——至少 IDE 不再画红线。',
  comment_out: '被注释掉的那段代码，保护了你的今晚。',

  // —— 稀有（15）——
  stack_trace: '顺着栈往下走，总会遇到真凶——通常是你自己。',
  stress_test: '把 QPS 拉到一万，它终于肯说实话了。',
  shadow_strike: '不报错，也不返回——暗影里给出一击。',
  shield_aura: '能挡住 OOM 的从来不是内存，是提前跑过的压测。',
  breakpoint_trap: '断点一挂，Bug 就不再说话；一放开，它又开始跑。',
  unit_test_ward: '红变绿的那一刻，世界安静了。',
  binary_search: '一半一半地切，问题躲不过 log2(n) 次。',
  cache_warm: '先跑一遍把热数据捂暖，第一条请求就不再发抖。',
  load_balancer: '一只扛不动，就分给十只扛——锅也一样。',
  null_check: '在解引用之前，先问一句：你在吗？',
  retry_backoff: '不是不重试，是拉开间隔、攒好连击再来。',
  type_guard: 'TS 的红线不是刁难，是不让你深夜上热搜。',
  log_trace: '埋点不嫌多——出事那天，你会感谢昨天多打的那一行。',
  memory_profiler: '堆快照一开，谁在偷偷驻留，一览无余。',
  graceful_degrade: '撑不住就降级：先活着，再谈体验。',

  // —— 史诗（10）——
  crit_focus: '关掉通知，专注二十五分钟——暴击是专注的副产品。',
  combo_finisher: '前面攒的每一连，都是为了这一下。',
  arch_master: '看得见耦合的人，才拆得动耦合。',
  schema_guard: '契约先定，改动就没有偷袭。',
  zero_downtime: '新旧并存、灰度放量——发布这件事，不必惊动用户。',
  race_radar: '时序问题从不复现，除非你提前埋好了雷达。',
  profiler_blade: '火焰图一拉，热点无处躲藏。',
  chaos_monkey: '随机杀进程的那只猴子，是最好的灾备教练。',
  drain_life_patch: '热补丁上线，一边修一边回血：缝补本身也是续航。',
  overload_burst: '把一整周的积压一次推平——过载，也是一种爆发。',

  // —— 传说（5）——
  hello_world: '一切从这里开始。它教会所有语言说第一句话。',
  root_access: '拿到根权限的人不喧哗——他直接改掉全世界的默认值。',
  gc_finalizer: '无人引用者终被回收；放下，也是一种释放。',
  immutable_truth: '不可变的数据从不背刺：它要么是那个值，要么不存在。',
  infinite_refactor: '重构没有终点，只有下一次提交——但每一连都更锋利。',
}

module.exports = { STORIES }
