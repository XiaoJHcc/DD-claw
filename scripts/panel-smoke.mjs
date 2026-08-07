// 面板冒烟脚本（一次性）：起服务 → 抓页面 → 校验锚点与内嵌脚本语法
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Db } from '../dist/core/db.js';
import { createPanelServer } from '../dist/panel/server.js';

const db = new Db(':memory:');
const server = createPanelServer({
  db,
  status: () => ({
    uptimeSec: 1, notifiers: [], watchedCount: 0, liveCount: 0,
    platforms: [{ key: 'bili', name: 'B站', state: 'none', mid: null }],
  }),
});
await new Promise((resolve) => server.listen(8899, '127.0.0.1', resolve));
const res = await fetch('http://127.0.0.1:8899/');
const html = await res.text();
server.close();

let fail = 0;
if (res.status !== 200) { console.log('FAIL status', res.status); fail = 1; }
for (const c of ['card-listen', 'card-llm', 'card-push', 'card-streamers', 'card-follows',
  'sheet-mask1', 'sheet-mask2', 'toasts', 'prefers-color-scheme: dark', 'makeSortable',
  'LOGIN_PLATFORMS', 'toast-capsule', 'live-badge', '暂无动态', '命中即推']) {
  if (!html.includes(c)) { console.log('MISSING:', c); fail = 1; }
}
// 内嵌 script 段：不得有反引号与 ${，且语法可解析
const scripts = html.split('<script>').slice(1).map((s) => s.split('</' + 'script>')[0]);
const dir = mkdtempSync(join(tmpdir(), 'panel-smoke-'));
scripts.forEach((s, i) => {
  if (s.includes('`')) { console.log('BACKTICK in script', i); fail = 1; }
  if (s.includes('$' + '{')) { console.log('DOLLAR-BRACE in script', i); fail = 1; }
  const f = join(dir, 's' + i + '.js');
  writeFileSync(f, s);
  try { execFileSync(process.execPath, ['--check', f]); }
  catch { console.log('SYNTAX FAIL script', i); fail = 1; }
});
console.log(fail ? 'SMOKE FAILED' : 'SMOKE OK (' + scripts.length + ' scripts, ' + html.length + ' bytes)');
process.exit(fail);
