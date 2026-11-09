// Minimal PNG reader for one question: does this asset really have an alpha channel, and is it used?
//
// colour type 6 only says the container carries alpha. An all-255 alpha channel is a fully opaque image
// wearing a transparent hat, and the UI composites that over a panel and looks broken in a way nobody can
// explain. So this reads the pixels. No dependency is available on this box (no PIL in any venv, no sharp),
// and "the prompt said transparent background" is not evidence of anything.
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const PAETH = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** @returns {{width,height,colorType,channels,interlace,alpha:{min,max,mean,transparent,corner,centre}|null}} */
export async function pngInfo(path) {
  const b = await readFile(path);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + path);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p); const type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  const out = { width: w, height: h, colorType: ctype, channels, interlace, alpha: null, path };
  if (depth !== 8 || channels === undefined) return out;         // 16-bit / palette: not what we emit
  if (interlace !== 0) return out;                                 // Adam7: SaveImage does not write these
  if (ctype !== 6) return out;                                     // no alpha to measure

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const up = y > 0 ? px[(y - 1) * stride + x] : 0;
      const ul = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[q + x];
      if (f === 1) v = v + a; else if (f === 2) v = v + up; else if (f === 3) v = v + ((a + up) >> 1); else if (f === 4) v = v + PAETH(a, up, ul);
      px[y * stride + x] = v & 0xff;
    }
    q += stride;
  }
  let min = 255, max = 0, sum = 0, trans = 0;
  for (let i = 3; i < px.length; i += 4) { const v = px[i]; if (v < min) min = v; if (v > max) max = v; sum += v; if (v < 128) trans++; }
  const n = px.length / 4;
  const box = (x0, y0, x1, y1) => { let s = 0, c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += px[(y * w + x) * 4 + 3]; c++; } return Math.round(s / c); };
  out.alpha = {
    min, max, mean: +(sum / n).toFixed(1),
    transparent: +(trans / n).toFixed(3),
    // Corners empty + centre solid is a cut-out sprite. Corners solid + centre soft is a vignette, which
    // is what an ordinary illustration with a "transparent background" in the prompt usually means.
    corner: Math.round((box(0, 0, 48, 48) + box(w - 48, 0, w, 48) + box(0, h - 48, 48, h) + box(w - 48, h - 48, w, h)) / 4),
    centre: box((w >> 1) - 40, (h >> 1) - 40, (w >> 1) + 40, (h >> 1) + 40),
  };
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('png.mjs')) {
  for (const f of process.argv.slice(2)) {
    const i = await pngInfo(f);
    const a = i.alpha;
    console.log(`${f.split(/[\\/]/).pop()}  ${i.width}x${i.height} ct=${i.colorType} ch=${i.channels}` + (a
      ? `  alpha min=${a.min} mean=${a.mean} max=${a.max} transparent=${(a.transparent * 100).toFixed(1)}% corner=${a.corner} centre=${a.centre}  -> ${a.transparent > 0.02 && a.corner < 90 ? 'REAL CUT-OUT' : a.min === a.max ? 'UNIFORM (opaque, alpha is decorative)' : 'mostly opaque'}`
      : '  -> NO ALPHA CHANNEL'));
  }
}
