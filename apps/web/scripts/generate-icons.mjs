// Generates PWA PNG icons from a single source SVG. Run once via
//   npm run icons --workspace=@ticketing/web
// The generated files land in apps/web/public and are checked in.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import sharp from 'sharp';

const here = fileURLToPath(new URL('..', import.meta.url));
const svgPath = `${here}/public/favicon.svg`;
const svg = readFileSync(svgPath);

async function emit(size, out) {
  const buf = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
  writeFileSync(`${here}/public/${out}`, buf);
  console.log(`wrote ${out} (${size}x${size}, ${buf.length} bytes)`);
}

await emit(192, 'pwa-192x192.png');
await emit(512, 'pwa-512x512.png');
await emit(180, 'apple-touch-icon.png');
