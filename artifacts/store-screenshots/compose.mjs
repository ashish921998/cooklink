import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
const sharp = require('sharp');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const artifactRoot = path.join(root, 'artifacts/store-screenshots');
const rawRoot = path.join(artifactRoot, 'raw');
const brandMarkPath = path.join(root, 'apps/mobile/assets/brand-mark.png');

const gallery = [
  {
    slug: 'plan-together',
    source: '01-today.png',
    lines: ['Plan every meal', 'together'],
    colors: ['#FFF4ED', '#F3D3C7'],
    accent: '#BE4E38',
  },
  {
    slug: 'cook-in-loop',
    source: '05-household-chat.png',
    lines: ['Keep your cook', 'in the loop'],
    colors: ['#F2F5E9', '#DCE8CA'],
    accent: '#416A3D',
  },
  {
    slug: 'plan-to-groceries',
    source: '03-groceries.png',
    lines: ['Turn every plan', 'into groceries'],
    colors: ['#FFF8E8', '#F5DE9A'],
    accent: '#966517',
  },
  {
    slug: 'seven-day-plan',
    source: '02-meal-plan.png',
    lines: ['Seven days. One', 'clear plan.'],
    colors: ['#F8F4EE', '#E5DDD2'],
    accent: '#6E5F50',
  },
  {
    slug: 'recipe-guide',
    source: '04-recipe-guide.png',
    lines: ['Recipes your cook', 'can follow'],
    colors: ['#FFF0E9', '#E8B6A4'],
    accent: '#A84331',
  },
  {
    slug: 'exact-packs',
    source: '06-instamart-products.png',
    lines: ['Choose exact packs,', 'then order'],
    colors: ['#EFF5EA', '#CDE0C6'],
    accent: '#3F6D42',
  },
];

const formats = [
  {
    name: 'ios-6.7/en-US',
    width: 1290,
    height: 2796,
    phoneWidth: 976,
    phoneY: 640,
    phoneRadius: 88,
    bezel: 18,
    captionX: 118,
    captionY: 210,
    captionSize: 108,
    lineGap: 112,
    labelY: 108,
    labelSize: 31,
    markSize: 110,
    markX: 1132,
    markY: 68,
  },
  {
    name: 'android-phone/en-US',
    width: 1080,
    height: 1920,
    phoneWidth: 708,
    phoneY: 398,
    phoneRadius: 62,
    bezel: 14,
    captionX: 70,
    captionY: 142,
    captionSize: 78,
    lineGap: 82,
    labelY: 55,
    labelSize: 26,
    markSize: 112,
    markX: 900,
    markY: 24,
  },
];

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function backgroundSvg(width, height, colors) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${colors[0]}"/>
          <stop offset="1" stop-color="${colors[1]}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#g)"/>
      <circle cx="${Math.round(width * 0.9)}" cy="${Math.round(height * 0.13)}" r="${Math.round(width * 0.28)}" fill="#FFFFFF" fill-opacity="0.24"/>
      <circle cx="${Math.round(width * 0.05)}" cy="${Math.round(height * 0.7)}" r="${Math.round(width * 0.34)}" fill="#FFFFFF" fill-opacity="0.15"/>
    </svg>
  `);
}

function captionSvg(format, shot) {
  const { width, height, captionX, captionY, captionSize, lineGap, labelY, labelSize } = format;
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${captionX}" y="${labelY}" fill="${shot.accent}" font-family="SF Pro Display, Arial, sans-serif" font-size="${labelSize}" font-weight="700" letter-spacing="7">COOKLINK</text>
      <text x="${captionX}" y="${captionY}" fill="#1D1A17" font-family="Georgia, serif" font-size="${captionSize}" font-weight="700">
        <tspan x="${captionX}" dy="0">${escapeXml(shot.lines[0])}</tspan>
        <tspan x="${captionX}" dy="${lineGap}">${escapeXml(shot.lines[1])}</tspan>
      </text>
    </svg>
  `);
}

function frameSvg(width, height, x, y, phoneWidth, phoneHeight, radius, bezel) {
  const bx = x - bezel;
  const by = y - bezel;
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="22" stdDeviation="25" flood-color="#3F2F26" flood-opacity="0.24"/>
        </filter>
      </defs>
      <rect x="${bx}" y="${by}" width="${phoneWidth + bezel * 2}" height="${phoneHeight + bezel * 2}" rx="${radius + bezel}" fill="#FFFFFF" filter="url(#shadow)"/>
      <rect x="${bx}" y="${by}" width="${phoneWidth + bezel * 2}" height="${phoneHeight + bezel * 2}" rx="${radius + bezel}" fill="#FFFFFF"/>
    </svg>
  `);
}

function roundedMask(width, height, radius) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" rx="${radius}" fill="#FFFFFF"/>
    </svg>
  `);
}

async function createStoreShot(format, shot, index) {
  const phoneHeight = Math.round(format.phoneWidth * (2622 / 1206));
  const phoneX = Math.round((format.width - format.phoneWidth) / 2);
  const sourcePath = path.join(rawRoot, shot.source);
  const phone = await sharp(sourcePath)
    .resize(format.phoneWidth, phoneHeight, { fit: 'fill' })
    .composite([
      { input: roundedMask(format.phoneWidth, phoneHeight, format.phoneRadius), blend: 'dest-in' },
    ])
    .png()
    .toBuffer();
  const mark = await sharp(brandMarkPath)
    .resize(format.markSize, format.markSize, { fit: 'contain' })
    .png()
    .toBuffer();
  const outputDir = path.join(artifactRoot, format.name);
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${String(index + 1).padStart(2, '0')}-${shot.slug}.png`);
  await sharp(backgroundSvg(format.width, format.height, shot.colors))
    .composite([
      {
        input: frameSvg(
          format.width,
          format.height,
          phoneX,
          format.phoneY,
          format.phoneWidth,
          phoneHeight,
          format.phoneRadius,
          format.bezel,
        ),
        left: 0,
        top: 0,
      },
      { input: phone, left: phoneX, top: format.phoneY },
      { input: captionSvg(format, shot), left: 0, top: 0 },
      { input: mark, left: format.markX, top: format.markY },
    ])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
  return outputPath;
}

async function createFeatureGraphic() {
  const width = 1024;
  const height = 500;
  const mark = await sharp(brandMarkPath).resize(330, 330, { fit: 'contain' }).png().toBuffer();
  const text = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="455" y="92" fill="#BE4E38" font-family="SF Pro Display, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="6">COOKLINK</text>
      <text x="455" y="185" fill="#1D1A17" font-family="Georgia, serif" font-size="64" font-weight="700">
        <tspan x="455" dy="0">One kitchen.</tspan>
        <tspan x="455" dy="72">One plan.</tspan>
      </text>
      <text x="458" y="370" fill="#675F58" font-family="SF Pro Display, Arial, sans-serif" font-size="27" font-weight="500">
        <tspan x="458" dy="0">Shared by your household</tspan>
        <tspan x="458" dy="36">and your cook.</tspan>
      </text>
    </svg>
  `);
  const outputDir = path.join(artifactRoot, 'android-phone/en-US');
  await mkdir(outputDir, { recursive: true });
  await sharp(backgroundSvg(width, height, ['#FFF5E9', '#F1C9B8']))
    .composite([
      { input: mark, left: 68, top: 84 },
      { input: text, left: 0, top: 0 },
    ])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(path.join(outputDir, 'feature-graphic-1024x500.png'));
}

async function createContactSheet(paths) {
  const thumbWidth = 260;
  const thumbHeight = Math.round(thumbWidth * (2796 / 1290));
  const gutter = 26;
  const padding = 34;
  const canvasWidth = padding * 2 + thumbWidth * 3 + gutter * 2;
  const canvasHeight = padding * 2 + thumbHeight * 2 + gutter;
  const thumbs = await Promise.all(
    paths.map((file) =>
      sharp(file).resize(thumbWidth, thumbHeight, { fit: 'fill' }).png().toBuffer(),
    ),
  );
  const composites = thumbs.map((input, index) => ({
    input,
    left: padding + (index % 3) * (thumbWidth + gutter),
    top: padding + Math.floor(index / 3) * (thumbHeight + gutter),
  }));
  const previewDir = path.join(artifactRoot, 'preview');
  await mkdir(previewDir, { recursive: true });
  await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 3, background: '#1E1A17' },
  })
    .composite(composites)
    .png()
    .toFile(path.join(previewDir, 'ios-gallery-contact-sheet.png'));
}

const created = [];
for (const format of formats) {
  for (const [index, shot] of gallery.entries()) {
    created.push(await createStoreShot(format, shot, index));
  }
}
await createFeatureGraphic();
await createContactSheet(created.filter((file) => file.includes('/ios-6.7/')));
console.log(created.join('\n'));
