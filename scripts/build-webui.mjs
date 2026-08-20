/**
 * 构建期内嵌：把 webui/ 下全部静态资产（含 demo/）读成一张内存映射，
 * 生成 src/panel/webui-assets.gen.ts（勿手改）。运行时 server 只服这份内存快照，
 * 绝不读磁盘——发布工件与同 commit 的后端天然同版本。
 * 另把 webui/demo/defaults.json（LLM provider / 分类 / 推送规则的手工默认值，
 * demo mock 与首启种入共用）生成 src/core/onboarding-defaults.gen.ts（勿手改）。
 *
 * 纯 node fs，零依赖。每次 build/dev/test 开始前由 npm 钩子（prebuild/predev/pretest/
 * pretypecheck）执行，保证资产永远先于编译现生成。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const WEBUI_DIR = join(ROOT, 'webui');
const OUT = join(ROOT, 'src', 'panel', 'webui-assets.gen.ts');
const DEFAULTS_IN = join(WEBUI_DIR, 'demo', 'defaults.json');
const DEFAULTS_OUT = join(ROOT, 'src', 'core', 'onboarding-defaults.gen.ts');

/** 扩展名 → content-type（带 charset，UTF-8 文本资产） */
function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/** 递归收集目录下所有文件（相对 dir 的路径，分隔符归一化为 /） */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs, join(prefix, name)));
    } else {
      out.push(join(prefix, name));
    }
  }
  return out;
}

/** webui 相对路径 → URL 路径（index.html 是站点根；分隔符恒为正斜杠） */
function urlPath(relPath) {
  const norm = relPath.split(sep).join('/');
  return norm === 'index.html' ? '/' : '/' + norm;
}

const files = walk(WEBUI_DIR).sort();
const assets = {};
for (const rel of files) {
  const abs = join(WEBUI_DIR, rel);
  const body = readFileSync(abs, 'utf8');
  assets[urlPath(rel)] = { type: contentType(rel), body };
}

// 键按长度升序（/ 先于其他路径，视觉上更清晰）；正文用 JSON.stringify 转义，
// 绝不进模板字面量（资产正文现在允许反引号与 ${}，不能再拿模板字面量包一层）。
const lines = [
  '// 由 scripts/build-webui.mjs 生成，勿手改（每次 build/dev/test 前自动重生成）',
  'export const WEBUI_ASSETS: Record<string, { type: string; body: string }> = {',
];
for (const key of Object.keys(assets).sort((a, b) => a.length - b.length)) {
  const { type, body } = assets[key];
  lines.push(`  ${JSON.stringify(key)}: { type: ${JSON.stringify(type)}, body: ${JSON.stringify(body)} },`);
}
lines.push('};');
lines.push('');

writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`build-webui: ${files.length} 资产 → src/panel/webui-assets.gen.ts`);

// ---- 首启默认值：webui/demo/defaults.json 是 LLM provider / 分类规则 / 推送规则的
// 唯一手工信源（demo mock 与发布后首启默认值共用），此处生成后端消费的 TS。
// 规则按名引用分类、渠道不落盘，种入时由 core/onboarding.ts 重映射。
const defaults = JSON.parse(readFileSync(DEFAULTS_IN, 'utf8'));
const defaultsLines = [
  '// 由 scripts/build-webui.mjs 从 webui/demo/defaults.json 生成，勿手改',
  '//（改默认值 = 改 defaults.json，每次 build/dev/test 前自动重生成）',
  "import type { LlmProviderConfig } from '../config/index.js';",
  '',
  'export interface OnboardingCategory {',
  '  name: string;',
  '  llmPrompt: string | null;',
  '  keywords: string[];',
  '  areas: string[];',
  "  condMode: 'and' | 'or';",
  '}',
  '',
  'export interface OnboardingRule {',
  '  name: string;',
  '  /** 分类名引用（种入时按名映射回 categories.id）；null = 任意开播 */',
  '  category: string | null;',
  '  messageTemplate: string | null;',
  '}',
  '',
  `export const ONBOARDING_LLM_PROVIDERS: LlmProviderConfig[] = ${JSON.stringify(defaults.llmProviders ?? [], null, 2)};`,
  '',
  `export const ONBOARDING_CATEGORIES: OnboardingCategory[] = ${JSON.stringify(defaults.categories ?? [], null, 2)};`,
  '',
  `export const ONBOARDING_RULES: OnboardingRule[] = ${JSON.stringify(defaults.rules ?? [], null, 2)};`,
  '',
];
writeFileSync(DEFAULTS_OUT, defaultsLines.join('\n'), 'utf8');
console.log(`build-webui: defaults.json → src/core/onboarding-defaults.gen.ts（providers ${(defaults.llmProviders ?? []).length}、categories ${(defaults.categories ?? []).length}、rules ${(defaults.rules ?? []).length}）`);
