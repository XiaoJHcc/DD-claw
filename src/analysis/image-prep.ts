/**
 * 送模型图片的统一规范化：LLM 与决策模型共用同一份产出。
 *
 * 纯本地处理（sharp），不做任何网络——图床 URL 落本地由调用方（pipeline）负责。
 * 一律按字节内容识别格式（不看扩展名），产出固定的基线 JPEG data URL：
 * 动图取首帧、按 EXIF 摆正、去 alpha 铺白底、边长收进 [minSide, maxSide]、体积不超上限。
 * 解码失败或处理后仍不合规的单张在这里拦下并给出简短原因，由调用方逐张记进审计。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp from 'sharp';

/** 下游识图门禁：边长区间（总像素区间由此推出：280²–1568²）与单图体积上限 */
export const IMAGE_LIMITS = {
  minSide: 280,
  maxSide: 1568,
  maxBytes: 4 * 1024 * 1024,
} as const;

/** 品质阶梯：85 是基线输出，往下只在超体积时逐级重试 */
const QUALITY_LADDER = [85, 75, 65, 55] as const;

/** 允许解码的栅格格式（字节头识别）：SVG / PDF 这类矢量与文档不进这条线 */
const DECODABLE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff']);

const WHITE = '#ffffff';

type Sharp = ReturnType<typeof sharp>;

export interface PreparedImage {
  ok: true;
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

export type PrepareResult = PreparedImage | { ok: false; reason: string };

/** 送模型的视觉输入：合规的 data URL + 被拦下的图（逐张带原因，供审计） */
export interface PreparedImages {
  dataUrls: string[];
  skipped: Array<{ ref: string; reason: string }>;
}

/** 目标画布：先按长边压到 maxSide，短边不足 minSide 时放大或补白，两种画布都正好落在区间内 */
interface Canvas {
  width: number;
  height: number;
  /** true = 极端长宽比放大后长边会越界，改为长边封顶 + 白边补齐短边 */
  pad: boolean;
}

function planCanvas(width: number, height: number): Canvas {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  // 长边出界（或短边够长）时按长边定标；短边不足 minSide 时改按短边定标
  const shrink = long > IMAGE_LIMITS.maxSide ? IMAGE_LIMITS.maxSide / long : 1;
  if (short * shrink < IMAGE_LIMITS.minSide) {
    const grow = IMAGE_LIMITS.minSide / short;
    if (long * grow <= IMAGE_LIMITS.maxSide) {
      return { width: Math.round(width * grow), height: Math.round(height * grow), pad: false };
    }
    // 极端长宽比：放大到短边 minSide 会把长边推出上限 → 长边 maxSide，短边留白凑够 minSide
    const wide = width >= height;
    return {
      width: wide ? IMAGE_LIMITS.maxSide : IMAGE_LIMITS.minSide,
      height: wide ? IMAGE_LIMITS.minSide : IMAGE_LIMITS.maxSide,
      pad: true,
    };
  }
  return {
    width: Math.min(IMAGE_LIMITS.maxSide, Math.max(IMAGE_LIMITS.minSide, Math.round(width * shrink))),
    height: Math.min(IMAGE_LIMITS.maxSide, Math.max(IMAGE_LIMITS.minSide, Math.round(height * shrink))),
    pad: false,
  };
}

/** 一张图片字节 → 合规的基线 JPEG data URL；任何不合规都返回原因而不是抛错 */
export async function prepareImage(buf: Buffer): Promise<PrepareResult> {
  // 动图（GIF / 动态 WebP / APNG）只取首帧：pages=1，其余帧不解码
  let pipeline: Sharp;
  let format: string | undefined;
  let width: number;
  let height: number;
  try {
    const source = sharp(buf, { pages: 1, animated: false });
    const meta = await source.metadata();
    format = meta.format;
    // EXIF 1/3/6/8 决定摆正后哪一边是宽：orientation ≥ 5 = 宽高互换
    const swapped = (meta.orientation ?? 1) >= 5;
    width = (swapped ? meta.height : meta.width) ?? 0;
    height = (swapped ? meta.width : meta.height) ?? 0;
    pipeline = source;
  } catch {
    return { ok: false, reason: '无法解码' };
  }
  if (!format || !DECODABLE_FORMATS.has(format)) return { ok: false, reason: '不支持的图片格式' };
  if (width <= 0 || height <= 0) return { ok: false, reason: '无法解码' };

  const canvas = planCanvas(width, height);
  try {
    // rotate() 按 EXIF 摆正；flatten 去掉 alpha 时铺白底（JPEG 没有透明通道）
    pipeline = pipeline.rotate().flatten({ background: WHITE });
    if (canvas.pad) {
      // contain 只等比缩放 + 白边补齐，结果画布恰为目标尺寸
      pipeline = pipeline.resize(canvas.width, canvas.height, { fit: 'contain', background: WHITE });
    } else if (canvas.width !== width || canvas.height !== height) {
      pipeline = pipeline.resize(canvas.width, canvas.height, { fit: 'fill' });
    }

    for (const quality of QUALITY_LADDER) {
      const out = await pipeline.clone().jpeg({ quality, progressive: false }).toBuffer({ resolveWithObject: true });
      if (out.info.size > IMAGE_LIMITS.maxBytes) continue;
      // 自检：产出必须是合规 JPEG（防御：正常路径不会命中，坏图绝不流给模型）
      if (out.info.format !== 'jpeg'
        || out.data[0] !== 0xff || out.data[1] !== 0xd8
        || out.info.width < IMAGE_LIMITS.minSide || out.info.width > IMAGE_LIMITS.maxSide
        || out.info.height < IMAGE_LIMITS.minSide || out.info.height > IMAGE_LIMITS.maxSide) {
        return { ok: false, reason: '输出不合规' };
      }
      const base64 = out.data.toString('base64');
      return {
        ok: true, base64, dataUrl: `data:image/jpeg;base64,${base64}`,
        width: out.info.width, height: out.info.height, bytes: out.info.size,
      };
    }
    return { ok: false, reason: '压缩后仍超过体积上限' };
  } catch {
    return { ok: false, reason: '无法解码' };
  }
}

/** 一批本地图片 → 视觉输入；单张失败只影响自己（ref = 文件名，不带路径与内容） */
export async function prepareImageFiles(paths: string[], max = 9): Promise<PreparedImages> {
  const dataUrls: string[] = [];
  const skipped: Array<{ ref: string; reason: string }> = [];
  for (const [index, path] of paths.entries()) {
    const ref = basename(path) || `#${index + 1}`;
    if (index >= max) {
      skipped.push({ ref, reason: '超过张数上限' });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch {
      skipped.push({ ref, reason: '读取失败' });
      continue;
    }
    const prepared = await prepareImage(buf);
    if (prepared.ok) dataUrls.push(prepared.dataUrl);
    else skipped.push({ ref, reason: prepared.reason });
  }
  return { dataUrls, skipped };
}
