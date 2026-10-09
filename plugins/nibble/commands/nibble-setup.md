---
description: 把 Nibble 像素小生物写入 CodeBuddy 状态栏
allowed-tools: Bash(node:*)
---

执行状态栏配置：

!`node "${CODEBUDDY_PLUGIN_ROOT}/hooks/setup.js"`

把上面的输出原样告诉用户，并提醒：需要重启 CodeBuddy（或运行 `/statusline` 查看）后，状态栏才会出现像素小生物。
