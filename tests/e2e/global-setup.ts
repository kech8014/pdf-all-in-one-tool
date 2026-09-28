import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bigPdf, jpegBytes, labelledPdf, photoPdf, pngBytes } from '../fixtures/make';

export const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'out');

export default async function globalSetup() {
  mkdirSync(FIXTURES, { recursive: true });
  const w = (name: string, bytes: Uint8Array) => writeFileSync(join(FIXTURES, name), bytes);
  w('A.pdf', await labelledPdf('A', 8, { sizes: [[612, 792], [842, 595]] }));
  w('B.pdf', await labelledPdf('B', 6, { sizes: [[595, 842]], rotate: [0, 90] }));
  w('C.pdf', await photoPdf('C'));
  w('D.pdf', await labelledPdf('D', 3));
  w('E.pdf', await labelledPdf('E', 2));
  w('scan.jpg', jpegBytes(1200, 1600, 90));
  w('logo.png', pngBytes(240, 120));
  w('big.pdf', await bigPdf('L', 300));
  w('broken.pdf', new TextEncoder().encode('%PDF-1.7\nthis is not really a pdf'));
}
