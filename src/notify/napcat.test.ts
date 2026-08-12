import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readOnebotEndpoint, probeNapCat, NapcatWatchdog, WATCHDOG_DEFAULTS,
  getNapcatConfig, saveNapcatConfig, seedNapcatConfigIfUnset, setupNapcatTask, NAPCAT_TASK_NAME, NAPCAT_STOP_TASK_NAME,
  ensureNapcatEntry, NAPCAT_ENTRY_NAME,
  type NapcatEndpoint, type ProbeResult, type RunResult,
} from './napcat.js';
import { Db } from '../core/db.js';

// ---------- ensureNapcatEntry（dd-claw 专属条目自建自管） ----------

interface OnebotJson { network?: { httpServers?: Array<Record<string, unknown>> } }

function readOnebotJson(dir: string, uin: string): OnebotJson {
  return JSON.parse(readFileSync(join(dir, 'config', `onebot11_${uin}.json`), 'utf8')) as OnebotJson;
}

const probeDown = async (): Promise<ProbeResult> => ({ state: 'down' });
const probeConflict = async (): Promise<ProbeResult> => ({ state: 'conflict' });
const probeOk = async (): Promise<ProbeResult> => ({ state: 'ok', loggedIn: true });

test('ensureNapcatEntry 无条目时创建 dd-claw 条目（高位空闲端口），其他条目原样保留', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const ep = await ensureNapcatEntry(dir, '12345', probeDown);
    assert.ok(ep, '应返回新条目端点');
    const port = Number(new URL(ep!.baseUrl).port);
    assert.ok(port >= 41990 && port < 42040, `端口应在高位冷门段，实际 ${port}`);
    assert.equal(ep!.token, '');

    const j = readOnebotJson(dir, '12345');
    const servers = j.network!.httpServers!;
    assert.equal(servers.length, 2, '原 http 条目保留');
    const dd = servers.find((s) => s['name'] === NAPCAT_ENTRY_NAME)!;
    assert.equal(dd['enable'], true);
    assert.equal(dd['port'], port);

    // 发现逻辑随即读到新条目
    assert.deepEqual(readOnebotEndpoint(dir, '12345'), ep);
  });
});

test('ensureNapcatEntry 条目端口被占（conflict）自动换端口；ok 时不动不写文件', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', {
      network: {
        httpServers: [{ name: 'dd-claw', enable: true, host: '127.0.0.1', port: 3000, token: '' }],
      },
    });
    const ep = await ensureNapcatEntry(dir, '12345', probeConflict);
    const port = Number(new URL(ep!.baseUrl).port);
    assert.ok(port >= 41990, `冲突后应换到高位端口，实际 ${port}`);
    assert.equal(readOnebotJson(dir, '12345').network!.httpServers![0]!['port'], port);

    // NapCat 自己占着（ok）→ 保留端口，且不需要写文件
    writeOnebot(dir, 'onebot11_12345.json', {
      network: {
        httpServers: [{ name: 'dd-claw', enable: true, host: '127.0.0.1', port: 3000, token: '' }],
      },
    });
    const before = readFileSync(join(dir, 'config', 'onebot11_12345.json'), 'utf8');
    const ep2 = await ensureNapcatEntry(dir, '12345', probeOk);
    assert.deepEqual(ep2, { baseUrl: 'http://127.0.0.1:3000', token: '' });
    assert.equal(readFileSync(join(dir, 'config', 'onebot11_12345.json'), 'utf8'), before, 'ok 时不写文件');
  });
});

test('ensureNapcatEntry 被禁用的条目重新启用；onebot11 文件缺失但 config 目录在 → 建骨架；dir 错 → null', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', {
      network: {
        httpServers: [{ name: 'dd-claw', enable: false, host: '127.0.0.1', port: 41990, token: '' }],
      },
    });
    const ep = await ensureNapcatEntry(dir, '12345', probeDown);
    assert.deepEqual(ep, { baseUrl: 'http://127.0.0.1:41990', token: '' });
    assert.equal(readOnebotJson(dir, '12345').network!.httpServers![0]!['enable'], true);

    // 文件缺失但 config 目录存在 → 从骨架创建
    rmSync(join(dir, 'config', 'onebot11_12345.json'));
    const ep2 = await ensureNapcatEntry(dir, '12345', probeDown);
    assert.ok(ep2);
    assert.ok(readOnebotJson(dir, '12345').network!.httpServers!.some((s) => s['name'] === NAPCAT_ENTRY_NAME));

    // dir 填错（config 目录不存在）→ null，不乱建目录
    assert.equal(await ensureNapcatEntry(join(dir, 'nope'), '12345', probeDown), null);
  });
});

// ---------- setupNapcatTask（.cmd 生成 + 失败带日志） ----------

test('setupNapcatTask 生成 wrapper/setup 两个 .cmd，引号只转义一层', async () => {
  await withTmpDirAsync(async (dir) => {
    const calls: string[] = [];
    const okRunner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    };
    await setupNapcatTask('D:/CLI/NapCat.Shell', '2954481774', dir, okRunner);

    const wrapper = readFileSync(join(dir, 'napcat-launch.cmd'), 'utf8');
    assert.match(wrapper, /cd \/d "D:[/\\]CLI[/\\]NapCat\.Shell"\r?\n"launcher\.bat" 2954481774/,
      'wrapper 先 cd 进一键包目录（launcher.bat 用 %cd% 拼 NAPCAT_* 路径）再调 launcher.bat');

    const setup = readFileSync(join(dir, 'napcat-setup.cmd'), 'utf8');
    assert.ok(setup.includes(`/tn "${NAPCAT_TASK_NAME}"`), '任务名带引号');
    assert.ok(setup.includes('/tr "\\"'), '/tr 用 \\" 单层转义，不经 PowerShell 数组拼参');
    assert.ok(setup.includes('/rl highest /it'), '最高权限 + 交互会话');
    assert.ok(setup.includes(`/tn "${NAPCAT_STOP_TASK_NAME}"`), '同一次提权创建停止任务');
    assert.ok(setup.includes('if errorlevel 1'), '第一个任务失败要立即退出，不能被第二个掩盖');

    const stop = readFileSync(join(dir, 'napcat-stop.cmd'), 'utf8');
    assert.match(stop, /taskkill \/F \/IM NapCatWinBootMain\.exe \/T/, '停止脚本杀进程树（含 QQ 子进程）');

    assert.ok(calls.some((c) => c.startsWith('powershell.exe')), '经 powershell 提权');
    assert.ok(calls.some((c) => c.includes('/query')), '创建后校验');
  });
});

test('setupNapcatTask 失败时把 setup 日志尾部带进错误', async () => {
  await withTmpDirAsync(async (dir) => {
    const failRunner = async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: '' });
    // 模拟提权 bat 执行后留下的 schtasks 输出
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'napcat-setup.log'), 'line1\r\n错误: 参数无效。\r\n');
    await assert.rejects(
      () => setupNapcatTask('D:/CLI/NapCat.Shell', '2954481774', dir, failRunner),
      (e: Error) => {
        assert.match(e.message, /exit=1/);
        assert.match(e.message, /参数无效/, '日志尾部要进错误信息');
        return true;
      },
    );
  });
});

// ---------- getNapcatConfig / saveNapcatConfig / seedNapcatConfigIfUnset（settings 唯一信源） ----------

const seedCfg = { enabled: true, dir: 'D:/CLI/NapCat.Shell', uin: '2954481774' };

test('napcat 生效配置：settings 缺省 = 未配置；种子从 config 导入一次', () => {
  const db = new Db(':memory:');
  try {
    assert.deepEqual(getNapcatConfig(db), { enabled: false, dir: '', uin: '' }, '缺省 = 未配置');

    seedNapcatConfigIfUnset(db, seedCfg);
    assert.deepEqual(getNapcatConfig(db), seedCfg, '首次启动从 config 种子导入');

    seedNapcatConfigIfUnset(db, { enabled: false, dir: 'X:/other', uin: '1' });
    assert.deepEqual(getNapcatConfig(db), seedCfg, '已有 settings 后 config 不再生效');
  } finally {
    db.close();
  }
});

test('napcat 生效配置：面板保存即生效；传空串 = 清空字段（无 config 回落）', () => {
  const db = new Db(':memory:');
  try {
    seedNapcatConfigIfUnset(db, seedCfg);
    saveNapcatConfig(db, { enabled: false, dir: 'E:/NC', uin: '111' });
    assert.deepEqual(getNapcatConfig(db), { enabled: false, dir: 'E:/NC', uin: '111' });

    saveNapcatConfig(db, { dir: '', uin: '' });
    const cfg = getNapcatConfig(db);
    assert.equal(cfg.dir, '', '空串 = 清空字段，config 不参与');
    assert.equal(cfg.uin, '');
    assert.equal(cfg.enabled, false, '未传字段保留');

    saveNapcatConfig(db, { enabled: true });
    assert.equal(getNapcatConfig(db).enabled, true);
  } finally {
    db.close();
  }
});

// ---------- readOnebotEndpoint ----------

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claw-napcat-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeOnebot(dir: string, name: string, cfg: unknown): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', name), JSON.stringify(cfg));
}

const enabledCfg = {
  network: {
    httpServers: [
      { name: 'http', enable: true, host: '127.0.0.1', port: 3000, token: 'tk' },
    ],
  },
};

test('readOnebotEndpoint 读取 onebot11_<uin>.json 的第一个启用 HTTP 服务', () => {
  withTmpDir((dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    assert.deepEqual(readOnebotEndpoint(dir, '12345'), { baseUrl: 'http://127.0.0.1:3000', token: 'tk' });
  });
});

test('readOnebotEndpoint 优先 name=dd-claw 的启用条目（不受排序影响）', () => {
  withTmpDir((dir) => {
    writeOnebot(dir, 'onebot11_12345.json', {
      network: {
        httpServers: [
          { name: 'http', enable: true, host: '127.0.0.1', port: 3000, token: 'tk' },
          { name: 'dd-claw', enable: true, host: '127.0.0.1', port: 41990, token: '' },
        ],
      },
    });
    assert.deepEqual(readOnebotEndpoint(dir, '12345'), { baseUrl: 'http://127.0.0.1:41990', token: '' });

    // dd-claw 条目被禁用时回落第一个启用条目
    writeOnebot(dir, 'onebot11_12345.json', {
      network: {
        httpServers: [
          { name: 'http', enable: true, host: '127.0.0.1', port: 3000, token: 'tk' },
          { name: 'dd-claw', enable: false, host: '127.0.0.1', port: 41990, token: '' },
        ],
      },
    });
    assert.deepEqual(readOnebotEndpoint(dir, '12345'), { baseUrl: 'http://127.0.0.1:3000', token: 'tk' });
  });
});

test('readOnebotEndpoint 缺 uin 文件时回落 onebot11.json；host 0.0.0.0 归一化为回环', () => {
  withTmpDir((dir) => {
    writeOnebot(dir, 'onebot11.json', {
      network: { httpServers: [{ enable: true, host: '0.0.0.0', port: 3001, token: '' }] },
    });
    assert.deepEqual(readOnebotEndpoint(dir, '12345'), { baseUrl: 'http://127.0.0.1:3001', token: '' });
  });
});

test('readOnebotEndpoint 无启用 HTTP 服务 / 缺文件 / 坏 JSON 都返回 null', () => {
  withTmpDir((dir) => {
    assert.equal(readOnebotEndpoint(dir, '12345'), null, '目录不存在');

    writeOnebot(dir, 'onebot11_12345.json', {
      network: { httpServers: [{ enable: false, host: '127.0.0.1', port: 3000 }] },
    });
    assert.equal(readOnebotEndpoint(dir, '12345'), null, '无启用项');

    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'onebot11_12345.json'), '{oops');
    assert.equal(readOnebotEndpoint(dir, '12345'), null, '坏 JSON');
  });
});

// ---------- probeNapCat ----------

const ep: NapcatEndpoint = { baseUrl: 'http://127.0.0.1:3000', token: '' };

function fakeFetch(impl: () => Promise<Response>): typeof fetch {
  return (async () => impl()) as typeof fetch;
}

test('probeNapCat ok + 已登录', async () => {
  const r = await probeNapCat(ep, fakeFetch(async () =>
    new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 2954481774 } }))));
  assert.deepEqual(r, { state: 'ok', loggedIn: true });
});

test('probeNapCat ok + 未登录（OneBot 响应但 retcode != 0）', async () => {
  const r = await probeNapCat(ep, fakeFetch(async () =>
    new Response(JSON.stringify({ status: 'failed', retcode: 1404, data: null }))));
  assert.deepEqual(r, { state: 'ok', loggedIn: false });
});

test('probeNapCat 连接失败 = down', async () => {
  const r = await probeNapCat(ep, fakeFetch(async () => {
    throw new TypeError('fetch failed');
  }));
  assert.deepEqual(r, { state: 'down' });
});

test('probeNapCat 超时 / 非 JSON / 非 OneBot JSON = conflict（端口被占用）', async () => {
  const timeout = await probeNapCat(ep, fakeFetch(async () => {
    const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
  }));
  assert.deepEqual(timeout, { state: 'conflict' });

  const html = await probeNapCat(ep, fakeFetch(async () => new Response('<html>dev server</html>')));
  assert.deepEqual(html, { state: 'conflict' });

  const alien = await probeNapCat(ep, fakeFetch(async () => new Response(JSON.stringify({ hello: 1 }))));
  assert.deepEqual(alien, { state: 'conflict' });
});

test('probeNapCat 401/403 无 JSON = NapCat 活着但鉴权不对（ok + 未登录）', async () => {
  const r = await probeNapCat(ep, fakeFetch(async () => new Response('unauthorized', { status: 401 })));
  assert.deepEqual(r, { state: 'ok', loggedIn: false });
});

// ---------- NapcatWatchdog ----------

interface Harness {
  wd: NapcatWatchdog;
  relaunches: number;
  stops: number;
  waits: number;
  alerts: string[];
  endpoints: NapcatEndpoint[];
  ensureCalls: number;
  setProbe: (r: ProbeResult) => void;
  setProbeFn: (f: (ep: NapcatEndpoint) => ProbeResult) => void;
  setEnsure: (ep: NapcatEndpoint | null) => void;
  advance: (ms: number) => void;
}

function harness(dir: string, initial: ProbeResult, ensureResult: NapcatEndpoint | null = null): Harness {
  let probeResult = initial;
  let probeFn: ((ep: NapcatEndpoint) => ProbeResult) | null = null;
  let ensureEp = ensureResult;
  let t = 1_000_000; // 假时钟起点（避开 0 哨兵）
  const h: Harness = {
    relaunches: 0,
    stops: 0,
    waits: 0,
    alerts: [],
    endpoints: [],
    ensureCalls: 0,
    setProbe: (r) => { probeResult = r; probeFn = null; },
    setProbeFn: (f) => { probeFn = f; },
    setEnsure: (ep) => { ensureEp = ep; },
    advance: (ms) => { t += ms; },
    wd: null as unknown as NapcatWatchdog,
  };
  h.wd = new NapcatWatchdog({
    target: () => ({ dir, uin: '12345' }),
    probe: async (ep) => (probeFn ? probeFn(ep) : probeResult),
    ensure: async () => { h.ensureCalls++; return ensureEp; },
    relaunch: async () => { h.relaunches++; return true; },
    stop: async () => { h.stops++; return true; },
    wait: async () => { h.waits++; },
    onEndpoint: (e) => { h.endpoints.push(e); },
    alert: (m) => { h.alerts.push(m); },
    now: () => t,
  });
  return h;
}

test('看门狗：ok 已登录 → 端点注入一次，无拉起无告警', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'ok', loggedIn: true });
    await h.wd.tick();
    assert.equal(h.relaunches, 0);
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(h.endpoints, [{ baseUrl: 'http://127.0.0.1:3000', token: 'tk' }]);
  });
});

test('看门狗：down → 立即拉起；冷却内不重复；冷却后再拉起；3 次放弃告警', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'down' });

    await h.wd.tick();
    assert.equal(h.relaunches, 1, '首次发现 down 立即拉起');

    await h.wd.tick();
    assert.equal(h.relaunches, 1, '冷却内不重复拉起');

    h.advance(WATCHDOG_DEFAULTS.relaunchCooldownMs + 1);
    await h.wd.tick();
    assert.equal(h.relaunches, 2);

    h.advance(WATCHDOG_DEFAULTS.relaunchCooldownMs + 1);
    await h.wd.tick();
    assert.equal(h.relaunches, 3);
    assert.equal(h.alerts.length, 1, '第 3 次拉起后放弃并告警');
    assert.match(h.alerts[0]!, /停止自动拉起/);

    h.advance(WATCHDOG_DEFAULTS.relaunchCooldownMs + 1);
    await h.wd.tick();
    assert.equal(h.relaunches, 3, '放弃后不再拉起');
    assert.equal(h.alerts.length, 1, '放弃告警只发一次');
  });
});

test('看门狗：恢复后复位，下次 down 重新拉起', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'down' });
    await h.wd.tick();
    assert.equal(h.relaunches, 1);

    h.setProbe({ state: 'ok', loggedIn: true });
    await h.wd.tick();

    h.setProbe({ state: 'down' });
    await h.wd.tick();
    assert.equal(h.relaunches, 2, '恢复复位后再次 down 立即拉起');
  });
});

test('看门狗：conflict → 自动换端口（ensure）+ 按 down 流程拉起；修复失败才告警', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const fixed: NapcatEndpoint = { baseUrl: 'http://127.0.0.1:41990', token: '' };
    const h = harness(dir, { state: 'conflict' }, fixed);

    await h.wd.tick();
    assert.equal(h.ensureCalls, 1, '冲突时调 ensure 换端口');
    assert.equal(h.relaunches, 1, '换端口后按 down 流程拉起使新端口生效');
    assert.deepEqual(h.endpoints[1], fixed, '端点热跟随到修复后的新端口');
    assert.equal(h.alerts.length, 0, '自动修复成功不告警');

    await h.wd.tick();
    assert.equal(h.relaunches, 1, '冷却内不重复拉起');
    assert.equal(h.alerts.length, 0);
  });
});

test('看门狗：conflict 且自动修复失败 → 状态迁移时告警一次，不拉起', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'conflict' }, null);
    await h.wd.tick();
    await h.wd.tick();
    assert.equal(h.relaunches, 0);
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0]!, /被其他程序占用/);
  });
});

test('看门狗：ok 但长时间未登录 → 提示扫码（一次）', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'ok', loggedIn: false });
    await h.wd.tick();
    assert.equal(h.alerts.length, 0, '宽限期内不告警');

    h.advance(WATCHDOG_DEFAULTS.notLoggedInGraceMs + 1);
    await h.wd.tick();
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0]!, /未登录/);

    h.advance(WATCHDOG_DEFAULTS.notLoggedInGraceMs + 1);
    await h.wd.tick();
    assert.equal(h.alerts.length, 1, '未登录告警只发一次');
  });
});

test('看门狗：webui 改端口 → 下一轮热跟随新端点', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg);
    const h = harness(dir, { state: 'ok', loggedIn: true });
    await h.wd.tick();
    assert.deepEqual(h.endpoints, [{ baseUrl: 'http://127.0.0.1:3000', token: 'tk' }]);

    writeOnebot(dir, 'onebot11_12345.json', {
      network: { httpServers: [{ enable: true, host: '127.0.0.1', port: 41234, token: 'tk2' }] },
    });
    await h.wd.tick();
    assert.deepEqual(h.endpoints[1], { baseUrl: 'http://127.0.0.1:41234', token: 'tk2' });
  });
});

test('看门狗：找不到 onebot11 配置且 ensure 失败 → 告警一次，不拉起', async () => {
  await withTmpDirAsync(async (dir) => {
    const h = harness(dir, { state: 'down' }, null);
    await h.wd.tick();
    await h.wd.tick();
    assert.equal(h.relaunches, 0);
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0]!, /onebot11/);
  });
});

test('看门狗：缺 dd-claw 条目 → ensure 自建后继续正常流程', async () => {
  await withTmpDirAsync(async (dir) => {
    const created: NapcatEndpoint = { baseUrl: 'http://127.0.0.1:41990', token: '' };
    const h = harness(dir, { state: 'ok', loggedIn: true }, created);
    await h.wd.tick();
    assert.equal(h.ensureCalls, 1, '无端点时调 ensure 自建条目');
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(h.endpoints, [created], '自建端点注入 onEndpoint');
  });
});

test('看门狗：配置变了但旧实例还在旧端口跑（陈旧实例）→ 先停再拉起，不受冷却限制', async () => {
  await withTmpDirAsync(async (dir) => {
    writeOnebot(dir, 'onebot11_12345.json', enabledCfg); // 当前 3000
    const h = harness(dir, { state: 'ok', loggedIn: true });
    await h.wd.tick(); // ok，lastOkEndpoint = 3000

    // 配置改到 41234：新端口 down，旧端口 3000 仍 ok（旧实例没重启）
    writeOnebot(dir, 'onebot11_12345.json', {
      network: { httpServers: [{ name: 'dd-claw', enable: true, host: '127.0.0.1', port: 41234, token: '' }] },
    });
    h.setProbeFn((ep) => ep.baseUrl.includes('41234')
      ? { state: 'down' }
      : { state: 'ok', loggedIn: true });

    await h.wd.tick();
    assert.equal(h.stops, 1, '陈旧实例先停止');
    assert.equal(h.waits, 1, '停止后等待再拉起');
    assert.equal(h.relaunches, 1, '随后拉起让新配置生效（冷却不拦）');
    assert.equal(h.alerts.length, 0);

    // 下一轮：旧实例已停（3000 down），新配置还没起（41234 down）→ 走普通冷却逻辑
    h.setProbe(() => ({ state: 'down' }));
    await h.wd.tick();
    assert.equal(h.stops, 1, '旧实例已停不再重复 stop');
    assert.equal(h.relaunches, 1, '冷却内不重复拉起');
  });
});

/** withTmpDir 的 async 变体 */
async function withTmpDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claw-napcat-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
