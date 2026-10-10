# legacy-mods —— 已废弃的「Mods 运行时」版归档

这里保存的是 Nibble 早期 **Claude Code Mods 运行时**版本中**不可再生或不可替代**的部分。
原目录 `nibble-mod/` 已于 **2026-10-09 明确废弃并删除**。

## 为什么废弃

那一版依赖 Claude Code 的 **Mods 运行时**（`register.ts` + `on('prompt.submit')` + `Raster` 真彩渲染 +
输入框上方窄带 `AbovePrompt`）。本机 CodeBuddy GUI IDE **不支持该运行时**
（在 `~/.codebuddy` 下搜 `prompt.submit` / `ui.render` / `AbovePrompt` 命中 0），
因此**那一版从未在本机跑起来过**。

现在真正在用的是 **`vscode-extension/`**（标准 VS Code 扩展，已发布 Open VSX：`nibble.nibble`）：
像素小生物常驻**底部状态栏**与**底部面板**，由 `plugins/nibble/` 的 hooks 推进战斗。
封装与发布链路（`.github/workflows/release.yml`）**完全不依赖本目录**。

## 归档内容

| 路径 | 说明 | 为什么保留 |
|---|---|---|
| `assets/*.png` | 4 张像素源图（player / bat / slime / mimic）。其中 bat / slime / mimic 为 **AI 原创**；player 自 2026-10-10 起是**作者自摄的小狗照片手工像素化**产物（源照片见 `assets/player-source-dog.jpg`） | 这些图**无法精确重现**，是全部游戏形象的源头 |
| `tools/png2grid.mjs` | 把源图转成 24×24 调色板网格的工具（纯 CLI 参数驱动） | 换素材 / 重制形象的唯一工具链（需 `pngjs`，仅构建期） |
| `tools/player-sprite.py` | 主角 `player.png` 的**可编辑设计稿**（字符网格 + 调色板 → 渲染成 24×24 RGBA） | 手改 PNG 不现实；改这个脚本即可重制主角形象（需 Pillow，仅构建期） |
| `pixels/_pixels.gen.txt` | 上述工具的输出（调色板 + 网格数据） | 留着它，即使不装 `pngjs` 也能重建 `pixels.js` |
| `reference/register.ts` | Mods 版的完整实现 | 仅作参考留档（它跑不起来；删掉不可恢复，故低成本留存） |
| `CREDITS.md` | 素材署名与版权声明 | 许可与出处凭证 |

## 这些素材现在用在何处

```
legacy-mods/assets/*.png
      │  tools/png2grid.mjs（构建期，需 pngjs）
      ▼
legacy-mods/pixels/_pixels.gen.txt         （调色板 + 网格数据）
      │  人工内联
      ▼
plugins/nibble/hooks/pixels.js             ← 真正的源文件（改它）
      │  tools/sync-lib.js
      ▼
vscode-extension/lib/pixels.js             （构建产物，gitignore，打包进扩展）
```

运行时**零第三方依赖、零图片依赖** —— 像素数据已内联进代码。

## 想换素材怎么办

0. **若改的是主角**：直接改 `legacy-mods/tools/player-sprite.py` 里的字符网格，
   然后 `python legacy-mods/tools/player-sprite.py` 重新生成 `assets/player.png`
   （它会校验内容框是否是 22×20 —— 这个尺寸下 `png2grid` 才不会重采样）。
   若改的是敌人，走下面第 1 步。
1. 把新图放进 `legacy-mods/assets/`（或直接覆盖现有 PNG）
2. 在**仓库根**（`nibble-cb/`）装构建期依赖：`npm i -D pngjs`
3. 在**仓库根**执行下面的命令，重新生成网格数据与预览图：

   ```bash
   node legacy-mods/tools/png2grid.mjs legacy-mods/pixels/_pixels.gen.txt legacy-mods/preview \
     player=legacy-mods/assets/player.png \
     bat=legacy-mods/assets/bat.png \
     slime=legacy-mods/assets/slime.png \
     mimic=legacy-mods/assets/mimic.png
   ```

4. 打开 `legacy-mods/preview/*.png` 人工核验观感（24×24 放大 12 倍）
5. 把新的 `palette` / `rows` 更新进 `plugins/nibble/hooks/pixels.js`
6. 在仓库根执行 `npm run sync`，把改动同步到 `vscode-extension/lib/`
7. 重新打包：`npm run package:official`（或打 tag 让 CI 发版）

> 说明：该脚本原先是放在 `nibble-mod/tools/` 下、靠 `nibble-mod/node_modules/pngjs` 运行的；
> 现在它改为依赖**仓库根**的 `node_modules`，与 `tools/make-icon.js` 共用同一份 `pngjs`。
