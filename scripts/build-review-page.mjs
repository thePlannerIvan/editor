#!/usr/bin/env node
/**
 * editor 审阅页生成器：数据 JSON + 原文 Markdown → 可编辑修订页 + surface，并当场校验。
 *
 * 数据契约（review-data.json）：
 * {
 *   "article": { "title": "文章名", "source": "/abs/原稿.md", "clean": "/abs/校对版.md" },
 *   "l1": [{ "id":"l1-1", "type":"的地得 · L19", "before":"能够平静的表达", "after":"能够平静地表达",
 *            "default":"accept|reject", "note":"可选说明", "all":false, "nth":0 }],
 *   "l2": [{ "id":"l2-1", "severity":"high|medium|low", "tag":"句式杂糅 · L17", "note":"…",
 *            "before":"…", "after":"…" }],
 *   "l3": [{ "id":"l3-1", "level":"高|中|低", "tag":"名言 · L129", "context":"…",
 *            "anchor":"可选的精确原文（默认用 context）", "reason":"…", "direction":"…" }]
 * }
 *
 * before / after / anchor 必须是原文里的**字面文本**（去掉 Markdown 块前缀之后），
 * 默认要求全篇唯一；重复出现用 all:true，指定第 n 处用 nth（0 起）。
 * L1/L2 的 diff 区间不能重叠；L3 之间不能重叠。重叠时生成器直接报错，让模型合并或收窄。
 *
 * 输出：index.html（单文件，内联 DSH 令牌 / 样式 / 脚本 / 数据）、review-surface.json。
 * 用法：node scripts/build-review-page.mjs --data <review-data.json> --review-dir <dir>
 *        [--project-root <相对 surface，默认 "..">] [--id editor/proofread-xxxx]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { moduleScript, requireModule } from './lib/review-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, '..');
const TEMPLATE = join(SKILL_DIR, 'assets', 'review-page.html');
const STYLES = join(SKILL_DIR, 'assets', 'review-page.css');
const APP = join(SKILL_DIR, 'assets', 'review-page.js');
const CONTRACT_VERSION = 'review-surface/2.0.0';
const FEEDBACK_REL = 'review-feedback.json';
const DRAFT_REL = 'review-draft.json';

function usage() {
  console.log([
    '用法：node scripts/build-review-page.mjs --data <review-data.json> --review-dir <dir>',
    '        [--project-root <相对 surface，默认 "..">] [--id editor/proofread-xxxx]',
    '',
    '--review-dir 里会产出：index.html、review-surface.json；页面提交后另有 review-feedback.json / review-draft.json。',
  ].join('\n'));
}
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (!arg.startsWith('--')) throw new Error(`多余的参数：${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺一个值`);
    args[key] = value;
    i += 1;
  }
  if (!args.data) throw new Error('缺 --data');
  if (!args['review-dir']) throw new Error('缺 --review-dir');
  return args;
}
function fail(message) {
  const error = new Error(message);
  error.isBuildError = true;
  throw error;
}
function requireString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} 必须是非空字符串`);
  return value;
}
function uniqueIds(items, layer) {
  const seen = new Set();
  for (const item of items) {
    const id = requireString(item && item.id, `${layer} 每一项的 id`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`${layer} 的 id「${id}」只能用 a-z0-9-，且以字母数字开头`);
    if (seen.has(id)) fail(`${layer} 的 id 重复：${id}`);
    seen.add(id);
  }
  return items;
}

/* ------------------------------------------------------------------ 数据闸门 */

function validateData(data) {
  if (!data || typeof data !== 'object') fail('review-data.json 不是一个对象');
  if (!data.article || typeof data.article !== 'object') fail('缺 article');
  requireString(data.article.title, 'article.title');
  requireString(data.article.source, 'article.source（新的页面要从原文读 Markdown）');
  for (const layer of ['l1', 'l2', 'l3']) {
    if (!Array.isArray(data[layer])) fail(`${layer} 必须是数组`);
    uniqueIds(data[layer], layer);
  }
  for (const item of data.l1) {
    requireString(item.before ?? item.orig, `l1 ${item.id}.before`);
    requireString(item.after ?? item.new, `l1 ${item.id}.after`);
    if (item.default !== undefined && !['accept', 'reject'].includes(item.default)) {
      fail(`l1 的 ${item.id}.default 只能是 accept / reject`);
    }
    if (item.all !== undefined && typeof item.all !== 'boolean') fail(`l1 ${item.id}.all 必须是布尔值`);
    if (item.nth !== undefined && (!Number.isInteger(item.nth) || item.nth < 0)) fail(`l1 ${item.id}.nth 必须是非负整数`);
  }
  for (const item of data.l2) {
    if (!['high', 'medium', 'low'].includes(item.severity)) fail(`l2 的 ${item.id}.severity 只能是 high / medium / low`);
    requireString(item.before, `l2 ${item.id}.before`);
    requireString(item.after, `l2 ${item.id}.after`);
    if (item.all !== undefined && typeof item.all !== 'boolean') fail(`l2 ${item.id}.all 必须是布尔值`);
    if (item.nth !== undefined && (!Number.isInteger(item.nth) || item.nth < 0)) fail(`l2 ${item.id}.nth 必须是非负整数`);
  }
  for (const item of data.l3) {
    requireString(item.level, `l3 ${item.id}.level`);
    requireString(item.context, `l3 ${item.id}.context`);
    if (item.anchor !== undefined) requireString(item.anchor, `l3 ${item.id}.anchor`);
    requireString(item.reason, `l3 ${item.id}.reason`);
    requireString(item.direction, `l3 ${item.id}.direction`);
  }
  return data;
}

/* ------------------------------------------------------------------ 分块 */

function parseBlocks(source) {
  const blocks = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ kind: 'hr', text: '---', line: index + 1 });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: `h${heading[1].length}`, text: heading[2].trim(), line: index + 1 });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ kind: 'quote', text: quote[1].trim(), line: index + 1 });
      continue;
    }
    const li = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (li) {
      blocks.push({ kind: 'li', text: li[1].trim(), line: index + 1 });
      continue;
    }
    blocks.push({ kind: 'p', text: line.trim(), line: index + 1 });
  }
  return blocks.map((block, index) => ({ ...block, id: `b${index + 1}` }));
}

/* ------------------------------------------------------------------ diff */

/** 前后缀 diff：整段建议显示成一对干净的红/绿，而不是一堆碎字。 */
function spanHunk(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return [{
    start: prefix,
    del: before.slice(prefix, before.length - suffix),
    ins: after.slice(prefix, after.length - suffix),
  }];
}
function findAll(text, needle) {
  const out = [];
  if (!needle) return out;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    out.push(index);
    index += 1;
  }
  return out;
}

function locateItems(items, blocks) {
  for (const item of items) {
    const needle = item.layer === 'l3' ? (item.anchor || item.context) : item.before;
    const found = [];
    blocks.forEach((block, blockIndex) => {
      if (block.kind === 'hr') return;
      for (const start of findAll(block.text, needle)) found.push({ blockIndex, start });
    });
    if (!found.length) {
      fail(`${item.layer} ${item.id} 的锚点没找到：${JSON.stringify(needle.slice(0, 48))}\n`
        + '  · 锚点必须是原文里的字面文本（去掉 # / > / - 等 Markdown 块前缀之后）\n'
        + '  · 不要跨段落，不要把说明写进 before/after；说明放 note / type / tag');
    }
    if (!item.all && found.length > 1 && item.nth === undefined) {
      fail(`${item.layer} ${item.id} 的锚点出现 ${found.length} 次（${found.map((entry) => `L${blocks[entry.blockIndex].line}`).join('、')}）。\n`
        + '  · 同一改法全篇都改：加 "all": true\n'
        + '  · 只要其中一处：加 "nth": 0/1/…\n'
        + '  · 或把锚点写长一点');
    }
    let occurrences = found;
    if (item.all) occurrences = found;
    else if (item.nth !== undefined) occurrences = found[item.nth] ? [found[item.nth]] : [];
    else occurrences = found.slice(0, 1);
    if (!occurrences.length) fail(`${item.layer} ${item.id} 的 nth 越界`);
    item.occurrences = occurrences;
    item.blocks = [...new Set(occurrences.map((entry) => blocks[entry.blockIndex].id))];
  }
}

function buildRuns(blocks, items) {
  const delEvents = blocks.map(() => []);
  const insEvents = blocks.map(() => []);
  const ctxEvents = blocks.map(() => []);

  for (const item of items) {
    item.hadRed = false;
    item.hadGreen = false;
    for (const occurrence of item.occurrences) {
      if (item.layer === 'l3') {
        ctxEvents[occurrence.blockIndex].push({
          id: item.id,
          start: occurrence.start,
          end: occurrence.start + (item.anchor || item.context).length,
        });
        continue;
      }
      const hunks = spanHunk(item.before, item.after);
      for (const hunk of hunks) {
        const start = occurrence.start + hunk.start;
        if (hunk.del) {
          item.hadRed = true;
          delEvents[occurrence.blockIndex].push({ id: item.id, start, end: start + hunk.del.length });
        }
        if (hunk.ins) {
          item.hadGreen = true;
          insEvents[occurrence.blockIndex].push({ id: item.id, pos: start + hunk.del.length, text: hunk.ins });
        }
        if (!hunk.del && !hunk.ins) fail(`${item.id} 的 before / after 完全相同，这条不该出现`);
      }
      if (occurrence.start + item.before.length > blocks[occurrence.blockIndex].text.length) {
        fail(`${item.id} 的区间超出段落`);
      }
    }
  }

  // 重叠：L1/L2 的删除区间不能重叠，插入点不能落进别人的删除区间。
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const dels = delEvents[blockIndex];
    for (let i = 0; i < dels.length; i += 1) {
      for (let j = i + 1; j < dels.length; j += 1) {
        const a = dels[i];
        const b = dels[j];
        if (a.start < b.end && b.start < a.end) {
          fail(`修订范围重叠：${a.id}（L${blocks[blockIndex].line}）与 ${b.id} 的删除区间相交。\n`
            + '  · 请合并成一条（把其中一条的修正并进另一条的 after），或收窄范围；页面不做嵌套修订。');
        }
      }
    }
    for (const ins of insEvents[blockIndex]) {
      for (const del of dels) {
        if (ins.pos > del.start && ins.pos < del.end) {
          fail(`插入点冲突：${ins.id} 的插入点落在 ${del.id} 的删除区间内部。`);
        }
      }
    }
    const positions = new Map();
    for (const ins of insEvents[blockIndex]) {
      if (positions.has(ins.pos) && positions.get(ins.pos) !== ins.id) {
        fail(`插入点冲突：${positions.get(ins.pos)} 与 ${ins.id} 插在同一位置。`);
      }
      positions.set(ins.pos, ins.id);
    }
    const ctxs = ctxEvents[blockIndex];
    for (let i = 0; i < ctxs.length; i += 1) {
      for (let j = i + 1; j < ctxs.length; j += 1) {
        if (ctxs[i].start < ctxs[j].end && ctxs[j].start < ctxs[i].end) {
          fail(`事实存疑范围重叠：${ctxs[i].id} 与 ${ctxs[j].id}；请收窄其中一条的 context/anchor。`);
        }
      }
    }
  }

  const group = (events, key) => {
    const map = new Map();
    for (const event of events) {
      const value = event[key];
      if (!map.has(value)) map.set(value, []);
      map.get(value).push(event);
    }
    return map;
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block.kind === 'hr') { block.runs = []; continue; }
    const len = block.text.length;
    const delAt = new Array(len).fill(null);
    for (const del of delEvents[blockIndex]) {
      for (let i = del.start; i < del.end; i += 1) delAt[i] = del.id;
    }
    const ctxAt = new Array(len).fill(null).map(() => []);
    for (const ctx of ctxEvents[blockIndex]) {
      for (let i = ctx.start; i < ctx.end; i += 1) ctxAt[i].push(ctx.id);
    }
    const insertionsAt = group(insEvents[blockIndex], 'pos');
    const runs = [];
    const flush = (pos) => {
      for (const ins of insertionsAt.get(pos) || []) runs.push({ i: ins.id, t: ins.text });
    };
    let pos = 0;
    flush(0);
    while (pos < len) {
      const del = delAt[pos];
      const ctx = ctxAt[pos];
      let end = pos + 1;
      while (end < len && delAt[end] === del && ctxAt[end].length === ctx.length
        && ctxAt[end].every((id, index) => id === ctx[index])
        && !insertionsAt.has(end)) end += 1;
      runs.push({ t: block.text.slice(pos, end), d: del || undefined, x: ctx.length ? ctx : undefined });
      pos = end;
      flush(pos);
    }
    block.runs = runs;
  }
}

/* ------------------------------------------------------------------ 页面 */

function inlineTokens(pagePath) {
  const script = moduleScript(join('scripts', 'inline_review_tokens.py'));
  const python = process.env.PYTHON || 'python3';
  const result = spawnSync(python, [script, pagePath], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') fail(`找不到 ${python}：内联 DSH 令牌要用 planners-review-core 的 inline_review_tokens.py`);
    fail(`内联 DSH 令牌失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`内联 DSH 令牌失败：\n${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`.trim());
  }
  const html = readFileSync(pagePath, 'utf8');
  if (!html.includes('DSH_TOKENS_BEGIN') || !html.includes('--dsw-alias-bg-base:')) {
    fail('令牌内联之后页面里没有令牌块 —— 页面会悄悄没上样式，拒绝写盘');
  }
  return (result.stdout || '').trim();
}
function validateSurface(surfacePath) {
  const validator = moduleScript(join('scripts', 'validate-surface.mjs'));
  const result = spawnSync(process.execPath, [validator, surfacePath, '--text'], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`审阅面不合规（${surfacePath}）：\n${`${result.stdout || ''}${result.stderr || ''}`.trim()}`);
  }
  const verdict = (result.stdout || '').split('\n').map((line) => line.trim())
    .filter((line) => /^(OK|合规)/.test(line)).at(-1);
  return verdict || 'OK';
}
function readLogo() {
  const logoPath = join(requireModule(), 'assets', 'review-ui', 'logics-mark.svg');
  if (!existsSync(logoPath)) {
    fail(`找不到 LOGO：${logoPath}\n（它由 planners-review-core 提供；重跑一次发布即可）`);
  }
  return readFileSync(logoPath, 'utf8').replace(/style="color:var\(--logics-ink,#0B0B10\);?"/, 'style="color:#fff"');
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const args = parseArgs(process.argv.slice(2));
  requireModule();
  const dataPath = resolve(args.data);
  if (!existsSync(dataPath)) fail(`找不到 data：${dataPath}`);
  for (const file of [TEMPLATE, STYLES, APP]) {
    if (!existsSync(file)) fail(`缺页面文件：${file}`);
  }
  const data = validateData(JSON.parse(readFileSync(dataPath, 'utf8')));

  const sourcePath = resolve(data.article.source);
  if (!existsSync(sourcePath)) fail(`article.source 不存在：${sourcePath}`);
  const source = readFileSync(sourcePath, 'utf8');
  if (!source.trim()) fail(`article.source 是空文件：${sourcePath}`);

  const blocks = parseBlocks(source);
  if (!blocks.length) fail('原文分不出任何段落');
  const items = [];
  for (const raw of data.l1) {
    items.push({
      id: raw.id, layer: 'l1',
      before: raw.before ?? raw.orig, after: raw.after ?? raw.new,
      tag: raw.type || '', note: raw.note || '',
      default: raw.default || 'accept', all: Boolean(raw.all), nth: raw.nth,
    });
  }
  for (const raw of data.l2) {
    items.push({
      id: raw.id, layer: 'l2',
      before: raw.before, after: raw.after,
      tag: raw.tag || '', note: raw.note || '', severity: raw.severity,
      all: Boolean(raw.all), nth: raw.nth,
    });
  }
  for (const raw of data.l3) {
    items.push({
      id: raw.id, layer: 'l3',
      context: raw.context, anchor: raw.anchor || raw.context,
      tag: raw.tag || '', level: raw.level,
      reason: raw.reason, direction: raw.direction,
    });
  }
  locateItems(items, blocks);
  buildRuns(blocks, items);

  const order = [...items].map((item) => {
    const first = item.occurrences[0];
    return { id: item.id, weight: first.blockIndex * 100000 + first.start };
  }).sort((a, b) => a.weight - b.weight).map((entry) => entry.id);

  const itemMap = {};
  for (const item of items) {
    itemMap[item.id] = {
      id: item.id,
      layer: item.layer,
      tag: item.tag,
      note: item.note || '',
      before: item.before || '',
      after: item.after || '',
      default: item.default,
      all: Boolean(item.all),
      severity: item.severity,
      level: item.level,
      context: item.context,
      reason: item.reason,
      direction: item.direction,
      blocks: item.blocks,
      occurrences: item.occurrences.length,
      hadRed: Boolean(item.hadRed),
      hadGreen: Boolean(item.hadGreen),
    };
  }

  const title = data.article.title;
  const payload = {
    dataVersion: createHash('sha1').update(JSON.stringify({ blocks, items: itemMap, title })).digest('hex').slice(0, 12),
    article: {
      title,
      source: sourcePath,
      clean: data.article.clean ? resolve(data.article.clean) : '',
      chars: source.replace(/\s/g, '').length,
    },
    counts: {
      l1: items.filter((item) => item.layer === 'l1').length,
      l2: items.filter((item) => item.layer === 'l2').length,
      l3: items.filter((item) => item.layer === 'l3').length,
    },
    blocks,
    items: itemMap,
    order,
  };

  const reviewDir = resolve(args['review-dir']);
  mkdirSync(reviewDir, { recursive: true });
  const entryPath = join(reviewDir, 'index.html');
  const feedbackPath = join(reviewDir, FEEDBACK_REL);
  const draftPath = join(reviewDir, DRAFT_REL);
  const surfacePath = join(reviewDir, 'review-surface.json');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archivedFeedback = null;
  let archivedDraft = null;
  if (existsSync(feedbackPath)) {
    archivedFeedback = join(reviewDir, `review-feedback.prev-${stamp}.json`);
    renameSync(feedbackPath, archivedFeedback);
  }
  if (existsSync(draftPath)) {
    archivedDraft = join(reviewDir, `review-draft.prev-${stamp}.json`);
    renameSync(draftPath, archivedDraft);
  }

  let html = readFileSync(TEMPLATE, 'utf8');
  const bridgeMatches = html.match(/^\s*\{\{REVIEW_BRIDGE\}\}\s*$/gm) || [];
  const bridgeOccurrences = (html.match(/\{\{REVIEW_BRIDGE\}\}/g) || []).length;
  if (bridgeOccurrences !== 1 || bridgeMatches.length !== 1) {
    fail('assets/review-page.html 里的 {{REVIEW_BRIDGE}} 必须恰好一处、且独占一行（宿主原地替换它）');
  }
  for (const token of ['{{PAGE_TITLE}}', '{{REVIEW_DATA}}', '{{LOGO_SVG}}']) {
    const hits = (html.match(new RegExp(token.replace(/[{}]/g, '\\$&'), 'g')) || []).length;
    if (hits !== 1) fail(`模板里的 ${token} 必须恰好一处（现在 ${hits} 处）——多了会让替换吃错位置`);
  }
  const pageTitle = `校对工作台 · ${title}`;
  html = html.replace('{{PAGE_TITLE}}', pageTitle.replace(/[<>&]/g, ''));
  html = html.replace('{{LOGO_SVG}}', () => readLogo());
  html = html.replace('/*__PAGE_CSS__*/', () => readFileSync(STYLES, 'utf8'));
  html = html.replace('/*__APP_JS__*/', () => readFileSync(APP, 'utf8').replace(/<\/script/gi, '<\\/script'));
  html = html.replace('{{REVIEW_DATA}}', () => JSON.stringify(payload).replace(/</g, '\\u003c'));
  const leftover = [...new Set((html.match(/\{\{[A-Z_]+\}\}/g) || []))].filter((token) => token !== '{{REVIEW_BRIDGE}}');
  if (leftover.length) fail(`模板里还有没替换的占位符：${leftover.join(', ')}`);
  writeFileSync(entryPath, html, 'utf8');
  const tokenReport = inlineTokens(entryPath);

  const id = args.id || `editor/proofread-${createHash('sha1').update(String(sourcePath || title)).digest('hex').slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(`surface id「${id}」不合契约：要 <skill>/<面>，只允许 a-z0-9-`);
  }
  const cleanHint = payload.article.clean
    ? `应用后生成干净版：${relative(reviewDir, payload.article.clean) || payload.article.clean}。`
    : '生成干净版：<原稿名>-校对版.md，放在原稿同目录。';
  const surface = {
    contract_version: CONTRACT_VERSION,
    id,
    title: `校对 · 《${title}》`,
    description: '全文可编辑的修订工作台：点绿＝同意修改、点红＝不改，没点的默认接受；提交以 final_text 为准。',
    project_root: args['project-root'] || '..',
    dir: '.',
    entry: 'index.html',
    feedback: FEEDBACK_REL,
    draft: DRAFT_REL,
    wake: {
      mode: 'steer',
      text: `《${title}》的校对页有新的提交：先读本审阅目录下的 ${FEEDBACK_REL}（contract=editor-decisions/2）。`
        + '**final_text 是用户最终确认的整篇正文，直接以它生成干净版，不要再逐条应用任何 L1/L2 建议。**'
        + 'l3_find 里的条目逐条查证并把结论交回对话；rejected_changes 是用户明确点红保留原文的条目（final_text 已体现）；'
        + 'manual_blocks 是用户直接改过的段落。'
        + `${cleanHint}最后把改动摘要（接受/保留/人工改写）交回对话。`,
    },
    capabilities: ['draft'],
  };
  writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`, 'utf8');
  const validatorLine = validateSurface(surfacePath);

  console.log(JSON.stringify({
    status: 'surface_ready',
    surface: surfacePath,
    entry: entryPath,
    feedback: feedbackPath,
    draft: draftPath,
    review_dir: reviewDir,
    id,
    counts: payload.counts,
    dataVersion: payload.dataVersion,
    tokens: tokenReport.split('\n')[0],
    archived_feedback: archivedFeedback,
    archived_draft: archivedDraft,
    validator: validatorLine,
    next_action_zh: '有 DSH：把 surface 的绝对路径交给 review_open。没有 DSH：'
      + `node "${moduleScript(join('scripts', 'serve-review.mjs'))}" "${surfacePath}"`,
  }, null, 2));
}

try {
  main();
} catch (error) {
  if (error.isBuildError) {
    console.error(`\n✗ ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
