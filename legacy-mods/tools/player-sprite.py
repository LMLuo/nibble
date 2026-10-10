#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""player-sprite.py — 构建期工具：把「垂耳小狗」主角像素画渲染成 24x24 RGBA 源图。

为什么不直接手改 PNG：24x24 的图在编辑器里逐像素改极难维护，这里把设计留成可读的
字符网格 + 调色板，改完重跑即可，结果完全确定（不依赖 AI 再生成）。

用法（在仓库根执行）：
    python legacy-mods/tools/player-sprite.py                 # 写入 assets/player.png
    python legacy-mods/tools/player-sprite.py --preview out.png  # 额外导出 14 倍放大预览

写入后按 legacy-mods/README.md 的步骤重跑 png2grid.mjs（png2grid 会把
24x24 原图裁包围盒再缩放进 24x24，本图的内容框正好是 22x20，因此是恒等变换，
不会被重采样糊掉），再把新的 palette / rows 内联进 plugins/nibble/hooks/pixels.js。

【画布规则】人物角色画布 24x24、四周留 1px，主体（含描边）必须落在 22x20 的内容框内。
所以本体占 cols 2..21 / rows 3..20；描边自动外扩 1px 后正好 cols 1..22 / rows 2..21。

【配色】取自 assets/player-source-dog.jpg（深棕头毛 + 黄褐垂耳 + 浅黄褐口鼻 + 奶白前胸）。
所有通道都是 16 的整数倍 —— png2grid.mjs 的 16 级量化因此是恒等变换，不改色。
"""

import argparse
import os
import sys

SIZE = 24

PAL = {
    "1": "#101010",  # 描边 / 鼻头 / 眼睛（最深的暖黑）
    "2": "#201010",  # 黑色被毛（头顶最暗处）
    "3": "#302010",  # 深棕（头顶）
    "4": "#403020",  # 棕（脸框 / 身体暗面）
    "5": "#605030",  # 中棕（左耳）
    "6": "#706040",  # 棕（右耳受光面）
    "7": "#908060",  # 黄褐（脸 / 口鼻）
    "8": "#B0A080",  # 浅黄褐（额前亮纹 / 鼻周）
    "9": "#D0C0A0",  # 奶白（下巴 / 前胸）
    "a": "#F0E0C0",  # 亮奶白（前胸高光）
    "b": "#F0F0F0",  # 眼睛高光
}
OUTLINE = "1"

# 头部：row -> [(起始列, 字符串)]。眼睛 2x3（cols 7-8 / 15-16，'b' 为高光），
# 额前亮纹 '8' 在 cols 11-12，鼻头 '1' 在 cols 11-12（rows 11-12），嘴为 rows 13-14 的 '∪'。
HEAD = {
    3: [(8, "22222222")],
    4: [(6, "233333333332")],
    5: [(5, "33333333333333")],
    6: [(5, "43333388333334")],
    7: [(5, "43777788777734")],
    8: [(5, "437b17887b1734")],
    9: [(5, "43711788711734")],
    10: [(5, "47711777771174")],
    11: [(5, "47778811887774")],
    12: [(5, "47888811888874")],
    13: [(6, "489919919984")],
    14: [(7, "4999119994")],
    15: [(8, "49999994")],
}

# 双耳（垂在两侧）：左耳略暗、右耳略亮，呼应原照「左暗右亮」
EAR_L = {6: "55", 7: "555", 8: "555", 9: "555", 10: "555", 11: "555",
         12: "555", 13: "555", 14: "555", 15: "555", 16: "55"}
EAR_R = {6: "66", 7: "566", 8: "566", 9: "566", 10: "566", 11: "566",
         12: "566", 13: "566", 14: "566", 15: "566", 16: "66"}

# 前胸（奶白绒球）
CHEST = {
    16: [(7, "4999999994")],
    17: [(6, "489a9999a984")],
    18: [(6, "4899a99a9984")],
    19: [(7, "4999999994")],
    20: [(8, "49999994")],
}

GAME_BG = (13, 15, 20)  # 面板底色 #0D0F14，仅用于预览图


def build_grid():
    """拼出 24x24 字符网格（'.' 为透空），最后自动描边。"""
    grid = [["."] * SIZE for _ in range(SIZE)]

    def put(r, c, s):
        for i, ch in enumerate(s):
            assert grid[r][c + i] == ".", "行%d 重叠 col=%d" % (r, c + i)
            grid[r][c + i] = ch

    for r, segs in HEAD.items():
        for c, s in segs:
            put(r, c, s)
    for r, s in EAR_L.items():
        put(r, 3 if len(s) == 2 else 2, s)
    for r, s in EAR_R.items():
        put(r, 19, s)
    for r, segs in CHEST.items():
        for c, s in segs:
            put(r, c, s)

    # 自动描边：所有紧邻实心像素的透明像素
    solid = [(r, c) for r in range(SIZE) for c in range(SIZE) if grid[r][c] != "."]
    for (r, c) in solid:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < SIZE and 0 <= cc < SIZE and grid[rr][cc] == ".":
                    grid[rr][cc] = OUTLINE
    return grid


def bbox(grid):
    pts = [(r, c) for r in range(SIZE) for c in range(SIZE) if grid[r][c] != "."]
    return (min(p[1] for p in pts), min(p[0] for p in pts),
            max(p[1] for p in pts), max(p[0] for p in pts))


def to_rgba(grid):
    """需要 Pillow；只在构建期用。返回 (width, height, bytes) 便于不依赖 PIL 的调用方。"""
    from PIL import Image
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = img.load()
    for r in range(SIZE):
        for c in range(SIZE):
            ch = grid[r][c]
            if ch == ".":
                continue
            h = PAL[ch].lstrip("#")
            px[c, r] = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
    return img


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.normpath(os.path.join(here, "..", "assets", "player.png"))

    ap = argparse.ArgumentParser(description="渲染垂耳小狗主角像素源图")
    ap.add_argument("--out", default=default_out, help="输出 PNG（默认 assets/player.png）")
    ap.add_argument("--preview", help="额外导出放大预览图（叠加 24x24 格线）")
    ap.add_argument("--dump", action="store_true", help="只在终端打印网格，不写文件")
    args = ap.parse_args()

    grid = build_grid()
    x0, y0, x1, y1 = bbox(grid)
    print("内容框：cols %d..%d（%d 宽） rows %d..%d（%d 高）"
          % (x0, x1, x1 - x0 + 1, y0, y1, y1 - y0 + 1))
    if (x0, y0, x1, y1) != (1, 2, 22, 21):
        print("⚠️  期望内容框是 cols 1..22 / rows 2..21（保证 png2grid 不重采样），请核对设计")
    if args.dump:
        for i, row in enumerate(grid):
            print("%2d %s" % (i, "".join(row)))
        return

    from PIL import Image
    img = to_rgba(grid)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    img.save(args.out)
    print("已写入 %s（%dx%d RGBA，%d 色）"
          % (args.out, img.width, img.height, len({c for r in grid for c in r if c != "."})))

    if args.preview:
        s = 14
        big = img.resize((SIZE * s, SIZE * s), Image.NEAREST)
        base = Image.new("RGB", big.size, GAME_BG)
        base.paste(big, (0, 0), big)
        px = base.load()
        for i in range(SIZE + 1):
            for t in range(SIZE * s):
                for p in ((i * s, t), (t, i * s)):
                    if p[0] < SIZE * s and p[1] < SIZE * s:
                        px[p] = tuple(min(255, v + 26) for v in px[p])
        base.save(args.preview)
        print("已写入预览 %s" % args.preview)

    print("\n下一步：")
    print("  node legacy-mods/tools/png2grid.mjs legacy-mods/pixels/_pixels.gen.txt legacy-mods/preview \\")
    print("    player=legacy-mods/assets/player.png bat=legacy-mods/assets/bat.png \\")
    print("    slime=legacy-mods/assets/slime.png mimic=legacy-mods/assets/mimic.png")
    print("  再把新的 player palette/rows 内联进 plugins/nibble/hooks/pixels.js，最后 npm run sync")


if __name__ == "__main__":
    sys.exit(main())
