/**
 * MCP 端点（挂在面板 server 的 /mcp）：Streamable HTTP 无状态模式——
 * 每请求新建 McpServer + transport，无会话管理。鉴权先于 SDK 处理（Bearer → 角色），
 * 工具面按角色注册（gateway 连接上 admin 工具不存在）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PanelDeps } from '../panel/server.js';
import { readJsonBody, sendJson } from '../panel/http-util.js';
import { resolveMcpAuth } from './auth.js';
import { registerTools } from './tools.js';

export async function handleMcp(
  deps: PanelDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = resolveMcpAuth(deps.db, req.headers.authorization);
  if (auth === 'unconfigured') {
    sendJson(res, 503, { error: 'MCP 未配置访问令牌，先运行 npm run mcp-token add <名字> <admin|gateway>' });
    return;
  }
  if (!auth) {
    sendJson(res, 401, { error: '未授权：缺失或无效的 Bearer token' });
    return;
  }
  // 无状态模式：GET/DELETE（SSE 长连）由 SDK 回 405，POST 体先解析好交给 transport
  const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
  const server = new McpServer(
    { name: 'dd-claw', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, deps, auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
