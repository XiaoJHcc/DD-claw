/**
 * 经 HTTP 代理的 CONNECT 隧道请求（X / 推特是唯一使用者，但它本身与 X 无关）。
 *
 * 为什么不用原生 fetch：Node 22 的 fetch **不读** HTTPS_PROXY（`NODE_USE_ENV_PROXY`
 * 是 Node 24+ 才有），项目也未装 undici；`curl.exe -x` 在同一环境下同样打不通。
 * 所以境外目标只能自己开隧道：net 连代理 → `CONNECT host:443` → 在隧道上 tls.connect。
 *
 * 两条纪律（踩过的坑，见 docs/boundaries.md §5.28）：
 * ① 请求一律带 `Connection: close`——HTTP/1.1 默认 keep-alive 会让读取端永不 end，
 *    表现为「假超时」，而不是报错；
 * ② 一律带 `Accept-Encoding: identity`——自己解 gzip/br 是白搭的复杂度。
 *
 * 只支持 `http://` 代理（CONNECT 语义）。SOCKS 不支持：Node 无内置实现，
 * 且 Nitter 自建侧的 proxy 配置同样只认 http/https。
 */
import net from 'node:net';
import tls from 'node:tls';
import { splitCsvText } from './csv.js';

export interface ProxyEndpoint {
  host: string;
  port: number;
}

export type TunnelErrorKind =
  | 'bad-proxy-url'
  | 'bad-url'
  | 'proxy-unreachable'
  | 'proxy-refused'
  | 'tls'
  | 'timeout'
  | 'truncated';

/** 错误发生在隧道哪一段：connect=连代理/建隧道（代理责任）；established=隧道内 TLS/读写（目标责任） */
export type TunnelErrorStage = 'connect' | 'established';

export class TunnelError extends Error {
  constructor(
    public readonly kind: TunnelErrorKind,
    message: string,
    public readonly stage: TunnelErrorStage = 'established',
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

/**
 * `http://127.0.0.1:7890` / `127.0.0.1:7890`（尾斜杠可有可无）→ `{host, port}`。
 * 空串 / null（未配置）→ null。形状不对或非 http 协议抛 TunnelError('bad-proxy-url')。
 */
export function parseProxyUrl(raw: string | null | undefined): ProxyEndpoint | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new TunnelError('bad-proxy-url', `代理地址无法解析: ${raw}`);
  }
  if (u.protocol !== 'http:') {
    throw new TunnelError('bad-proxy-url', `代理只支持 http://（CONNECT），收到 ${u.protocol}//`);
  }
  const port = u.port ? Number(u.port) : 80;
  if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TunnelError('bad-proxy-url', `代理地址缺少主机或端口非法: ${raw}`);
  }
  return { host: u.hostname, port };
}

/** 实例列表文本（中英文逗号/空白分隔）→ 去空、去重、去协议前缀的 host 数组 */
export function parseInstanceList(raw: string | null | undefined): string[] {
  const out: string[] = [];
  // 逗号口径统一走 splitCsvText；实例还额外允许空白分隔
  for (const chunk of splitCsvText(raw)) {
    for (const part of chunk.split(/\s+/)) {
      const s = part.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

export interface TunnelRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** 单次请求总时限（含建隧道与 TLS 握手），到点即销毁连接 */
  timeoutMs?: number;
  /** 响应体上限，超出即断开（默认 32MB，足够 X 页面与 Nitter RSS） */
  maxBytes?: number;
}

export interface TunnelResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** POST/GET 之外用不到；解析 chunked 传输（`Accept-Encoding: identity` 下仍可能遇到） */
export function decodeChunked(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  let p = 0;
  while (p < buf.length) {
    const nl = buf.indexOf('\r\n', p);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(p, nl).toString('latin1'), 16);
    if (!Number.isInteger(size) || size <= 0) break;
    parts.push(buf.subarray(nl + 2, nl + 2 + size));
    p = nl + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function connectTunnel(
  proxy: ProxyEndpoint,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    let head = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(new TunnelError('timeout', `连代理超时（${proxy.host}:${proxy.port}）`, 'connect')));
    sock.on('error', (e: NodeJS.ErrnoException) => {
      const kind: TunnelErrorKind = e.code === 'ECONNREFUSED' ? 'proxy-refused' : 'proxy-unreachable';
      fail(new TunnelError(kind, `代理不可达（${proxy.host}:${proxy.port}）：${e.code ?? e.message}`, 'connect'));
    });
    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    sock.on('data', function onData(d: Buffer) {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      const line = head.split('\r\n')[0] ?? '';
      if (!/ 200/.test(line)) {
        fail(new TunnelError('proxy-refused', `代理拒绝 CONNECT：${line}`, 'connect'));
        return;
      }
      settled = true;
      resolve(sock);
    });
  });
}

function openTarget(sock: net.Socket, host: string, port: number, secure: boolean, timeoutMs: number): Promise<net.Socket> {
  if (!secure) return Promise.resolve(sock);
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: host }, () => resolve(t));
    t.setTimeout(timeoutMs, () => {
      t.destroy();
      reject(new TunnelError('timeout', `TLS 握手超时（${host}）`));
    });
    t.on('error', (e: Error) => reject(new TunnelError('tls', `TLS 失败（${host}）：${e.message}`)));
  });
}

/**
 * 经代理请求一个 URL（https 走隧道内的 TLS，http 走明文）。
 * 非 2xx 不抛错——返回响应交调用方判断（风控码 403/451/429 都是有效情报）。
 */
export async function tunnelFetch(
  url: string,
  proxy: ProxyEndpoint,
  req: TunnelRequest = {},
): Promise<TunnelResponse> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TunnelError('bad-url', `URL 无法解析: ${url}`);
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const secure = u.protocol === 'https:';
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const body = req.body;

  let sock = await connectTunnel(proxy, u.hostname, port, timeoutMs);
  let stream: net.Socket = sock;
  const cleanup = () => {
    try {
      stream.destroy();
    } catch {
      /* 已关 */
    }
    if (stream !== sock) {
      try {
        sock.destroy();
      } catch {
        /* 已关 */
      }
    }
  };
  try {
    stream = await openTarget(sock, u.hostname, port, secure, timeoutMs);
    const headers: Record<string, string> = {
      Host: u.host,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'close',
      ...req.headers,
    };
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const head =
      `${req.method ?? 'GET'} ${u.pathname}${u.search} HTTP/1.1\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n';
    stream.write(head);
    if (body !== undefined) stream.write(body);

    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const done = (err: Error | null, out?: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(out!);
      };
      stream.setTimeout(timeoutMs, () => done(new TunnelError('timeout', `读取超时（${u.host}，已收 ${total}B）`)));
      stream.on('data', (d: Buffer) => {
        chunks.push(d);
        total += d.length;
        if (total > maxBytes) done(new TunnelError('truncated', `响应超过 ${maxBytes}B 上限（${u.host}）`));
      });
      stream.on('end', () => done(null, Buffer.concat(chunks)));
      stream.on('error', (e: Error) => done(new TunnelError('truncated', `连接中断（${u.host}）：${e.message}`)));
    });

    const sep = buf.indexOf('\r\n\r\n');
    const headText = buf.subarray(0, sep < 0 ? buf.length : sep).toString('latin1');
    let payload = sep < 0 ? Buffer.alloc(0) : buf.subarray(sep + 4);
    const lines = headText.split('\r\n');
    const statusLine = lines[0] ?? '';
    const status = Number(statusLine.split(' ')[1] ?? 0);
    const outHeaders: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) outHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    if ((outHeaders['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      payload = decodeChunked(payload);
    }
    return {
      status,
      statusText: statusLine.split(' ').slice(2).join(' '),
      headers: outHeaders,
      body: payload,
      text: payload.toString('utf8'),
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** 把底层错误折算成给面板/CLI 用的一句话（区分「填错了」与「链路断了」） */
export function describeTunnelError(e: unknown): string {
  if (e instanceof TunnelError) {
    switch (e.kind) {
      case 'bad-proxy-url':
      case 'bad-url':
        return `配置有误：${e.message}`;
      case 'proxy-refused':
      case 'proxy-unreachable':
        return `代理不可用：${e.message}`;
      case 'timeout':
        return `超时：${e.message}`;
      case 'tls':
        return `TLS 失败（多为被墙或代理未生效）：${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}