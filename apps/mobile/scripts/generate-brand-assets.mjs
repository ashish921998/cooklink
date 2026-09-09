import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandRoot = path.join(mobileRoot, 'assets', 'brand');
const outputRoot = path.join(mobileRoot, 'assets');
const selectedCharacter = path.join(brandRoot, 'tiffin-buddy.png');

await mkdir(outputRoot, { recursive: true });

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

async function extractCharacter() {
  const { data, info } = await sharp(selectedCharacter)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sampleSize = 12;
  const samples = [];

  for (const originY of [0, info.height - sampleSize]) {
    for (const originX of [0, info.width - sampleSize]) {
      for (let y = originY; y < originY + sampleSize; y += 1) {
        for (let x = originX; x < originX + sampleSize; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          samples.push([data[offset], data[offset + 1], data[offset + 2]]);
        }
      }
    }
  }

  const background = samples
    .reduce((sum, sample) => sum.map((channel, index) => channel + sample[index]), [0, 0, 0])
    .map((channel) => channel / samples.length);
  const output = Buffer.alloc(info.width * info.height * 4);

  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const sourceOffset = pixel * info.channels;
    const outputOffset = pixel * 4;
    const red = data[sourceOffset];
    const green = data[sourceOffset + 1];
    const blue = data[sourceOffset + 2];
    const distance = Math.hypot(red - background[0], green - background[1], blue - background[2]);
    const alpha = clamp(Math.round(((distance - 12) / 36) * 255), 0, 255);

    output[outputOffset] = red;
    output[outputOffset + 1] = green;
    output[outputOffset + 2] = blue;
    output[outputOffset + 3] = alpha < 8 ? 0 : alpha;
  }

  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 12 })
    .png()
    .toBuffer();
}

async function placeCharacter(character, canvasSize, characterSize) {
  const resizedCharacter = await sharp(character)
    .resize({
      width: characterSize,
      height: characterSize,
      fit: 'inside',
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resizedCharacter, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const character = await extractCharacter();
const adaptiveIcon = await placeCharacter(character, 1024, 700);
const splashIcon = await placeCharacter(character, 512, 400);
const brandMark = await placeCharacter(character, 512, 460);

await sharp(selectedCharacter)
  .resize(1024, 1024)
  .flatten({ background: '#f7f3ed' })
  .removeAlpha()
  .png({ compressionLevel: 9 })
  .toFile(path.join(outputRoot, 'icon.png'));

await sharp(adaptiveIcon).toFile(path.join(outputRoot, 'adaptive-icon.png'));
await sharp(splashIcon).toFile(path.join(outputRoot, 'splash-icon.png'));
await sharp(brandMark).toFile(path.join(outputRoot, 'brand-mark.png'));

const monochromeAlpha = await sharp(adaptiveIcon).extractChannel('alpha').raw().toBuffer();

await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 3,
    background: '#ffffff',
  },
})
  .joinChannel(monochromeAlpha, {
    raw: { width: 1024, height: 1024, channels: 1 },
  })
  .png({ compressionLevel: 9 })
  .toFile(path.join(outputRoot, 'monochrome-icon.png'));

await sharp(selectedCharacter)
  .resize(48, 48)
  .png({ compressionLevel: 9 })
  .toFile(path.join(outputRoot, 'favicon.png'));
