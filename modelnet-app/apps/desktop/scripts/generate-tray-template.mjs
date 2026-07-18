#!/usr/bin/env node
/**
 * Generate the macOS tray template icon set (black + alpha).
 *
 * Template images must contain only black pixels and an alpha channel;
 * macOS then recolors them automatically based on the menu bar theme.
 *
 * Renders two files in apps/desktop/resources:
 *   - modelnet-trayTemplate.png       (@1x, 18x18)
 *   - modelnet-trayTemplate@2x.png    (@2x, 36x36)
 *
 * Run: bun run apps/desktop/scripts/generate-tray-template.mjs
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'resources');

// Compact ModelNet “M” monogram for reliable rendering at menu-bar sizes.
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#000" d="M15 88V12h18l17 40 17-40h18v76H70V43L57 76H43L30 43v45z"/>
</svg>
`;

async function render(size, outFile) {
  const buf = Buffer.from(svg);
  await sharp(buf, { density: Math.max(72, size * 12) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outFile);
  console.log(`wrote ${path.relative(process.cwd(), outFile)} (${size}x${size})`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await render(18, path.join(outDir, 'modelnet-trayTemplate.png'));
  await render(36, path.join(outDir, 'modelnet-trayTemplate@2x.png'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
