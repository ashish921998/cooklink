import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandRoot = path.join(mobileRoot, 'assets', 'brand');
const outputRoot = path.join(mobileRoot, 'assets');

await mkdir(outputRoot, { recursive: true });

const exports = [
  ['app-icon.svg', 'icon.png', 1024, true],
  ['mark.svg', 'adaptive-icon.png', 1024, false],
  ['mark-monochrome.svg', 'monochrome-icon.png', 1024, false],
  ['mark.svg', 'splash-icon.png', 512, false],
  ['mark.svg', 'brand-mark.png', 512, false],
];

for (const [source, output, size, mustBeOpaque] of exports) {
  let image = sharp(path.join(brandRoot, source), { density: 288 }).resize(size, size);
  if (mustBeOpaque) image = image.flatten({ background: '#24352f' }).removeAlpha();
  await image.png({ compressionLevel: 9 }).toFile(path.join(outputRoot, output));
}

await sharp(path.join(brandRoot, 'app-icon.svg'), { density: 288 })
  .resize(48, 48)
  .png({ compressionLevel: 9 })
  .toFile(path.join(outputRoot, 'favicon.png'));
