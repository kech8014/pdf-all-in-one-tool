import { memo, useEffect, useState } from 'react';
import { NOTE_SIZE, localSize, localToPageMatrix } from '../../core/geometry';
import { arrowHead, arrowShaftEnd, segsToSvg, smoothStroke } from '../../core/paths';
import { inkOutline, outlineSvg } from '../../core/ink';
import type { Annotation, BlobId } from '../../core/types';
import { CSS_FONT, layoutText } from '../../engine/textLayout';

/**
 * SVG rendering of one annotation in PAGE SPACE. The parent <g> applies the page's
 * display transform, so this component never needs to know the zoom or rotation.
 * The text path uses the same layout function as the PDF exporter.
 */

const blobUrls = new Map<BlobId, string>();
const pendingUrls = new Map<BlobId, Promise<string>>();
let blobLoader: ((id: BlobId) => Promise<Uint8Array>) | null = null;
export function setAnnotationBlobLoader(fn: (id: BlobId) => Promise<Uint8Array>) {
  blobLoader = fn;
}

export function useBlobUrl(blobId: BlobId, mime: string): string | null {
  const [url, setUrl] = useState(() => blobUrls.get(blobId) ?? null);
  useEffect(() => {
    if (blobUrls.has(blobId)) {
      setUrl(blobUrls.get(blobId)!);
      return;
    }
    if (!blobLoader) return;
    let alive = true;
    let p = pendingUrls.get(blobId);
    if (!p) {
      const loader = blobLoader;
      p = loader(blobId).then((bytes) => {
        const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        blobUrls.set(blobId, u);
        return u;
      });
      pendingUrls.set(blobId, p);
    }
    p.then((u) => alive && setUrl(u)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [blobId, mime]);
  return url;
}

function ImageShape({ a }: { a: Extract<Annotation, { type: 'image' }> }) {
  const url = useBlobUrl(a.blobId, a.mime);
  const { w, h } = localSize(a.rect, a.rotation);
  const m = localToPageMatrix(a.rect, a.rotation);
  return (
    <g transform={`matrix(${m.join(' ')})`} opacity={a.opacity}>
      {url ? <image href={url} x={0} y={0} width={w} height={h} preserveAspectRatio="none" /> : <rect width={w} height={h} fill="#e5e7eb" />}
    </g>
  );
}

export function TextShape({ a, hidden }: { a: Extract<Annotation, { type: 'text' }>; hidden?: boolean }) {
  const { w, h } = localSize(a.rect, a.rotation);
  const m = localToPageMatrix(a.rect, a.rotation);
  const layout = layoutText({ ...a, boxWidth: w });
  return (
    <g transform={`matrix(${m.join(' ')})`} opacity={hidden ? 0 : a.opacity}>
      {a.background && <rect width={w} height={h} fill={a.background} />}
      <text
        fill={a.color}
        fontFamily={CSS_FONT[a.fontFamily]}
        fontSize={a.fontSize}
        fontWeight={a.bold ? 700 : 400}
        fontStyle={a.italic ? 'italic' : 'normal'}
        style={{ whiteSpace: 'pre' }}
      >
        {layout.lines.map((l, i) => (
          <tspan key={i} x={l.x} y={l.baseline} textLength={l.text.trim() ? l.width : undefined} lengthAdjust="spacingAndGlyphs">
            {l.text}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function NoteShape({ a }: { a: Extract<Annotation, { type: 'note' }> }) {
  const s = NOTE_SIZE;
  return (
    <g transform={`translate(${a.x} ${a.y})`} opacity={a.opacity}>
      <path d={`M1 1h${s - 2}v${s * 0.7}H${s * 0.45}L${s * 0.2} ${s - 1}V${s * 0.7 + 1}H1z`} fill={a.color} stroke="#7a5b00" strokeWidth={1} strokeLinejoin="round" />
      <path d={`M${s * 0.22} ${s * 0.28}h${s * 0.56}M${s * 0.22} ${s * 0.46}h${s * 0.4}`} stroke="#7a5b00" strokeWidth={1.2} strokeLinecap="round" />
    </g>
  );
}

export const AnnotationShape = memo(function AnnotationShape({ a, hidden }: { a: Annotation; hidden?: boolean }) {
  if (hidden && a.type !== 'text') return null;
  switch (a.type) {
    case 'ink': {
      const outline = inkOutline(a);
      if (outline) return <path d={outlineSvg(outline)} fill={a.color} opacity={a.opacity} />;
      return (
        <path
          d={segsToSvg(smoothStroke(a.points))}
          fill="none"
          stroke={a.color}
          strokeWidth={a.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={a.opacity}
        />
      );
    }
    case 'line': {
      if (a.style === 'arrow') {
        const [ex, ey] = arrowShaftEnd(a.x1, a.y1, a.x2, a.y2, a.width);
        const head = arrowHead(a.x1, a.y1, a.x2, a.y2, a.width);
        return (
          <g opacity={a.opacity}>
            <line x1={a.x1} y1={a.y1} x2={ex} y2={ey} stroke={a.color} strokeWidth={a.width} strokeLinecap="round" />
            <polygon points={head.map((p) => p.join(',')).join(' ')} fill={a.color} />
          </g>
        );
      }
      return <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={a.color} strokeWidth={a.width} opacity={a.opacity} />;
    }
    case 'shape': {
      const { x, y, w, h } = a.rect;
      const common = {
        fill: a.fillColor ?? 'none',
        stroke: a.strokeWidth > 0 ? a.strokeColor : 'none',
        strokeWidth: a.strokeWidth,
        opacity: a.opacity,
      };
      return a.shape === 'rect' ? <rect x={x} y={y} width={w} height={h} {...common} /> : <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    }
    case 'highlight':
      return <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} fill={a.color} opacity={a.opacity} style={{ mixBlendMode: 'multiply' }} />;
    case 'whiteout':
      return <rect x={a.rect.x} y={a.rect.y} width={a.rect.w} height={a.rect.h} fill={a.color} opacity={a.opacity} />;
    case 'text':
      return <TextShape a={a} hidden={hidden} />;
    case 'image':
      return <ImageShape a={a} />;
    case 'note':
      return <NoteShape a={a} />;
  }
});
