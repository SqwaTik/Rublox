// Генерация иконок приложения из исходной аватарки.
// Сжимает PNG и собирает .ico для Electron/сборки. Запуск: node scripts/make-icons.mjs
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '43e3225c-dacc-447b-8c3a-13135f3cab3a.png');
const assets = join(root, 'desktop', 'assets');
const webImg = join(root, 'web', 'img');
if (!existsSync(assets)) mkdirSync(assets, { recursive: true });
if (!existsSync(webImg)) mkdirSync(webImg, { recursive: true });

// Сжатый логотип для веба (256px, оптимизированный PNG).
await sharp(src).resize(256, 256, { fit: 'cover' })
  .png({ quality: 80, compressionLevel: 9 })
  .toFile(join(webImg, 'logo.png'));

// Маленький для аватарок/favicon.
await sharp(src).resize(64, 64, { fit: 'cover' })
  .png({ quality: 80, compressionLevel: 9 })
  .toFile(join(webImg, 'logo-64.png'));

// Набор размеров для .ico.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const bufs = [];
for (const s of sizes) {
  bufs.push(await sharp(src).resize(s, s, { fit: 'cover' }).png().toBuffer());
}
const ico = await pngToIco(bufs);
writeFileSync(join(assets, 'icon.ico'), ico);

// 512px PNG для трея/окна.
await sharp(src).resize(512, 512, { fit: 'cover' }).png({ compressionLevel: 9 })
  .toFile(join(assets, 'icon.png'));

console.log('Иконки готовы: web/img/logo.png, desktop/assets/icon.ico, desktop/assets/icon.png');
