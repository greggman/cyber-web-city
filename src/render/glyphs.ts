// Glyph atlas for neon signs, drawn with the browser's Canvas2D text API
// (not a library). R = sharp glyph (the neon tube), G = blurred glow.
// 16x16 cells of 64 px; mipmaps are generated on the CPU.
import {createTexture} from '../gpu/gpu';

export const GLYPH_CELL = 64;
export const GLYPH_GRID = 16;

const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const KANA =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';
const CJK =
  '酒店面拉电气夜市龙城茶餐厅药医中华银行寿司東京新宿街道金福喜乐美食火锅烧烤按摩网吧游戏机器人' +
  '超级未来科技数码霓虹天空飞车警察安全公司大厦酒吧咖啡肉饭汤鱼虾蟹酱香辣麻热冷水雨云光明星月' +
  '日本韩国台北香港上海深圳重庆广州北京西南东北无限梦想爱心永生龍鳳虎門樓閣電腦';

export const GLYPHS = (LATIN + KANA + CJK).slice(0, GLYPH_GRID * GLYPH_GRID);
export const LATIN_START = 0;
export const LATIN_COUNT = LATIN.length;
export const KANA_START = LATIN.length;
export const KANA_COUNT = KANA.length;
export const CJK_START = LATIN.length + KANA.length;
export const CJK_COUNT = GLYPHS.length - CJK_START;

export function glyphIndex(ch: string): number {
  const i = GLYPHS.indexOf(ch);
  return i < 0 ? 0 : i;
}

function drawGlyphs(blur: number): Uint8ClampedArray {
  const size = GLYPH_CELL * GLYPH_GRID;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', {willReadFrequently: true})!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${GLYPH_CELL * 0.72}px "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", "Yu Gothic", sans-serif`;
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  ctx.lineWidth = blur > 0 ? 6 : 0;
  [...GLYPHS].forEach((ch, i) => {
    const x = (i % GLYPH_GRID) * GLYPH_CELL + GLYPH_CELL / 2;
    const y = Math.floor(i / GLYPH_GRID) * GLYPH_CELL + GLYPH_CELL / 2 + 2;
    ctx.fillText(ch, x, y);
    if (blur > 0) ctx.strokeText(ch, x, y);
  });
  return ctx.getImageData(0, 0, size, size).data;
}

export function createGlyphAtlas(device: GPUDevice): GPUTexture {
  const size = GLYPH_CELL * GLYPH_GRID;
  const sharp = drawGlyphs(0);
  const glow = drawGlyphs(5);
  let level = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    level[i * 4] = sharp[i * 4];
    level[i * 4 + 1] = Math.min(255, glow[i * 4] * 1.6);
    level[i * 4 + 2] = 0;
    level[i * 4 + 3] = 255;
  }
  const mips = Math.log2(size) + 1;
  const tex = createTexture(device, {
    label: 'signs/glyphAtlas',
    size: [size, size],
    format: 'rgba8unorm',
    mipLevelCount: mips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  let w = size;
  for (let m = 0; m < mips; m++) {
    device.queue.writeTexture(
      {texture: tex, mipLevel: m},
      level,
      {bytesPerRow: w * 4},
      [w, w],
    );
    if (w === 1) break;
    const nw = w / 2;
    const next = new Uint8Array(nw * nw * 4);
    for (let y = 0; y < nw; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          const i = (yy: number, xx: number) =>
            ((y * 2 + yy) * w + x * 2 + xx) * 4 + c;
          next[(y * nw + x) * 4 + c] =
            (level[i(0, 0)] +
              level[i(0, 1)] +
              level[i(1, 0)] +
              level[i(1, 1)] +
              2) >>
            2;
        }
      }
    }
    level = next;
    w = nw;
  }
  return tex;
}
