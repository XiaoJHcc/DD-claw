/**
 * B站 web 端设备指纹（dm_*）参数生成。
 * 动态接口（web-dynamic/feed/space）实测（2026-08-03）必须带这三个参数，
 * 否则 412 风控页。算法出处：RSSHub lib/routes/bilibili/utils.ts 的
 * getDmImgList / addDmVerifyInfo。弹幕等其他风控接口将来复用本文件。
 */

/** base64('no webgl') 去 padding —— 无 WebGL 环境指纹的固定声明 */
const DM_IMG_STR = 'bm8gd2ViZ2w';

/** 高斯分布整数：Box-Muller 后 Math.round，下限 0（与 RSSHub rand 一致） */
function gaussianInt(mean: number, std: number): number {
  const u = Math.random() || Number.EPSILON;
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(mean + z * std));
}

/** 模拟鼠标轨迹：单点高斯抖动路径，JSON 字符串 */
function getDmImgList(): string {
  const x = gaussianInt(1245, 5);
  const y = gaussianInt(1285, 5);
  return JSON.stringify([
    { x: 3 * x + 2 * y, y: 4 * x - 5 * y, z: 0, timestamp: gaussianInt(30, 5), type: 0 },
  ]);
}

/** 拼进动态接口 query 的三个 dm 参数（已 encodeURIComponent） */
export function dmQueryParams(): string {
  return 'dm_img_list=' + encodeURIComponent(getDmImgList()) +
    '&dm_img_str=' + DM_IMG_STR +
    '&dm_cover_img_str=' + DM_IMG_STR;
}
