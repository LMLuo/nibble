# CREDITS / 素材版权

## 像素素材（原创）

除**玩家小生物**外，本项目的像素素材均为**本项目委托 AI 生成的原创像素画**，以 **CC0（公共领域奉献）** 发布。
源图存于 `assets/*.png`（仅构建期使用，**不是运行时依赖**），由 `tools/png2grid.mjs` 转成
24×24 颜色网格后**内联**进 `hooks/pixels.js`（运行时零图片依赖、零第三方依赖）。

> **玩家小生物的素材来源（2026-10-13 更新）**：形象是作者的爱犬**拾玖**（约克夏串串）。
> 当前这版 `assets/player.png`（24×24、19 色、16 级量化对齐）由 AI 按拾玖的样子绘制的像素画
> （源图 `assets/player-source-pixel.jpg`）经 `tools/player-sprite.py` 转换得到：抠背景 → 块内多数票降采样
> → 调色板取自源图自身的 k-means 聚类（保住黄褐/奶白/深棕的层次）→ 手工补眼睛高光/瞳孔/鼻头。
> **该素材随本扩展按 MIT 授权**（与代码同一份 `vscode-extension/LICENSE`，因此不在上面的 CC0 声明范围内）：
> 可自由使用、修改、再分发，保留版权声明即可，不额外附加限制。
> 其余 3 张敌人素材、武器素材与 HP 条/日志字符仍以 CC0 发布，不受影响。
> 历史：原「青色史莱姆灵」源图见 commit `ac269c8`；2026-10-10 起的「照片手工像素化」版
> （`assets/player-source-dog.jpg` + 旧 `tools/player-sprite.py`）仍在 git 历史里，库内不再被管线引用。

| 素材 | 源文件 | 作者 | 许可证 | 是否需署名 |
|------|--------|------|--------|------------|
| 玩家小生物（垂耳小狗「拾玖」） | `assets/player.png`（源图 `assets/player-source-pixel.jpg`） | 本项目（AI 生成原创像素画，按作者爱犬绘制） | **MIT（与代码同许可；非 CC0）** | 是（保留版权声明） |
| 野生敌人：蝙蝠 | `assets/bat.png` | 本项目（AI 生成原创） | CC0 | 否 |
| 野生敌人：史莱姆 | `assets/slime.png` | 本项目（AI 生成原创） | CC0 | 否 |
| 野生敌人：宝箱怪 | `assets/mimic.png` | 本项目（AI 生成原创） | CC0 | 否 |
| 武器图标 ×80（每把独立，普通/稀有/史诗/传说四种风格） | `assets/weapons/sheets/*.png`（排列图）→ `assets/weapons/cells/*.png`（切片） | 本项目（AI 生成原创） | CC0 | 否 |
| HP 条 / 日志字符 | 程序化生成 | 本项目 | CC0 | 否 |

> 武器素材由 `nibble-cb/tools/weapons-sprites.mjs` 构建生成（切片 + 抹水印 + 绿幕清理 + 密度裁剪 →
> `plugins/nibble/hooks/weapons-pixels.js`），核验拼图见 `nibble-cb/legacy-mods/tools/preview/weapons/`。

## 构建期工具

| 依赖 | 版本 | 许可证 | 用途 | 是否进入运行时 |
|------|------|--------|------|----------------|
| pngjs | ^7.0.0 | MIT | 读取/写出 PNG（素材转换） | **否**（仅构建期 `tools/png2grid.mjs` 使用） |
| Pillow（Python） | ≥ 9 | HPND | 把主角的 AI 像素源图转成 `assets/player.png`（`tools/player-sprite.py`） | **否**（仅构建期使用） |

## 关于 Spinlings（设计灵感来源）

本项目的设计灵感来自 [Spinlings](https://spinlings.dev/)（[416rehman/spinlings](https://github.com/416rehman/spinlings)）。
我们仅**参照其设计语言**（深色底、青色玩家、橙色野生、红色攻击状态色），
**未复制其任何素材，也未使用其代码**；本项目的名称、代码与像素素材均为独立创作。

如未来引入外部素材，仅采用 **CC0 / 公共领域**（如 Kenney.nl、OpenGameArt 筛选 CC0），
并在本表中补充：名称、作者、来源 URL、许可证、是否需署名；若为 CC-BY，则在 README 与
此处写明署名。当前未使用任何外部素材。
