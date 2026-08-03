import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeiboResolver, type FetchImpl } from './resolve.js';

/** 最小 Response 替身：resolver 只用 ok/status/text()/headers.get() */
function fakeRes(opts: {
  status?: number;
  body?: string;
  location?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => opts.body ?? '',
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (opts.location ?? null) : null) },
  } as unknown as Response;
}

const GENVISITOR_BODY = 'try{window.gen_callback && gen_callback({"retcode":20000000,"data":{"tid":"tid-1"}});}catch(e){}';
const VISITOR_BODY = 'try{window.cross_domain && cross_domain({"retcode":20000000,"data":{"sub":"SUB1","subp":"SUBP1"}});}catch(e){}';

function jsonpOk(url: string): boolean {
  return url.includes('/visitor/genvisitor') || url.includes('/visitor/visitor');
}

test('完整流程：genvisitor → visitor → /n/<昵称> 302 /u/<uid>', async () => {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/visitor/genvisitor')) return fakeRes({ body: GENVISITOR_BODY });
    if (url.includes('/visitor/visitor')) return fakeRes({ body: VISITOR_BODY });
    if (url.startsWith('https://m.weibo.cn/n/')) {
      assert.ok(url.includes(encodeURIComponent('阿梓从小就很可爱')), '昵称应 URL 编码');
      return fakeRes({ status: 302, location: 'https://m.weibo.cn/u/2203177060?foo=bar' });
    }
    throw new Error(`意外请求: ${url}`);
  };
  const r = createWeiboResolver(fetchImpl);
  assert.equal(await r.resolveUid('阿梓从小就很可爱'), '2203177060');
  assert.equal(urls.filter(jsonpOk).length, 2, '访客 cookie 只取一次');
});

test('昵称不存在（200）→ null', async () => {
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('/visitor/genvisitor')) return fakeRes({ body: GENVISITOR_BODY });
    if (url.includes('/visitor/visitor')) return fakeRes({ body: VISITOR_BODY });
    return fakeRes({ status: 200, body: '<html>404 page</html>' });
  };
  const r = createWeiboResolver(fetchImpl);
  assert.equal(await r.resolveUid('不存在的人'), null);
});

test('跳回 visitor 验证页 = cookie 失效：自动重建并重试一次', async () => {
  let genCount = 0;
  let lookupCount = 0;
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('/visitor/genvisitor')) {
      genCount++;
      return fakeRes({ body: GENVISITOR_BODY.replace('tid-1', `tid-${genCount}`) });
    }
    if (url.includes('/visitor/visitor')) return fakeRes({ body: VISITOR_BODY });
    if (url.startsWith('https://m.weibo.cn/n/')) {
      lookupCount++;
      if (lookupCount === 1) {
        return fakeRes({
          status: 302,
          location: 'https://visitor.passport.weibo.cn/visitor/visitor?a=incarnate',
        });
      }
      return fakeRes({ status: 302, location: 'https://m.weibo.cn/u/2203177060' });
    }
    throw new Error(`意外请求: ${url}`);
  };
  const r = createWeiboResolver(fetchImpl);
  assert.equal(await r.resolveUid('阿梓从小就很可爱'), '2203177060');
  assert.equal(genCount, 2, 'cookie 重建了一次');
  assert.equal(lookupCount, 2, '重试了一次');
});

test('重建后仍跳验证页 → 抛中文错', async () => {
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('/visitor/genvisitor')) return fakeRes({ body: GENVISITOR_BODY });
    if (url.includes('/visitor/visitor')) return fakeRes({ body: VISITOR_BODY });
    return fakeRes({ status: 302, location: 'https://visitor.passport.weibo.cn/visitor/visitor' });
  };
  const r = createWeiboResolver(fetchImpl);
  await assert.rejects(r.resolveUid('x'), /访客 cookie 重建后仍失效/);
});

test('网络错误 → 抛带中文说明的 Error', async () => {
  const fetchImpl: FetchImpl = async () => { throw new Error('fetch failed'); };
  const r = createWeiboResolver(fetchImpl);
  await assert.rejects(r.resolveUid('x'), /微博/);
});

test('genvisitor 响应缺 tid → 抛中文错', async () => {
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('/visitor/genvisitor')) {
      return fakeRes({ body: 'window.gen_callback && gen_callback({"retcode":20000000,"data":{}});' });
    }
    throw new Error('不该走到');
  };
  const r = createWeiboResolver(fetchImpl);
  await assert.rejects(r.resolveUid('x'), /tid/);
});

test('同一 resolver 内 cookie 缓存：第二次解析不重新取 cookie', async () => {
  let genCount = 0;
  const fetchImpl: FetchImpl = async (url) => {
    if (url.includes('/visitor/genvisitor')) { genCount++; return fakeRes({ body: GENVISITOR_BODY }); }
    if (url.includes('/visitor/visitor')) return fakeRes({ body: VISITOR_BODY });
    return fakeRes({ status: 302, location: 'https://m.weibo.cn/u/111' });
  };
  const r = createWeiboResolver(fetchImpl);
  await r.resolveUid('a');
  await r.resolveUid('b');
  assert.equal(genCount, 1);
});
