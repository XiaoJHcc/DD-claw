import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { IMAGE_LIMITS, prepareImage, prepareImageFiles } from './image-prep.js';

// ---- 样本：全部在内存里用 sharp 生成（不落盘、不联网）----

/** 纯色图 → 指定格式 */
function solid(width: number, height: number, format: 'jpeg' | 'png' | 'webp', alpha = 1): Promise<Buffer> {
  const background = alpha >= 1 ? '#336699' : { r: 51, g: 102, b: 153, alpha };
  return sharp({ create: { width, height, channels: alpha >= 1 ? 3 : 4, background } })
    [format]().toBuffer();
}

/** 多帧动图 GIF：每帧不同纯色（帧内容重复会被编码器合并），总高 = pageHeight × frames */
function animatedGif(width: number, height: number, frames: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * frames * 4);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < width * height; i++) {
      const o = (f * width * height + i) * 4;
      raw[o] = 20 + f * 60;
      raw[o + 1] = 40;
      raw[o + 2] = 220 - f * 60;
      raw[o + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .gif().toBuffer();
}

function assertCompliantJpeg(res: Awaited<ReturnType<typeof prepareImage>>): asserts res is Extract<typeof res, { ok: true }> {
  assert.equal(res.ok, true, res.ok ? '' : `应合规，实际被拦：${res.reason}`);
  assert.ok(res.dataUrl.startsWith('data:image/jpeg;base64,'), 'data URL 必须是 JPEG');
  assert.equal(Buffer.from(res.base64, 'base64')[0], 0xff, '输出字节头 FF');
  assert.equal(Buffer.from(res.base64, 'base64')[1], 0xd8, '输出字节头 D8');
  for (const side of [res.width, res.height]) {
    assert.ok(side >= IMAGE_LIMITS.minSide && side <= IMAGE_LIMITS.maxSide, `边长 ${side} 应在 [${IMAGE_LIMITS.minSide}, ${IMAGE_LIMITS.maxSide}]`);
  }
  assert.ok(res.bytes <= IMAGE_LIMITS.maxBytes, `体积 ${res.bytes} 应在上限内`);
}

// ---- 常规格式：解码 + 转基线 JPEG ----

test('普通 JPEG：原尺寸合规即不缩放，转成基线 JPEG data URL', async () => {
  const res = await prepareImage(await solid(800, 600, 'jpeg'));
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [800, 600]);
});

test('PNG 带 alpha：去透明通道铺白底，输出 JPEG（无 alpha）', async () => {
  const res = await prepareImage(await solid(600, 400, 'png', 0.25));
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [600, 400]);
});

test('WebP：按字节内容识别（无关扩展名）并转 JPEG', async () => {
  const res = await prepareImage(await solid(640, 480, 'webp'));
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [640, 480]);
});

test('动画 GIF：只取首帧（多帧不会被叠成竖长图）', async () => {
  const gif = await animatedGif(400, 300, 3);
  const meta = await sharp(gif).metadata();
  assert.equal(meta.pages, 3, '样本确实是 3 帧动图');
  const res = await prepareImage(gif);
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [400, 300], '首帧尺寸，不是 400×900');
});

// ---- 尺寸规范化：放大 / 缩小 / 极端长宽比补白 ----

test('100×100 小图：等比放大到短边下限', async () => {
  const res = await prepareImage(await solid(100, 100, 'jpeg'));
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [IMAGE_LIMITS.minSide, IMAGE_LIMITS.minSide]);
});

test('4000×3000 大图：等比缩到长边上限，短边仍在下限之上', async () => {
  const res = await prepareImage(await solid(4000, 3000, 'jpeg'));
  assertCompliantJpeg(res);
  assert.equal(res.width, IMAGE_LIMITS.maxSide);
  assert.deepEqual([res.width, res.height], [1568, 1176], '比例保住（4000:3000 = 4:3）');
});

test('3000×200 极端长图：长边封顶 + 白边补齐短边', async () => {
  const res = await prepareImage(await solid(3000, 200, 'jpeg'));
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [IMAGE_LIMITS.maxSide, IMAGE_LIMITS.minSide], '放大到短边会爆长边 → 补白');
});

test('EXIF 方向 6：按 EXIF 摆正后宽高互换', async () => {
  const raw = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(raw).metadata()).orientation, 6, '样本带方向标记');
  const res = await prepareImage(raw);
  assertCompliantJpeg(res);
  assert.deepEqual([res.width, res.height], [400, 600], '摆正后 400 宽 × 600 高');
});

// ---- 拦截：坏图不成请求 ----

test('损坏字节：解码失败被拦下，原因简短可读', async () => {
  const garbage = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256));
  const res = await prepareImage(garbage);
  assert.deepEqual(res, { ok: false, reason: '无法解码' });

  // PNG 头 + 残缺数据：认得出格式但解不开
  const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('broken')]);
  assert.deepEqual(await prepareImage(truncated), { ok: false, reason: '无法解码' });
});

test('矢量 / 文档类：不进图片管线（不是「图片坏了」，而是不支持）', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300"/></svg>');
  assert.deepEqual(await prepareImage(svg), { ok: false, reason: '不支持的图片格式' });
});

// ---- 批量：单张失败只影响自己 ----

test('prepareImageFiles：逐张规范化，坏图 / 缺文件 / 超张数各有原因，其余照带', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-claw-imageprep-'));
  try {
    const good = await solid(400, 300, 'jpeg');
    const write = (name: string, buf: Buffer) => {
      const p = join(dir, name);
      writeFileSync(p, buf);
      return p;
    };
    const paths = [
      write('good0.jpg', good),
      write('broken.jpg', Buffer.from('not an image')),
      join(dir, 'missing.jpg'),
      ...Array.from({ length: 6 }, (_, i) => write(`good${i + 1}.jpg`, good)),
      write('tenth.jpg', good),
      write('eleventh.jpg', good),
    ];
    assert.equal(paths.length, 11);

    const out = await prepareImageFiles(paths);
    assert.equal(out.dataUrls.length, 7, '前 9 个里 2 张有问题，其余全带（上限 9 张）');
    assert.equal(out.skipped.length, 4);
    assert.deepEqual(out.skipped, [
      { ref: 'broken.jpg', reason: '无法解码' },
      { ref: 'missing.jpg', reason: '读取失败' },
      { ref: 'tenth.jpg', reason: '超过张数上限' },
      { ref: 'eleventh.jpg', reason: '超过张数上限' },
    ]);
    for (const url of out.dataUrls) assert.ok(url.startsWith('data:image/jpeg;base64,'));

    const capped = await prepareImageFiles(paths, 2);
    assert.equal(capped.dataUrls.length, 1, '上限 2 张：第 1 张合规，第 2 张坏图');
    assert.equal(capped.skipped.filter((s) => s.reason === '超过张数上限').length, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
