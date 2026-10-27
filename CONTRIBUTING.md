# 贡献与提交约定（CONTRIBUTING）

> 面向场景：改完代码或文档，提交前照这份走一遍。
> 一句话：**先自检 → 开分支 → 提交 → 走 PR**。

---

## 1. 提交前按改动范围自检

| 你改了什么 | 提交前跑 |
|---|---|
| `vscode-extension/` 里的逻辑、UI、存档 | `npm run test` |
| 怪物 / 武器 / 技能书的数值 | `npm run balance:sim` |
| `site/` 官网与演示 | `npm run site:check` |
| 只改 Markdown | 不用跑，但记得回写索引、检查链接 |

命令都在仓库根目录 `nibble-cb/` 下执行。`npm run test` 不过就别提交。

## 2. 提交信息格式

```
type: 中文简述
```

`type` 取 `feat` / `fix` / `docs` / `refactor` / `perf` / `chore`。正文分条写**改了什么**和**验证了什么**：

```
fix: 连击光环在 0 级时不该闪烁

- 光环绘制前补 0 值判断，避免取模落到空帧
- npm run test 通过
```

不要写「update」「fix bug」这类空话，也不要把几个不相关的改动塞进同一个提交。

## 3. 走分支 + PR，不直接推 main

```powershell
git checkout -b docs/xxx        # 分支名：type/简述
git add -A
git commit -m "docs: xxx"
git push -u origin docs/xxx
gh pr create --base main --head docs/xxx
```

PR 描述里写清两件事：**改了什么、怎么验证的**。合并方式不限（merge 或 squash），合完把分支删掉。

## 4. 结对 / 多人改动时加合著者

在 commit 末尾加 trailer，GitHub 会把这次贡献同时算给两个人：

```
Co-authored-by: 名字 <someone@users.noreply.github.com>
```

## 5. 文档放哪

| 写什么 | 放哪 |
|---|---|
| 玩法 / 系统设计 / 版本规划 | `docs/游戏升级规划/`（`README.md` 是索引，新增文档要回写索引） |
| 打包、上架、版本号 | `PUBLISHING.md` |
| 面向用户的玩法与安装说明 | `README.md` |

新设计文档沿用两位数序号（如 `13-xxx.md`），并在索引表里补一行「定位 / 面向谁 / 什么时候看」。

## 6. 别做的事

- 别提交 `dist/`、`node_modules/`、临时预览图（`.gitignore` 已覆盖，别手动 `-f` 绕过）。
- 别改 `publisher` 字段（`nibble` 是 Open VSX 的命名空间，改了就打不上）。
- 别在文档里写死本机绝对路径。
- 改像素素材 / 精灵图时，PR 里附一张**新旧并排对比**，别只描述。
