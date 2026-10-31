# Editor · 文章校对

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-2563eb)](LICENSE)

Editor 是一个分层校对中文文章的技能。它把 AI 的修改直接放进文章正文：红色是修改前，绿色是修改后；点绿同意，点红不改，没点的默认接受。正文其余部分可以直接编辑，最后提交的是页面上的整篇最终正文。

> 作者：阿祖不看 TVC（小红书同名）· [demyth.info](https://demyth.info) · [Lawyif@163.com](mailto:Lawyif@163.com)

## 它解决什么

```text
读入文章 → 三层检查（机械性 / 表达 / 事实存疑）
→ 生成一张全文可编辑的修订页
→ 用户点绿/点红、直接改正文
→ 提交 → L3 查证 → 最终正文 + 校对摘要
```

- **L1 机械性**：错别字、标点、的地得。默认改。
- **L2 语法表达**：成分、语序、搭配、赘余。给建议，尊重作者风格。
- **L3 事实存疑**：数据、引文、人名、时间线。只标疑，用户点「要查证」后再去搜。

## 审阅页怎么用

- **绿 = 修改后**：点绿同意修改，红色原文删除，绿字变成普通正文，光标停在后面，可以继续改。
- **红 = 修改前**：点红不改，绿色建议删除，红色原文变成普通正文。
- **没点的默认接受**：提交时全部按修改后合并。
- 正文其余部分本来就是可直接编辑的；AI 建议是内联的原子片段，点一下才会变成普通文本。
- 左栏是改动清单；撤销用顶栏 `↶` 或 `⌘Z`；草稿自动保存。

## 安装

优先通过 [Planners Form](https://github.com/thePlannerIvan/planners-form) 安装，它会同时准备好 `planners-review-core`。

通用 Skills CLI：

```bash
npx skills add https://github.com/thePlannerIvan/editor --skill editor
```

## 依赖

- [`planners-review-core`](https://github.com/thePlannerIvan/planners-review-core) —— 审阅面契约、桥、本地宿主、DSH 设计令牌与 LOGO。

没有它时生成器会明确报错并列出候选路径，不会静默降级。

## 文件

```text
SKILL.md                  Skill 入口与工作流
assets/review-page.*      审阅页模板 / 样式 / 交互
scripts/build-review-page.mjs
scripts/lib/review-core.mjs
references/               校对方法论与用户记忆
evals/run.mjs             回归网
```

## 开发与验证

```bash
node evals/run.mjs
```

需要 `node` 与 `python3`（DSH 令牌内联使用公共件的 Python 脚本）。

## 许可与归属

- 代码与文档：**AGPL-3.0-only**，见 [LICENSE](LICENSE)。
- 来源与维护者：阿祖不看 TVC，见 [NOTICE](NOTICE) 与 [TRADEMARK.md](TRADEMARK.md)。
- 商业支持与闭源授权：见 [COMMERCIAL.md](COMMERCIAL.md)。
