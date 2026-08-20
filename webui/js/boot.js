// 入口：?demo=1 时先装 mock fetch 拦截器再进 app（时序可靠）；真实部署不带 demo 参数 = 零影响。
if (new URLSearchParams(location.search).get('demo') === '1') {
  await import('../demo/mock-api.js');
}
await import('./app.js');
