---
description: Nibble 小生物：查看状态 / attack 补刀 / arsenal 武器库 / reset 重置
argument-hint: [attack|arsenal|reset]
allowed-tools: Bash(node:*)
---

请把下面的状态面板**原样**输出给用户：保持代码块格式，**不要改动任何字符**，不要补充解释或额外建议。

!`node "${CODEBUDDY_PLUGIN_ROOT}/hooks/cli.js" do $1`

（若上面为空或报错，说明插件未正确加载：请确认 node 在 PATH 中，并运行 `/reload-plugins` 后重试。）
