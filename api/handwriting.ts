/**
 * Vercel Function: handwriting recognition for the "Auto detect" button.
 *
 *   GET  /api/handwriting            -> { ai: boolean }   (is a recogniser configured?)
 *   POST /api/handwriting { images } -> { texts: string[] }
 *
 * Each image is a PNG (base64, no data: prefix) of ONE block of handwriting, rendered
 * black on white by the browser. The images are transcribed by Claude's vision model.
 * Only the rendered strokes are sent — never the PDF.
 *
 * Needs the environment variable ANTHROPIC_API_KEY (Vercel -> Project -> Settings ->
 * Environment Variables). Without it GET answers { ai: false } and the browser falls back
 * to on-device OCR. HANDWRITING_MODEL optionally overrides the model.
 */

const MODEL = process.env.HANDWRITING_MODEL || 'claude-sonnet-5-5';
const MAX_IMAGES = 16;
const MAX_IMAGE_B64 = 1_500_000;

const PROMPT = [
  'This image contains handwriting, drawn with a pen on a document.',
  'Transcribe it exactly as written: keep the words, spelling, numbers, punctuation and capitalisation, and keep line breaks where the writer started a new line.',
  'Output ONLY the transcribed text, with no quotes, labels or commentary.',
  'If the image contains no writing (for example a tick, a scribble, an arrow, a circle or a drawing), output exactly: <none>',
].join(' ');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Refuse cross-site callers so the key cannot be used by other websites. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function transcribe(key: string, png: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`recogniser returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
}

export function GET() {
  return json({ ai: !!process.env.ANTHROPIC_API_KEY });
}

export async function POST(request: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: 'Handwriting recognition is not configured on the server.' }, 501);
  if (!sameOrigin(request)) return json({ error: 'Forbidden' }, 403);
  let images: unknown;
  try {
    images = ((await request.json()) as { images?: unknown }).images;
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES || !images.every((i) => typeof i === 'string' && i.length < MAX_IMAGE_B64)) {
    return json({ error: 'Invalid request' }, 400);
  }
  try {
    const texts = await Promise.all((images as string[]).map((png) => transcribe(key, png)));
    return json({ texts });
  } catch (e) {
    console.error('handwriting', e);
    return json({ error: 'The handwriting recogniser is unavailable. Please try again.' }, 502);
  }
}
