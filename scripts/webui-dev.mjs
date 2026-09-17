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
const XAVATARS = resolve(ROOT, '..', 'data', 'cache', 'x-avatars');
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
  // demo 专用的 /api/x-avatar：生产由后端从 cache/x-avatars 读，dev 静态服映射同一目录
  if (pathname === '/api/x-avatar') {
    const name = (url.searchParams.get('file') ?? '').replace(/[^a-z0-9.]/gi, '');
    const file = resolve(XAVATARS, name);
    if (!file.startsWith(XAVATARS + sep) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    res.end(readFileSync(file));
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  // 路径安全：`./` + 请求路径 再 resolve 到 ROOT 下，防 ../ 穿越
  let file = resolve(ROOT, '.' + pathname);
  const inside = file === ROOT || file.startsWith(ROOT + sep);
  // 目录 → 其 index.html；无尾斜杠先 302 补斜杠（页面内相对路径才能正确解析）
  if (inside && existsSync(file) && statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(302, { location: pathname + '/' + url.search });
      res.end();
      return;
    }
    pathname += 'index.html';
    file = resolve(ROOT, '.' + pathname);
  }
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
