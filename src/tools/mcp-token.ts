/**
 * MCP 访问令牌管理（npm run mcp-token）：settings 表 mcp_tokens 的 CLI 管理入口。
 * 用法：
 *   tsx src/tools/mcp-token.ts list                                      列出令牌（name/role/渠道，不显示 token 值）
 *   tsx src/tools/mcp-token.ts add <名字> <admin|gateway> [--channel <id>] 生成新令牌（token 只在此时打印一次）
 *   tsx src/tools/mcp-token.ts remove <名字>                             删除令牌
 * token 只在创建时完整打印，之后 list 只显示前 12 位——本机工具，不做加密存储（同 LLM key 口径）。
 *
 * 渠道绑定（docs/plan/agent-access.md 方案 A）：**一个来源渠道一条 gateway 令牌**；
 * 服务端由 token 解析 `scope.channelId`，调用方声明什么渠道都无效。
 * admin 令牌**不带** channelId（全量无 scope）；gateway 未绑定渠道时写路径会拒绝服务。
 */
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { Db } from '../core/db.js';
import { listMcpTokens, mintToken, saveMcpTokens, type McpRole, type McpTokenEntry } from '../mcp/auth.js';

/** 解析 `--channel <id>` / `--channel=<id>`；返回 error 时调用方应报错退出 */
export function parseChannelFlag(argv: readonly string[]): { value?: number; error?: string } {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--channel') {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) return { error: '--channel 后面要跟渠道 id' };
      break;
    }
    if (a.startsWith('--channel=')) { raw = a.slice('--channel='.length); break; }
  }
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return { error: `渠道 id 必须是正整数: ${raw}` };
  return { value: n };
}

function main(): void {
  const argv = process.argv.slice(2);
  const [cmd, name, role] = argv;
  const channel = parseChannelFlag(argv);
  const { secrets } = loadConfig();
  const db = new Db(secrets.dbPath);
  try {
    const tokens = listMcpTokens(db);
    if (cmd === 'list') {
      if (tokens.length === 0) {
        console.log('（无令牌；add 创建）');
        return;
      }
      for (const t of tokens) {
        const scope = t.channelId === undefined ? '-' : `ch${t.channelId}`;
        console.log(`${t.name}\t${t.role}\t${scope}\t${t.token.slice(0, 12)}…`);
      }
      return;
    }
    if (cmd === 'add') {
      if (!name || (role !== 'admin' && role !== 'gateway')) {
        console.error('用法：npm run mcp-token -- add <名字> <admin|gateway> [--channel <id>]');
        process.exitCode = 1;
        return;
      }
      if (channel.error) {
        console.error(channel.error);
        process.exitCode = 1;
        return;
      }
      if (tokens.some((t) => t.name === name)) {
        console.error(`令牌名重复: ${name}`);
        process.exitCode = 1;
        return;
      }
      if (role === 'admin' && channel.value !== undefined) {
        console.error('admin 令牌不带渠道（本机即主人，全量无 scope）；渠道绑定只用于 gateway');
        process.exitCode = 1;
        return;
      }
      const token = mintToken();
      const entry: McpTokenEntry = { name, role: role as McpRole, token };
      if (channel.value !== undefined) entry.channelId = channel.value;
      saveMcpTokens(db, [...tokens, entry]);
      const scope = channel.value === undefined ? '' : `（绑定渠道 ch${channel.value}）`;
      console.log(`已创建 ${role} 令牌「${name}」${scope}（只显示这一次，请立即复制）：\n${token}`);
      if (role === 'gateway' && channel.value === undefined) {
        console.warn('注意：该 gateway 令牌未绑定渠道，QQ 入口的写路径会因无 scope 拒绝服务（补：add 一个新令牌并带 --channel）');
      }
      return;
    }
    if (cmd === 'remove') {
      if (!name) {
        console.error('用法：npm run mcp-token -- remove <名字>');
        process.exitCode = 1;
        return;
      }
      if (!tokens.some((t) => t.name === name)) {
        console.error(`令牌不存在: ${name}`);
        process.exitCode = 1;
        return;
      }
      saveMcpTokens(db, tokens.filter((t) => t.name !== name));
      console.log(`已删除令牌「${name}」`);
      return;
    }
    console.error('用法：npm run mcp-token -- [list | add <名字> <admin|gateway> [--channel <id>] | remove <名字>]');
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// 入口守卫：仅作为 CLI 直接运行时执行（测试 import 不触发）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
