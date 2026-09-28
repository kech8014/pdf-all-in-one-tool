// Copy pdf.js runtime assets (CJK character maps, standard font data, JPEG2000/JBIG2
// decoders, ICC profiles) into public/ so the viewer can render every kind of PDF.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const dest = join(process.cwd(), 'public', 'pdfjs');
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
