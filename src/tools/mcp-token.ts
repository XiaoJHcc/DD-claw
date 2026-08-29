/**
 * MCP 访问令牌管理（npm run mcp-token）：settings 表 mcp_tokens 的 CLI 管理入口。
 * 用法：
 *   tsx src/tools/mcp-token.ts list                        列出令牌（name/role，不显示 token 值）
 *   tsx src/tools/mcp-token.ts add <名字> <admin|gateway>  生成新令牌（token 只在此时打印一次）
 *   tsx src/tools/mcp-token.ts remove <名字>               删除令牌
 * token 只在创建时完整打印，之后 list 只显示前 12 位——本机工具，不做加密存储（同 LLM key 口径）。
 */
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { Db } from '../core/db.js';
import { listMcpTokens, mintToken, saveMcpTokens, type McpRole } from '../mcp/auth.js';

function main(): void {
  const [, , cmd, name, role] = process.argv;
  const { secrets } = loadConfig();
  const db = new Db(secrets.dbPath);
  try {
    const tokens = listMcpTokens(db);
    if (cmd === 'list') {
      if (tokens.length === 0) {
        console.log('（无令牌；add 创建）');
        return;
      }
      for (const t of tokens) console.log(`${t.name}\t${t.role}\t${t.token.slice(0, 12)}…`);
      return;
    }
    if (cmd === 'add') {
      if (!name || (role !== 'admin' && role !== 'gateway')) {
        console.error('用法：npm run mcp-token -- add <名字> <admin|gateway>');
        process.exitCode = 1;
        return;
      }
      if (tokens.some((t) => t.name === name)) {
        console.error(`令牌名重复: ${name}`);
        process.exitCode = 1;
        return;
      }
      const token = mintToken();
      saveMcpTokens(db, [...tokens, { name, role: role as McpRole, token }]);
      console.log(`已创建 ${role} 令牌「${name}」（只显示这一次，请立即复制）：\n${token}`);
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
    console.error('用法：npm run mcp-token -- [list | add <名字> <admin|gateway> | remove <名字>]');
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// 入口守卫：仅作为 CLI 直接运行时执行（测试 import 不触发）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
