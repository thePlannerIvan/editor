---
name: editor
description: 分层校对文章，并把建议放进一张全文可编辑的修订页：AI 建议以红/绿内联在正文里，点绿＝同意修改、点红＝不改，没点的默认接受；正文其余部分可以直接改。审阅面挂 DSH 侧栏（公共缝 planners-review-core + DSH 设计令牌），没有 DSH 时由同一份页面走本地宿主，双击打开也能复制结果回对话。触发：/editor、检查一下这篇文章、校对一下、校稿、校对这篇文章。
---

> 来源：阿祖不看 TVC · [demyth.info](https://demyth.info) · `Lawyif@163.com`。保留 Skill 的来源识别；最终客户交付物的署名按项目约定处理。

# 文章校对 Skill

分层校对中文文章。不改原意、不碰风格、不懂的标注存疑而非瞎改。

## 一句话

**分层校对 + 全文可编辑修订页**：AI 建议内联成红/绿片段，点绿同意、点红不改，未点默认接受；正文其他部分直接编辑；提交时以页面合成的 `final_text` 为准。

## 触发

- 模式：user-invoked
- 应该触发于："检查一下这篇文章""校对一下这篇文章""帮我校对一下""校稿"
- 不应该触发于：润色/改写文章、视频口播稿精炼（已有 `script-refiner`）、翻译

## 与相邻 Skill 的关系

- **上游**：`research` / `wiki-builder` 产出的资料与笔记、任何已成稿的中文文章。
- **不在本 Skill 里**：视频口播稿精炼与创意角度（`script-refiner`）、那条片的流程与判断（`video-idea-system`）、逐页 PPT 文案（`planners-bypage`）。
- **消费公共件 `planners-review-core`**：审阅面走它的契约（`review-surface.json` + 桥 + 宿主），样式用它的 **DSH 设计令牌**（页面跑在不透明源 iframe 里，令牌只能随页面内联，所以编辑时只存一份、由生成器内联）。LOGO 也从公共件取（`assets/review-ui/logics-mark.svg`）。**页面只写一份**：DSH 侧栏、没插件时的本地宿主、双击打开（退回复制回对话）三种场合跑的是同一份 `index.html`。
- **公共件要平铺在同一个 skills 根下**（`publish_skills.py` 发布后即是）；找不到时生成器会报错并给出候选路径，不会静默降级。
- **记忆边界**：`references/memory.md` 只存与本 Skill 相关的用户风格偏好；工作区级通用记忆归 `CLAUDE.md` / `AGENTS.md`（见该文件开头）。

## 总体流程

```
读入文章 → 并行三层检查 → 写 anchored review-data.json → 生成审阅面 → 打开
   → 用户点绿/点红、直接改正文 → 提交 → 读 review-feedback.json
   → L3 勾选项查证 → 以 final_text 生成干净版 + 摘要
```

## Step 0: 读入文章

获取待校对文本，方式二选一：
- 用户提供文件路径 → 读取全文，记录源文件绝对路径
- 用户直接粘贴文本 → 先写到临时 `.md` 文件，记录该路径（新页面必须从原文读 Markdown）

记录：`源路径 | 文本内容`

## Step 1: 三层并行检查

对同一文本同时执行三个层级的检查。每层产出结构化结果。

### L1 机械性错误

检查项：
- 错别字、同音字（拼音输入法错误）、形近字
- 中英文标点混用（`,` `;` `:` 等应为中文全角 `，` `；` `：`）
- "的/地/得"误用
- 多余空格、空行
- 书名号、引号配对

规则：
- **默认建议修改**，页面上默认接受
- 只报机械性错误，不涉及风格和表达
- 不确定的标点/用字标"疑似"，`default: "reject"`（未点时按保留原文）

### L2 语法与表达

检查项：
- 成分残缺（缺主语、缺宾语）
- 语序颠倒/修饰语错位
- 逻辑断层或前后矛盾
- 口语化废话（"然后""其实""可以说""总的来说"的过度使用）
- 关联词错配（"虽然……而且……"）
- 重复用词（同一段内同一词出现 3 次以上）

规则：
- 只标注建议，不自动改原意
- 已知用户口癖/风格 → 自动跳过（从 `references/memory.md` 读取风格规则）
- 不确定是否为故意表达 → 标"疑似"并附解释
- 严重程度：**高**（明显影响理解）/ **中**（读起来别扭）/ **低**（可优化但不影响阅读）
- 参考 `references/proofreading-methodology.md` 中的详细雷区清单

### L3 事实存疑标注

检查项：
- 数据（百分比、金额、排名、数量级）
- 公司名称、品牌名拼写
- 人名、职位、头衔
- 时间线、具体日期、历史年代
- 书名、引文、名言归属
- 专业术语
- 前后数据/时间矛盾
- 违反常识的表述（如"清晨的夕阳"）

规则：
- **只标注存疑，不自动搜索验证**
- 存疑标注含：`{位置, 原文, 存疑原因, 建议查证方向}`
- 观点性内容不管；事实硬伤零容忍
- 不确定是否为事实错误 → 标"低置信度存疑"

### 生成数据前：锚点必须是字面文本

页面不靠行号，靠**在原文里找到同一段字面文本**。写 `review-data.json` 时遵守：

- `before` / `after`（L1/L2）和 `anchor`（L3，默认用 `context`）是原文里的**字面片段**；说明、行号、注释都放在 `type` / `tag` / `note` / `reason` 里，不要混进 literal。
- 不跨段落；不把标题/列表符号 `#` `>` `-` 写进锚点（分块时已经剥掉）。
- 默认要求全篇唯一。重复出现：
  - 同一改法所有出现都改 → `"all": true`
  - 只改其中一处 → `"nth": 0`（从 0 起）
- 一条里如果包含两处不相邻的修改 → 拆成两条。
- L1/L2 的 diff 区间**不能重叠**（包括包含关系）；重叠时合并成一条（把一处修正并进另一条的 `after`，在 note 说明），或收窄范围。
- L3 之间不能重叠；L3 与 L1/L2 允许重叠，页面只高亮尚未被 diff 占用的文本。
- 写完跑生成器。**锚点找不到 / 多义 / 重叠都会报错**，按报错修数据，不要手写 HTML 绕过。

## Step 2: 生成审阅面

### 2a. 写 `review-data.json`

```json
{
  "article": {
    "title": "文章名",
    "source": "/abs/原稿.md",
    "clean": "/abs/校对版.md"
  },
  "l1": [
    { "id": "l1-1", "type": "的地得 · L19",
      "before": "能够平静的表达", "after": "能够平静地表达",
      "default": "accept", "note": "可选说明" }
  ],
  "l2": [
    { "id": "l2-1", "severity": "high|medium|low",
      "tag": "句式杂糅 · L17", "note": "为什么建议这样改",
      "before": "……", "after": "……" }
  ],
  "l3": [
    { "id": "l3-1", "level": "高|中|低", "tag": "名言 · L129",
      "context": "页面高亮的原文",
      "anchor": "可选；默认等于 context，必须是原文里有的一句",
      "reason": "为什么存疑", "direction": "建议怎么查" }
  ]
}
```

- `id` 只用 `a-z0-9-`、每层内唯一。
- `before`/`after` 是字面替换；`note` 是给人看的解释。
- 多出现：`all: true`；指定第 n 处：`nth: n`。
- `article.source` 必填；页面从这里读原文分块。

### 2b. 生成并校验

```bash
node "<本 Skill>/scripts/build-review-page.mjs" \
  --data "<审阅目录>/review-data.json" \
  --review-dir "<审阅目录>"
```

- 产出 `index.html`、`review-surface.json`；页面提交后另有 `review-feedback.json`、`review-draft.json`；
- 生成器**当场跑 `planners-review-core` 的官方校验器**，`validator: "合规：0 个警告"` 才算过；
- 审阅目录约定：`<文章同目录>/<文章名>-校对确认/`（`--project-root` 默认 `..`）；
- 上一轮的 `review-feedback.json` / `review-draft.json` 会归档成 `*.prev-<时间>.json`，**不会被当成这一轮的收件**；
- 输出里的 `surface` 就是下一步要交给宿主的绝对路径。

### 2c. 打开给用户

| 场合 | 动作 |
|---|---|
| 有 DSH | 把 `surface` 绝对路径交给 `review_open` 工具 —— 页面挂在右侧栏审阅标签 |
| 没有 DSH | `node "<review-core>/scripts/serve-review.mjs" "<surface>"` —— 本地宿主，桥自动切 fetch 通道 |
| 用户直接双击 `index.html` | 页面显示「未连接审阅宿主」（可直接复制结果） |

> 想让人重看同一面（改完重出一版）：**再调一次 `review_open`**，别假设面板会自己刷新。

### 2d. 页面怎么被使用

- **整篇正文可直接编辑**（像 Typora / Notion）：点正文落光标，增删字、拆段、换词都可以。
- **AI 建议是内联的原子片段**，点之前不能把光标塞进去，避免敲字把红绿结构切碎：
  - **绿 = 修改后**：点绿 → 同意修改，红色原文删除，绿字落成普通正文，光标停在后面，可以继续改。
  - **红 = 修改前**：点红 → 不改，绿色建议删除，红色原文落成普通正文，可以继续改。
  - **没点的默认接受**：提交时全部按「修改后」合并，不需要逐条确认。
  - `⌥` 点可反向选择（纯新增/纯删除的条目用得上）。
  - 落成正文后，AI 片段就变成普通文本，后续随便编辑。
- **L3 琥珀色**：点一下切换「要查证」；不改正文。
- **撤销**：顶栏 `↶` 或 `⌘Z`，恢复上一步修订操作。
- **左栏**是改动清单：`接受 / 默认接受 / 保留原文 / 人工`，点一行跳到对应段落；不占右侧宽度，原右侧详情面板已移除。
- **草稿自动保存**：改动写 `review-draft.json`，刷新/重开恢复（`dataVersion` 不同则不恢复）；提交仍走 `write` + `wake`。
- **没有宿主**时退回复制结果 JSON，粘回对话即可。

### 2e. 收件：`editor-decisions/2`

用户提交后，**先读 `review-feedback.json`**（不要凭页面记忆）。形状：

```json
{
  "contract": "editor-decisions/2",
  "article": { "title": "…", "source": "…", "clean": "…" },
  "submitted_at": "…",
  "page": { "host": "dsh", "pre_check": false },
  "final_text": "整篇最终正文（决定应用 + 人工编辑）",
  "l3_find": ["l3-1", "l3-3"],
  "default_accepted": true,
  "accepted_changes": ["l1-1", "…"],
  "rejected_changes": ["l2-4", "…"],
  "manual_blocks": ["b29", "…"],
  "stats": { "total_changes": 41, "accepted": 38, "rejected": 3, "l3_checked": 2, "manual_blocks": 1 }
}
```

- **`final_text` 是权威正文**：用户点红保留的原文、点了绿的修改、直接改的字，都在里面。**不要再逐条应用 `accepted_changes` / `rejected_changes`**，会重复或漂移。
- `rejected_changes` / `accepted_changes` / `manual_blocks` 只用于摘要与理解；`l3_find` 用于查证。
- 用户直接口头说选择（没动页面）同样有效：把他的最终文本和意见当决定。

## Step 3: L3 查证子流程（条件触发）

`l3_find` 里的条目：
- 逐条搜索验证（优先一手来源）
- 每条输出：`{原文, 查证结论(确认有误/确认正确/无法确定), 来源链接, 建议修改}`
- **结论先交回对话二次确认**，再决定是否改；不要直接覆盖用户的 `final_text`。

## Step 4: 生成干净版 + 摘要

按 `final_text`（或用户口头确认的最终文本）：
1. 写入干净版：`article.clean`（默认 `{原名}-校对版{扩展名}`，同目录）。
2. 做一次完整性抽查：段落数、分隔线、标题层级、首尾段落没有丢；`final_text` 已应用的建议不重复改。
3. 对话中输出摘要：

```
## 校对摘要
- 接受：X 处（L1 a 处、L2 b 处）
- 保留原文：Y 处（用户点红）
- 人工改写：Z 段（用户直接改）
- L3 查证：W 处修改，V 处确认无误，U 处无法确定
```

## Step 5: 风格学习（后置，静默）

分析本次用户点红保留的 L2 条目与人工改写：
- 提取可能的风格偏好/口癖模式
- 按 `运行后迭代` 规则写入 `references/memory.md`（用户确认后）

## 人机介入点

| 节点 | 时机 | 形式 | 用户操作 |
|---|---|---|---|
| 整篇修订 | 页面打开后 | DSH 侧栏 / 本地宿主 / 复制 JSON | 点绿同意、点红不改、直接改正文；未点默认接受 |
| L3 查证 | 提交后 | 对话 + 按钮选项 | 逐条接受/拒绝 |
| 输出位置 | 粘贴文本且无源文件时 | AskUserQuestion | 输入保存路径 |

## 资源

### references/
- `proofreading-methodology.md`：校对方法论、常见雷区清单、分层检查规则细节。Step 1 各层检查时读取。
- `memory.md`：本 Skill 的用户记忆（风格偏好/口癖，按 `[[标签]]` 分组）。L2 检查时读取，运行后迭代时写入。

### assets/
- `review-page.html`：页面模板（数据驱动；有 `PAGE_TITLE` / `LOGO_SVG` / `REVIEW_DATA` 占位符、裸桥注入点、DSH 令牌占位符）。
- `review-page.css`：页面样式（全部走 DSH 令牌；红绿取自 DSH 文件 diff 令牌）。
- `review-page.js`：页面交互（可编辑正文、绿同意/红不改、未点默认接受、L3 查证标记、撤销、草稿、提交）。

### scripts/
- `build-review-page.mjs`：Step 2b 的生成器（读原文 → 分块 → 锚点 → diff → runs → 页面 + surface + 内联令牌 + 跑官方校验器）。数据形状写在文件头。
- `lib/review-core.mjs`：找公共件 `planners-review-core` 的适配器（`node scripts/lib/review-core.mjs --check` 可自检）。

### evals/
- `run.mjs`：回归网。真起无插件宿主、真 POST 草稿与决定、真读回 `review-feedback.json`；另有反面对照（锚点找不到/多义/重叠必须报错；删掉注入点必须被校验器挡下）。
- 跑法：`node "<本 Skill>/evals/run.mjs"`（需要 `node` 与 `python3`：令牌内联用公共件的 Python 脚本）。

## 运行后迭代

每次使用本 Skill 后，做轻量 Memory Audit：

1. 用户反复点红保留的 L2 模式 → 提取为用户风格规则，写入 `references/memory.md`（需用户确认）
2. 人工改写中反复出现的替换 → 同上
3. 连续遗漏的某一类错误 → 升级为 `proofreading-methodology.md` 的补充规则
4. 已失效的旧规则 → 标记或移除

运行后向用户提示：
> 本次校对有 [N] 个可能值得记住的风格偏好：[简述]。是否需要写入记忆？（写入/忽略）
