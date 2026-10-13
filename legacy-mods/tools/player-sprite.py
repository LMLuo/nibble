#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""player-sprite.py — 构建期工具：把主角的 AI 像素源图转成 24x24 RGBA 源图（assets/player.png）。

【管线（2026-10-13 定稿）】AI 源图 → 抠背景 → 块内多数票降采样 → 去孤立点 → 补眼睛/鼻头：
  · 源图的"逻辑像素"并不均匀（周期探测集中度只有 0.09），所以不试图对齐它的格子，
    而是让**每个输出格取格内出现最多的那个调色板色** —— 这样色块边界原样保留，
    不会像"取平均"那样把脸和眼睛糊成一团；
  · 调色板由源图自身的颜色 k-means 聚类得到（默认 20 簇），不做人工压缩 —— 上一版只有 10 色，
    把黄褐/奶白的层次压没了，这是"跟源图差距大"的主因；
  · 源图自带深色描边，故默认**不再补描边**（旧版的 --outline add/edge 会改掉最外一圈的块面）；
  · 只有"比一个输出格还小"的细节才手工补：眼睛高光/瞳孔/鼻头（见 TOUCHUP 与 tests/README）。

【为什么内容框的最大边必须正好是 22】
png2grid.mjs 会把源图裁到内容包围盒再等比缩放进 24x24（四周留 1px）：缩放系数
s = min(22/w, 22/h)，再按 floor((24-w)/2) / floor((24-h)/2) 居中。因此只有
「内容框最大边 = 22」且放置方式与它一致时 s 才是 1（恒等变换、不重采样）。
当前形象本体 20x22 → 内容框 20x22，落在 cols 2..21 / rows 1..22。脚本结尾会核对。

【为什么调色板所有通道都是 16 的整数倍】
png2grid.mjs 会把每个像素按 16 级量化（round(v/16)*16，上限 240）。调色板本身对齐到
16 的整数倍后，那一步就是恒等变换，颜色不会在管线里被悄悄改掉。

【源图】legacy-mods/assets/player-source-pixel.jpg —— AI 生成的像素画（1080x1080）。
它是"假透明"：背景棋盘格被烤进了画面，且因为存成 JPEG 有噪声，所以要抠背景 + 收敛调色板。
源图不可再生，已入库（与 assets/dog.png 同理）。

用法（在仓库根执行）：
    python legacy-mods/tools/player-sprite.py                      # 写入 assets/player.png
    python legacy-mods/tools/player-sprite.py --dump               # 只打印 24x24 网格
    python legacy-mods/tools/player-sprite.py --preview out.png    # 额外导出 14 倍放大预览
    python legacy-mods/tools/player-sprite.py --colors 16          # 调调色板规模
    python legacy-mods/tools/player-sprite.py --body 20x22 --flatten 1 --outline edge   # 调参
"""

import argparse
import os
import random
import sys
from collections import Counter, deque

try:
    from PIL import Image
except ImportError:  # 只有构建期需要 Pillow；运行时（扩展/hooks）零依赖
    print("需要 Pillow：pip install pillow", file=sys.stderr)
    sys.exit(2)

SIZE = 24
BODY_W, BODY_H = 20, 22   # 本体降采样尺寸；内容框（含源图自带描边）最大边必须正好是 SIZE-2 = 22
COLORS = 20               # 调色板簇数（去重后一般 15~18 色）
SOLID = 0.45              # 一格被主体覆盖多少才算实心
SEED = 7                  # k-means 初始化随机种子（固定 → 产物可复现）
DARK_KEY = "0"            # 最暗的调色板键（调色板已按亮度排序）——瞳孔/鼻头/可选描边用它
SHINE = (240, 240, 240, 255)  # 眼睛高光

# 手工修饰表：源图里眼睛/鼻头存在，但降采样会把"比一格还小"的部分平均掉，
# 结果脸没有表情。位置是按源图量出来的（见 legacy-mods/README.md）：
#   眼睛高光中心 画布 (col 10.7 / 15.5, row 7.6)，瞳孔块 ≈2 格宽 x 2 格高
#   鼻头 中心 画布 (col 13.5, row 10.7)，块 ≈2 格宽 x 2 格高
# 键 (row, col) 是 24x24 画布坐标（内容框在 cols 2..21 / rows 1..22）。
TOUCHUP_PUPIL = [(7, 10), (8, 10), (7, 11), (8, 11),      # 左眼 2x2
                 (7, 15), (8, 15), (7, 16), (8, 16)]      # 右眼 2x2
TOUCHUP_SHINE = [(7, 10), (7, 15)]                        # 高光：每只眼睛的左上格
TOUCHUP_NOSE = [(10, 13), (10, 14), (11, 13), (11, 14)]   # 鼻头 2x2

GAME_BG = (13, 15, 20)  # 面板底色 #0D0F14，仅用于预览图


def load_source(path):
    """读源图并抠掉被烤进画面的棋盘格背景。

    判据：① 浅色（min 通道 > 150）且低彩度（通道极差 < 32）→ 候选背景；
    ② 只吃掉与画面边缘连通的候选像素（棋盘格两种灰都覆盖，且狗身上的奶白被深色描边
       围住、不连通，因此不会被误伤）。JPEG 噪声靠连通性兜住，不需要逐像素调阈值。
    """
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    light = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            light[y][x] = min(r, g, b) > 150 and max(r, g, b) - min(r, g, b) < 32
    bg = [[False] * w for _ in range(h)]
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if light[y][x] and not bg[y][x]:
                bg[y][x] = True
                dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if light[y][x] and not bg[y][x]:
                bg[y][x] = True
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and light[ny][nx] and not bg[ny][nx]:
                bg[ny][nx] = True
                dq.append((nx, ny))
    return im, bg


def crop_to_content(im, bg):
    w, h = im.size
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if not bg[y][x]:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        raise SystemExit("源图里没找到主体（背景判据把整张图都吃掉了）")
    big = Image.new("RGB", (x1 - x0 + 1, y1 - y0 + 1))
    mask = Image.new("L", big.size, 0)
    bp, mp = big.load(), mask.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if not bg[y][x]:
                bp[x - x0, y - y0] = im.getpixel((x, y))
                mp[x - x0, y - y0] = 255
    return big, mask


def snap16(v):
    return min(240, int(round(v / 16.0)) * 16)


def build_palette(big, mask, k=COLORS, stride=2, rounds=14, seed=SEED):
    """用源图自身的颜色做 k-means（按 stride 抽样加速），再对齐到 16 的整数倍。"""
    w, h = big.size
    bp, mp = big.load(), mask.load()
    pts = [bp[x, y] for y in range(0, h, stride) for x in range(0, w, stride) if mp[x, y]]
    if not pts:
        raise SystemExit("内容框里没有实体像素")
    rnd = random.Random(seed)
    cents = [tuple(rnd.choice(pts)) for _ in range(k)]
    for _ in range(rounds):
        acc = [[0.0, 0.0, 0.0, 0] for _ in range(k)]
        for p in pts:
            bi, bd = 0, None
            for i, c in enumerate(cents):
                d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
                if bd is None or d < bd:
                    bd, bi = d, i
            a = acc[bi]
            a[0] += p[0]
            a[1] += p[1]
            a[2] += p[2]
            a[3] += 1
        for i, a in enumerate(acc):
            if a[3]:
                cents[i] = (a[0] / a[3], a[1] / a[3], a[2] / a[3])
    # 迭代期间用浮点质心（提前 snap 到 16 会让相邻簇互相塌缩、色数骤减），最后才对齐到 16 并去重
    pal = []
    for c in cents:
        q = tuple(snap16(v) for v in c)
        if q not in pal:
            pal.append(q)
    pal.sort(key=lambda c: c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114)  # 由暗到亮
    return pal


def nearest_key(color, pal):
    bi, bd = 0, None
    for i, c in enumerate(pal):
        d = (color[0] - c[0]) ** 2 + (color[1] - c[1]) ** 2 + (color[2] - c[2]) ** 2
        if bd is None or d < bd:
            bd, bi = d, i
    return "0123456789abcdefghijklmnopqrstuvwxyz"[bi % 36]


def downsample(big, mask, pal, bw, bh, solid=SOLID):
    """块内多数票：每格取"格内像素最常落到的那个调色板色"。"""
    w, h = big.size
    bp, mp = big.load(), mask.load()
    grid = []
    for ty in range(bh):
        y0, y1 = ty * h // bh, max((ty + 1) * h // bh, ty * h // bh + 1)
        row = []
        for tx in range(bw):
            x0, x1 = tx * w // bw, max((tx + 1) * w // bw, tx * w // bw + 1)
            votes = Counter()
            tot = all_ = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    all_ += 1
                    if not mp[x, y]:
                        continue
                    tot += 1
                    votes[nearest_key(bp[x, y], pal)] += 1
            if not all_ or tot / all_ < solid:
                row.append(None)
            else:
                row.append(votes.most_common(1)[0][0])
        grid.append(row)
    return grid


def despeckle(grid, rounds=2):
    """只收拾"和邻居都不一样的孤立格"（成片区域一律不动）。"""
    h, w = len(grid), len(grid[0])
    for _ in range(rounds):
        out = [row[:] for row in grid]
        for y in range(h):
            for x in range(w):
                v = grid[y][x]
                if not v:
                    continue
                nb = Counter()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if (dy or dx) and 0 <= y + dy < h and 0 <= x + dx < w and grid[y + dy][x + dx]:
                            nb[grid[y + dy][x + dx]] += 1
                if not nb:
                    continue
                top, cnt = nb.most_common(1)[0]
                if top != v and cnt >= 6 and nb[v] <= 1:
                    out[y][x] = top
        grid = out
    return grid


def flatten(grid, rounds=0):
    """邻域众数滤波（可选）：会把 1 格宽的细节也一起抹掉，默认关。"""
    h, w = len(grid), len(grid[0])
    for _ in range(rounds):
        out = [row[:] for row in grid]
        for y in range(h):
            for x in range(w):
                if not grid[y][x]:
                    continue
                votes = Counter({grid[y][x]: 2})
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if (dy or dx) and 0 <= y + dy < h and 0 <= x + dx < w and grid[y + dy][x + dx]:
                            votes[grid[y + dy][x + dx]] += 1
                out[y][x] = votes.most_common(1)[0][0]
        grid = out
    return grid


def edge_outline(grid):
    """可选：把最外一圈实心格涂成最暗的调色板色（源图自带描边时不要开）。"""
    h, w = len(grid), len(grid[0])
    for y in range(h):
        for x in range(w):
            if not grid[y][x]:
                continue
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y + dy, x + dx
                if not (0 <= ny < h and 0 <= nx < w) or not grid[ny][nx]:
                    grid[y][x] = DARK_KEY
                    break
    return grid


def place(grid):
    """把本体网格居中放进 24x24（四周留 1px），返回 (画布, 内容框) 并核对尺寸。"""
    h, w = len(grid), len(grid[0])
    canvas = [[None] * SIZE for _ in range(SIZE)]
    ox, oy = (SIZE - w) // 2, (SIZE - h) // 2
    for y in range(h):
        for x in range(w):
            canvas[oy + y][ox + x] = grid[y][x]
    xs = [x for y in range(SIZE) for x in range(SIZE) if canvas[y][x]]
    ys = [y for y in range(SIZE) for x in range(SIZE) if canvas[y][x]]
    return canvas, (min(xs), min(ys), max(xs), max(ys))


def apply_touchup(canvas):
    for (r, c) in TOUCHUP_PUPIL + TOUCHUP_NOSE:
        canvas[r][c] = DARK_KEY


def to_rgba(canvas, pal):
    im = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    px = im.load()
    for r in range(SIZE):
        for c in range(SIZE):
            k = canvas[r][c]
            if k:
                px[c, r] = pal[int(k, 36)] + (255,)
    for (r, c) in TOUCHUP_SHINE:
        px[c, r] = SHINE
    return im


def build(body=(BODY_W, BODY_H), colors=COLORS, flat=0, outline="none", dump_ascii=True):
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.normpath(os.path.join(here, "..", "assets", "player-source-pixel.jpg"))
    if not os.path.exists(src):
        raise SystemExit("缺少源图 %s（不可再生的 AI 源图，见 legacy-mods/README.md）" % src)
    big, mask = crop_to_content(*load_source(src))
    pal = build_palette(big, mask, colors)
    grid = downsample(big, mask, pal, body[0], body[1])
    grid = despeckle(flatten(grid, flat))
    if outline != "none":
        grid = edge_outline(grid, pal)
    canvas, box = place(grid)
    apply_touchup(canvas)
    if dump_ascii:
        print("源图 %dx%d → 调色板 %d 色（k-means k=%d）→ 本体 %dx%d → 内容框 %dx%d @ cols %d..%d rows %d..%d"
              % (big.size[0], big.size[1], len(pal), colors, body[0], body[1],
                 box[2] - box[0] + 1, box[3] - box[1] + 1, box[0], box[2], box[1], box[3]))
        used = Counter(k for row in canvas for k in row if k)
        print("网格用量：" + "  ".join("%s=%s×%d" % (k, "#%02X%02X%02X" % pal[int(k, 36)], used[k])
                                       for k in sorted(used, key=lambda k: int(k, 36))))
    return canvas, box, pal


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.normpath(os.path.join(here, "..", "assets", "player.png"))

    ap = argparse.ArgumentParser(description="从 AI 像素源图生成 24x24 主角源图")
    ap.add_argument("--out", default=default_out, help="输出 PNG（默认 assets/player.png）")
    ap.add_argument("--preview", help="额外导出放大预览图（叠加 24x24 格线）")
    ap.add_argument("--body", default="%dx%d" % (BODY_W, BODY_H),
                    help="本体降采样尺寸，如 20x22（默认 %dx%d）" % (BODY_W, BODY_H))
    ap.add_argument("--colors", type=int, default=COLORS, help="调色板簇数（默认 %d）" % COLORS)
    ap.add_argument("--outline", default="none", choices=("none", "edge"),
                    help="描边策略：none=用源图自带（默认）/ edge=最外一圈涂描边色")
    ap.add_argument("--flatten", type=int, default=0, help="邻域众数滤波轮数（默认 0=关）")
    ap.add_argument("--dump", action="store_true", help="只在终端打印网格，不写文件")
    args = ap.parse_args()

    body = tuple(int(v) for v in args.body.lower().split("x"))
    canvas, box, pal = build(body=body, colors=args.colors, flat=args.flatten,
                             outline=args.outline, dump_ascii=True)
    for i, row in enumerate(canvas):
        print("%2d %s" % (i, "".join(k if k else "." for k in row)))
    w, h = box[2] - box[0] + 1, box[3] - box[1] + 1
    if max(w, h) != SIZE - 2:
        print("⚠️  内容框 %dx%d 的最大边不是 %d：png2grid 会等比缩放（重采样），形象会糊"
              % (w, h, SIZE - 2))
    else:
        print("内容框 %dx%d（最大边 %d）→ png2grid 恒等变换 ✓" % (w, h, SIZE - 2))
    if args.dump:
        return

    im = to_rgba(canvas, pal)
    im.save(args.out)
    print("已写入 %s（24x24 RGBA，%d 色）" % (args.out, len(set(k for row in canvas for k in row if k))))
    if args.preview:
        s = 14
        big = Image.new("RGB", (SIZE, SIZE), GAME_BG)
        big.paste(im, (0, 0), im)
        big = big.resize((SIZE * s, SIZE * s), Image.NEAREST)
        for i in range(SIZE + 1):
            for j in range(SIZE + 1):
                if i < SIZE:
                    big.putpixel((min(i * s, SIZE * s - 1), min(j * s, SIZE * s - 1)), (60, 60, 70))
                if j < SIZE:
                    big.putpixel((min(j * s, SIZE * s - 1), min(i * s, SIZE * s - 1)), (60, 60, 70))
        big.save(args.preview)
        print("已写入预览 %s" % args.preview)

    print("\n下一步：\n  node legacy-mods/tools/png2grid.mjs legacy-mods/pixels/_pixels.gen.txt legacy-mods/preview \\\n"
          "    player=legacy-mods/assets/player.png bat=legacy-mods/assets/bat.png \\\n"
          "    slime=legacy-mods/assets/slime.png mimic=legacy-mods/assets/mimic.png\n"
          "  再把新的 player palette/rows 内联进 plugins/nibble/hooks/pixels.js，最后 npm run sync")


if __name__ == "__main__":
    main()
