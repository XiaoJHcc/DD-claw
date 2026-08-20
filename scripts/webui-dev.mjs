/**
 * 开发用静态服：改 UI 时跑 `npm run webui:dev`，浏览器开带 ?demo=1 的地址即可，
 * 改文件 → 刷新浏览器零重启。只服务 webui/ 目录（真实后端运行时绝不读这里，
 * 页面来源是构建期内嵌进 dist 的内存快照）。
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', 'webui');
const PORT = process.env.WEBUI_PORT ? Number(process.env.WEBUI_PORT) : 8788;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 路径安全：`./` + 请求路径 再 resolve 到 ROOT 下，防 ../ 穿越
  const file = resolve(ROOT, '.' + pathname);
  const inside = file === ROOT || file.startsWith(ROOT + sep);
  if (!inside || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DD-claw WebUI demo → http://127.0.0.1:${PORT}/?demo=1`);
});
