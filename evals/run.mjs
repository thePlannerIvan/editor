#!/usr/bin/env node
/**
 * editor 审阅面的回归网（真跑，不链桩）。
 *
 * 验的是四条最容易悄悄坏掉的链：
 *   ① 生成器：锚点定位 / diff / runs / 重叠闸门 / 页面数据；
 *   ② 页面资产：裸注入点、DSH 令牌内联、LOGO、可编辑正文；
 *   ③ surface：官方校验器 0 错；缺注入点必须报 bridge_placeholder；
 *   ④ 无插件宿主：页面、draft、feedback、wake、路径穿越。
 *
 * 用法：node evals/run.mjs [--keep]     （--keep 保留临时目录）
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { moduleScript } from '../scripts/lib/review-core.mjs';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? `\n    → ${detail}` : ''}`);
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `期望 ${e}，实际 ${a}`);
}
function run(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}
function httpJson(method, url, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', rejectPromise);
    if (payload) req.write(payload);
    req.end();
  });
}
function httpText(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'GET', timeout: 5000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolvePromise(httpText(new URL(res.headers.location, url).href));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', rejectPromise);
    req.end();
  });
}
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等超时：${label}`);
}
function pageDataFrom(html) {
  const match = html.match(/var DATA = (\{[\s\S]*?\});\n<\/script>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (error) { return null; }
}
function runsOf(data, id) {
  const out = [];
  for (const block of data.blocks || []) {
    for (const run of block.runs || []) {
      if (run.d === id || run.i === id || (Array.isArray(run.x) && run.x.includes(id))) out.push(run);
    }
  }
  return out;
}

const ARTICLE = `# 测试文章

这是一件很重要的事情，能够平静的表达，能够不被打扰。

但发出去朋友说投放成本很低。

生活就是东边不亮西边亮的。

时间开始变得粘稠。后来还是很粘稠。

记住，人是所有社会关系的总和。
`;

const FIXTURE = {
  article: {},
  l1: [
    { id: 'l1-1', type: '的地得 · L2', before: '能够平静的表达', after: '能够平静地表达', default: 'accept' },
    { id: 'l1-2', type: '标点 · L4', before: '但发出去朋友说', after: '但发出去，朋友说', default: 'accept' },
    { id: 'l1-3', type: '规范用字 · L6', before: '粘稠', after: '黏稠', default: 'reject', all: true, note: '两处。' },
    { id: 'l1-4', type: '俗语变体 · L6', before: '生活就是东边不亮西边亮的', after: '生活就是东方不亮西方亮的', default: 'reject' },
  ],
  l2: [
    { id: 'l2-1', severity: 'medium', tag: '强调不足 · L2', note: '加「非常」。', before: '这是一件很重要的事情', after: '这是一件非常重要的事情' },
  ],
  l3: [
    { id: 'l3-1', level: '高', tag: '名言 · L8', context: '人是所有社会关系的总和', reason: '通行译法有「人的本质」。', direction: '核对中译本。' },
  ],
};

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), 'editor-eval-'));
  const articlePath = join(workspace, 'article.md');
  const dataPath = join(workspace, 'review-data.json');
  const reviewDir = join(workspace, 'review');
  writeFileSync(articlePath, ARTICLE, 'utf8');
  const fixture = { ...FIXTURE, article: { title: '夹具文章', source: articlePath, clean: join(workspace, 'article-校对版.md') } };
  writeFileSync(dataPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  const buildArgs = [join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', dataPath, '--review-dir', reviewDir];
  const build = run(buildArgs);
  check('build 退出码 0', build.status === 0, (build.stderr || build.stdout || '').trim());
  let built = null;
  if (build.status === 0) {
    try { built = JSON.parse(build.stdout); } catch (error) { built = null; }
  }
  check('build 输出是 JSON 且 status=surface_ready', built && built.status === 'surface_ready', build.stdout?.slice(0, 300));
  if (!built) {
    console.log('\n无法继续：先修生成器。');
    report();
    return;
  }
  equal('counts 与夹具一致', built.counts, { l1: 4, l2: 1, l3: 1 });
  check('三个产物都在（页面 / surface / draft 路径）',
    existsSync(built.entry) && existsSync(built.surface) && built.draft.endsWith('review-draft.json'),
    `entry=${existsSync(built.entry)} surface=${existsSync(built.surface)} draft=${built.draft}`);
  check('官方校验器通过', /^(OK|合规)/.test(built.validator || ''), built.validator);
  check('surface id 形状是 editor/proofread-<hash8>', /^editor\/proofread-[0-9a-f]{8}$/.test(built.id), built.id);
  check('surface 声明 draft 能力并写 draft 路径',
    built.surface && JSON.parse(readFileSync(built.surface, 'utf8')).capabilities.includes('draft')
      && JSON.parse(readFileSync(built.surface, 'utf8')).draft === 'review-draft.json');

  const entryHtml = readFileSync(built.entry, 'utf8');
  const bridgeHits = (entryHtml.match(/\{\{REVIEW_BRIDGE\}\}/g) || []).length;
  const bareLines = (entryHtml.match(/^\s*\{\{REVIEW_BRIDGE\}\}\s*$/gm) || []).length;
  check('页面里裸注入点恰好一处且独占一行', bridgeHits === 1 && bareLines === 1, `出现 ${bridgeHits} 次，独占行 ${bareLines} 处`);
  check('DSH 令牌已内联（BEGIN + 别名变量）',
    entryHtml.includes('DSH_TOKENS_BEGIN') && entryHtml.includes('--dsw-alias-bg-base:'));
  check('页面带 LOGO、水印、可编辑正文',
    entryHtml.includes('class="brand-mark"') && entryHtml.includes('<svg')
      && entryHtml.includes('阿祖不看 TVC · demyth.info')
      && entryHtml.includes('contenteditable="true"'));
  check('页面文案是「点绿同意 / 点红不改 / 默认接受」',
    entryHtml.includes('点绿＝同意修改') && entryHtml.includes('点红＝不改') && entryHtml.includes('没点的默认接受'));
  check('页面没有其他没替换的占位符', !/\{\{(?!REVIEW_BRIDGE)[A-Z_]+\}\}/.test(entryHtml));

  const data = pageDataFrom(entryHtml);
  check('页面内联数据可 JSON.parse', data !== null);
  if (data) {
    equal('页面数据的件数与夹具一致', [data.counts.l1, data.counts.l2, data.counts.l3], [4, 1, 1]);
    check('页面数据有 blocks / items / order / dataVersion',
      Array.isArray(data.blocks) && data.items && data.items['l1-1'] && Array.isArray(data.order) && typeof data.dataVersion === 'string');
    const r11 = runsOf(data, 'l1-1');
    check('L1 的「的→地」被拆成删除 + 新增',
      r11.some((run) => run.d === 'l1-1') && r11.some((run) => run.i === 'l1-1' && run.t === '地'),
      JSON.stringify(r11));
    const r12 = runsOf(data, 'l1-2');
    check('纯插入（逗号）只有新增、没有删除',
      r12.some((run) => run.i === 'l1-2' && run.t === '，') && !r12.some((run) => run.d === 'l1-2'),
      JSON.stringify(r12));
    const r13 = runsOf(data, 'l1-3');
    check('all:true 的两处「粘稠」都进了页面',
      data.items['l1-3'].occurrences === 2
        && r13.filter((run) => run.i === 'l1-3').length === 2,
      JSON.stringify(r13));
    const r21 = runsOf(data, 'l2-1');
    check('L2 整句建议有红/绿一对', r21.some((run) => run.d === 'l2-1') && r21.some((run) => run.i === 'l2-1'),
      JSON.stringify(r21));
    const r31 = runsOf(data, 'l3-1');
    check('L3 的事实存疑进入 x 标记', r31.some((run) => (run.x || []).includes('l3-1')), JSON.stringify(r31));
    check('L1/L2/L3 的 order 都在', data.order.length === 6 && data.order.includes('l3-1'));
  }

  const surface = JSON.parse(readFileSync(built.surface, 'utf8'));
  equal('surface 必填字段', Object.keys(surface).sort(),
    ['capabilities', 'contract_version', 'description', 'dir', 'draft', 'entry', 'feedback', 'id', 'project_root', 'title', 'wake']);
  equal('surface 只声明 draft 能力', surface.capabilities, ['draft']);
  equal('wake 用 steer', surface.wake.mode, 'steer');
  check('wake 文案点名 final_text 与 feedback', surface.wake.text.includes('final_text') && surface.wake.text.includes('review-feedback.json'));

  // ---------- 反面对照：缺注入点 ----------
  const brokenDir = join(workspace, 'broken');
  cpSync(reviewDir, brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'index.html'), entryHtml.replace('{{REVIEW_BRIDGE}}', ''), 'utf8');
  const brokenCheck = run([moduleScript(join('scripts', 'validate-surface.mjs')), join(brokenDir, 'review-surface.json'), '--text']);
  check('反面对照：缺注入点必须报 bridge_placeholder',
    brokenCheck.status !== 0 && `${brokenCheck.stdout}${brokenCheck.stderr}`.includes('bridge_placeholder'),
    `status=${brokenCheck.status}`);

  // ---------- 生成器输入闸门 ----------
  const notFound = { ...fixture, l1: [{ id: 'l1-x', type: 'x', before: '原文里没有这句', after: '改成这样' }] };
  writeFileSync(join(workspace, 'not-found.json'), JSON.stringify(notFound), 'utf8');
  const notFoundBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'not-found.json'), '--review-dir', join(workspace, 'not-found')]);
  check('锚点找不到 → 生成器拒绝', notFoundBuild.status !== 0 && /锚点没找到/.test(`${notFoundBuild.stdout}${notFoundBuild.stderr}`));

  const ambiguous = {
    ...fixture,
    l1: [{ id: 'l1-a', type: 'x', before: '粘稠', after: '黏稠' }],
  };
  writeFileSync(join(workspace, 'ambiguous.json'), JSON.stringify(ambiguous), 'utf8');
  const ambiguousBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'ambiguous.json'), '--review-dir', join(workspace, 'ambiguous')]);
  check('锚点多义且没有 all/nth → 生成器拒绝',
    ambiguousBuild.status !== 0 && /出现 2 次/.test(`${ambiguousBuild.stdout}${ambiguousBuild.stderr}`));

  const nth = {
    ...fixture,
    l1: [{ id: 'l1-a', type: 'x', before: '粘稠', after: '黏稠', nth: 1 }],
  };
  writeFileSync(join(workspace, 'nth.json'), JSON.stringify(nth), 'utf8');
  const nthDir = join(workspace, 'nth');
  const nthBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'nth.json'), '--review-dir', nthDir]);
  let nthData = null;
  if (nthBuild.status === 0) nthData = pageDataFrom(readFileSync(join(nthDir, 'index.html'), 'utf8'));
  check('nth 只取指定一处', nthBuild.status === 0 && nthData && nthData.items['l1-a'].occurrences === 1,
    nthBuild.stderr || nthBuild.stdout);

  const overlap = {
    ...fixture,
    l1: [
      { id: 'l1-a', type: 'x', before: '能够平静的表达', after: '能够平静地表达' },
      { id: 'l1-b', type: 'x', before: '平静的表达', after: '平静地表达' },
    ],
  };
  writeFileSync(join(workspace, 'overlap.json'), JSON.stringify(overlap), 'utf8');
  const overlapBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'overlap.json'), '--review-dir', join(workspace, 'overlap')]);
  check('L1/L2 修订范围重叠 → 生成器拒绝',
    overlapBuild.status !== 0 && /重叠/.test(`${overlapBuild.stdout}${overlapBuild.stderr}`));

  const missingSource = { ...fixture, article: { ...fixture.article, source: join(workspace, 'missing.md') } };
  writeFileSync(join(workspace, 'missing-source.json'), JSON.stringify(missingSource), 'utf8');
  const missingBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'missing-source.json'), '--review-dir', join(workspace, 'missing')]);
  check('article.source 不存在 → 生成器拒绝', missingBuild.status !== 0 && /不存在/.test(`${missingBuild.stdout}${missingBuild.stderr}`));

  const badSeverity = { ...fixture, l2: [{ ...fixture.l2[0], severity: 'critical' }] };
  writeFileSync(join(workspace, 'bad-severity.json'), JSON.stringify(badSeverity), 'utf8');
  const badBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'bad-severity.json'), '--review-dir', join(workspace, 'bad')]);
  check('非法 severity 被生成器拒绝', badBuild.status !== 0 && /severity/.test(`${badBuild.stdout}${badBuild.stderr}`));

  const duplicate = { ...fixture, l1: [FIXTURE.l1[0], { ...FIXTURE.l1[1], id: 'l1-1' }] };
  writeFileSync(join(workspace, 'duplicate.json'), JSON.stringify(duplicate), 'utf8');
  const dupBuild = run([join(SKILL_DIR, 'scripts', 'build-review-page.mjs'), '--data', join(workspace, 'duplicate.json'), '--review-dir', join(workspace, 'duplicate')]);
  check('重复 id 被生成器拒绝', dupBuild.status !== 0 && /重复/.test(`${dupBuild.stdout}${dupBuild.stderr}`));

  // ---------- 无插件宿主 ----------
  const host = spawn(process.execPath, [moduleScript(join('scripts', 'serve-review.mjs')), built.surface, '--port', '0', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hostOut = '';
  host.stdout.on('data', (chunk) => { hostOut += chunk.toString('utf8'); });
  host.stderr.on('data', (chunk) => { hostOut += chunk.toString('utf8'); });
  try {
    const url = await waitFor(() => (hostOut.match(/http:\/\/127\.0\.0\.1:\d+\/[^"\s]*/) || [])[0], 15000, '宿主启动');
    const base = url.slice(0, url.indexOf('/index.html')) || url.replace(/\/$/, '');
    const page = await httpText(url);
    check('宿主 serve 页面 200', page.status === 200, `status=${page.status}`);
    check('宿主把桥注入进去了（页面里已无裸标记）',
      page.text.includes('__review/bridge.js') && !page.text.includes('{{REVIEW_BRIDGE}}'));
    check('注入的页面仍带 DSH 令牌和 LOGO', page.text.includes('--dsw-alias-bg-base:') && page.text.includes('class="brand-mark"'));

    const caps = await httpJson('GET', `${base}/__review/capabilities`);
    check('宿主报告 draft 能力', JSON.parse(caps.text).capabilities.includes('draft'));

    const draft = { dataVersion: 'fixture', html: '<p>草稿</p>', manualBlocks: [], resolutions: {}, saved_at: '2026-10-31T00:00:00.000Z' };
    const wroteDraft = await httpJson('POST', `${base}/__review/draft`, draft);
    check('POST draft 返回 ok', wroteDraft.status === 200 && JSON.parse(wroteDraft.text).ok === true, wroteDraft.text.slice(0, 200));
    const draftOnDisk = await waitFor(() => existsSync(built.draft) && JSON.parse(readFileSync(built.draft, 'utf8')), 3000, 'draft 落盘');
    equal('draft 落盘与提交同义', draftOnDisk, draft);

    const decision = {
      contract: 'editor-decisions/2',
      article: fixture.article,
      submitted_at: '2026-10-31T00:00:00.000Z',
      page: { host: 'dsh', pre_check: false },
      final_text: '最终正文',
      l3_find: ['l3-1'],
      default_accepted: true,
      accepted_changes: ['l1-1'],
      rejected_changes: [],
      manual_blocks: [],
      stats: { total_changes: 6, accepted: 6, rejected: 0, l3_checked: 1, manual_blocks: 0 },
    };
    const wrote = await httpJson('POST', `${base}/__review/write`, decision);
    check('POST write 返回 ok', wrote.status === 200 && JSON.parse(wrote.text).ok === true);
    const onDisk = await waitFor(() => existsSync(built.feedback) && readFileSync(built.feedback, 'utf8'), 3000, 'feedback 落盘');
    equal('落盘的决定与提交逐字节同义', JSON.parse(onDisk), decision);

    const woke = await httpJson('POST', `${base}/__review/wake`, { unit: 'decisions' });
    check('POST wake 被受理（本地宿主无 agent，woke=false 是正确值）',
      woke.status === 200 && JSON.parse(woke.text).ok === true && JSON.parse(woke.text).woke === false);

    const traversal = await httpText(`${base}/../etc/passwd`);
    check('路径穿越被挡（不返回 200）', traversal.status !== 200, `status=${traversal.status}`);
  } catch (error) {
    check('无插件宿主整条链', false, error.message);
  } finally {
    try {
      const url = (hostOut.match(/http:\/\/127\.0\.0\.1:\d+/) || [])[0];
      if (url) await httpJson('POST', `${url}/__review/shutdown`).catch(() => {});
    } catch { /* 已经退了 */ }
    host.kill('SIGTERM');
  }

  if (!KEEP) rmSync(workspace, { recursive: true, force: true });
  else console.log(`\n临时目录保留在：${workspace}`);
  report();
}

function report() {
  const total = results.length;
  console.log(`\n${failures === 0 ? '✓ 全绿' : '✗ 有红'}：${total - failures}/${total} 条通过`);
  if (failures) {
    console.log('\n失败项：');
    results.filter((item) => !item.ok).forEach((item) => console.log(`  · ${item.name}${item.detail ? `\n    ${item.detail}` : ''}`));
  }
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
