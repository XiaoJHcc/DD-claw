import { normalizeProviderBaseURL } from '../config/index.js';

/**
 * provider 端点拼装：`<baseURL 的版本根><端点路径>`（LLM 与决策模型共用）。
 *
 * 用户填的 Base URL 不要求规范，以下写法都得到同一个端点：
 * - 末尾带不带 `/`（`https://api.deepseek.com` / `https://api.deepseek.com/`）；
 * - 带不带版本段（`/v1`、`/v3`、`/v1beta1`）：带了就沿用，没带才补协议默认版本；
 * - 误贴整条端点（含本协议的 `/chat/completions` 等）时先剥回版本根，不重复拼路径。
 *
 * 版本号按协议给默认值（现在三种协议都是 `v1`），将来接非 v1 默认版本的协议只改这张表。
 */
export type EndpointProtocol = 'chat-completions' | 'responses' | 'systemone';

interface EndpointShape {
  /** baseURL 末尾没写版本段时补的默认版本 */
  version: string;
  /** 版本根之下的端点路径，以 / 开头 */
  path: string;
}

const ENDPOINT_SHAPES: Record<EndpointProtocol, EndpointShape> = {
  'chat-completions': { version: 'v1', path: '/chat/completions' },
  responses: { version: 'v1', path: '/responses' },
  systemone: { version: 'v1', path: '/systemone' },
};

/** 版本段：v1 / v3 / v1beta1 这类；大小写不敏感（命中后按用户所写沿用） */
const VERSION_SEGMENT = /^v\d+(?:alpha|beta)?\d*$/i;

/** 由 Base URL 与协议拼出实际请求地址 */
export function endpointUrl(baseURL: string, protocol: EndpointProtocol): string {
  const shape = ENDPOINT_SHAPES[protocol];
  let base = normalizeProviderBaseURL(baseURL);
  // 整条端点被贴进 Base URL：剥掉端点路径，回到版本根再统一拼
  if (base.toLowerCase().endsWith(shape.path)) {
    base = base.slice(0, -shape.path.length).replace(/\/+$/, '');
  }
  const lastSegment = base.slice(base.lastIndexOf('/') + 1);
  const version = VERSION_SEGMENT.test(lastSegment) ? '' : `/${shape.version}`;
  return `${base}${version}${shape.path}`;
}
