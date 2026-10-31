/**
 * 公共模组 planners-review-core 的解析适配器（每个消费方一份，约 45 行）。
 *
 * 「公共模组单独发布成条目」意味着：发布后它与本 Skill **平铺在同一个 skills 根下**，
 * 所以按名字找兄弟目录即可，不需要任何 runtime 专属路径；开发时它们还在 monorepo 里。
 *
 * 找的顺序：
 *   ① $PLANNERS_MODULES_HOME/<name>
 *   ② 各级祖先目录的兄弟：<skills-root>/<name>            ← 发布后的主路径
 *   ③ monorepo：<repo>/<NN-分类>/<name>
 * 找不到就**出声**（缺依赖时静默跳过是本族最常见的坏失败）。
 *
 * 自检：node scripts/lib/review-core.mjs --check
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <skill>/scripts/lib
export const MODULE_NAME = 'planners-review-core';
const PROBE = join('scripts', 'validate-surface.mjs');

function ancestors(start, maxDepth = 8) {
  const out = [];
  let current = resolve(start);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    out.push(current);
  }
  return out;
}

export function moduleCandidates(name = MODULE_NAME) {
  const out = [];
  if (process.env.PLANNERS_MODULES_HOME) out.push(join(process.env.PLANNERS_MODULES_HOME, name));
  for (const dir of ancestors(HERE)) {
    out.push(join(dir, name)); // 平铺布局（发布后）
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* 读不了就跳过这一级 */ }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d\d-/.test(entry.name)) out.push(join(dir, entry.name, name)); // monorepo
    }
  }
  return [...new Set(out)];
}

export function findModule(name = MODULE_NAME) {
  for (const candidate of moduleCandidates(name)) {
    if (existsSync(join(candidate, PROBE))) return candidate;
  }
  return null;
}

export function requireModule(name = MODULE_NAME) {
  const dir = findModule(name);
  if (dir) return dir;
  throw new Error(
    `找不到公共模组 ${name}。它是审阅面的公共件，需要与本 Skill 平铺在同一个 skills 根下：\n`
    + `  python3 <02-skills-library>/publish_skills.py --target all\n`
    + `候选路径都试过了：\n  ${moduleCandidates(name).join('\n  ')}`
  );
}

export function moduleScript(rel, name = MODULE_NAME) {
  const dir = requireModule(name);
  const target = join(dir, rel);
  if (!existsSync(target)) throw new Error(`${name} 里没有 ${rel}（${dir} 是旧版本？重跑发布）`);
  return target;
}

if (process.argv.includes('--check')) {
  const dir = findModule();
  if (!dir) {
    console.error(requireModule());
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, module: MODULE_NAME, dir }, null, 2));
}
