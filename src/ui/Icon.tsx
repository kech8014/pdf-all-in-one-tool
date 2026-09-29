import type { SVGProps } from 'react';

/** Stroke icons on a 24x24 grid (drawn for this app; no icon dependency). */
const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  sparkle: 'M12 3c.8 4.6 4.4 8.2 9 9-4.6.8-8.2 4.4-9 9-.8-4.6-4.4-8.2-9-9 4.6-.8 8.2-4.4 9-9z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  minus: 'M5 12h14',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  filePlus: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 9.5h.01',
  blank: 'M6 3h12v18H6z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  download: 'M12 4v12M7 11l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  // A page with a curved arrow over it: reads as "rotate this page", not "undo".
  rotateLeft: 'M10 11h10v10H10zM14 4h-3a7 7 0 0 0-7 7v2M1 10l3 3 3-3',
  rotateRight: 'M4 11h10v10H4zM10 4h3a7 7 0 0 1 7 7v2M17 10l3 3 3-3',
  wand: 'M4 20L15 9M13 7l2-2 4 4-2 2zM18 2v3M16.5 3.5h3M21 13v3M19.5 14.5h3M7 3v3M5.5 4.5h3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  extract: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 3v5h5V11M16 15h6M19 12l3 3-3 3',
  replace: 'M4 7h12l-3-3M20 17H8l3 3M4 7v4M20 17v-4',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  compress: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  cursor: 'M5 3l14 8-6 2-2 6z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-7a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v6M17 10.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.5-2.7L3.3 15.7a1.6 1.6 0 0 1 2.4-2.1L8 16',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  pen: 'M3 21l3.8-1 11.7-11.7a2.1 2.1 0 0 0-3-3L3.8 17z M13.5 6.5l3 3',
  marker: 'M9 11l-5 5v4h4l5-5M9 11l6-6 4 4-6 6M9 11l4 4',
  eraser: 'M7 21h13M4.5 14.5l9.9-9.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18H7.5z',
  highlight: 'M4 20h16M6 16l3-9h6l3 9M8 12h8',
  underline: 'M6 4v7a6 6 0 0 0 12 0V4M4 21h16',
  strikeout: 'M16 5.5A4 4 0 0 0 12 4c-2.5 0-4 1.3-4 3.2 0 1.6 1 2.3 3 2.8M4 12h16M8 18.5A4.5 4.5 0 0 0 12 20c2.5 0 4.2-1.4 4.2-3.4 0-1-.4-1.8-1.2-2.6',
  rect: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M10 5h9v9',
  whiteout: 'M4 6h16v12H4zM8 10h8M8 14h5',
  note: 'M4 4h16v12H9l-5 4z',
  signature: 'M3 17c2-4 3.5-8 5-8s0 7 2 7 2-4 3.5-4 1 3 2.5 3S19 13 21 13M3 21h18',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8 11h6',
  fitWidth: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
  fitPage: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  front: 'M8 8h12v12H8zM4 16V4h12',
  back: 'M4 4h12v12H4zM8 20h12V8',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M10 4h8M6 20h8M14 4l-4 16',
  alignLeft: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignCenter: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignRight: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  logo: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 12h6M9 16h6M9 8h3',
};

export type IconName = keyof typeof PATHS;

/**
 * Colour family of each action, so buttons can be told apart at a glance: page layout
 * (rotate, move) is blue, adding is green, destructive is red, copies are violet, file
 * size is amber, text is indigo, and so on. Buttons use it as a tinted background chip.
 */
export type Tone = 'blue' | 'green' | 'red' | 'violet' | 'amber' | 'teal' | 'indigo' | 'pink' | 'slate' | 'yellow';
export const TONE: Partial<Record<IconName, Tone>> = {
  plus: 'green',
  filePlus: 'green',
  image: 'green',
  blank: 'green',
  upload: 'green',
  download: 'green',
  rotateLeft: 'blue',
  rotateRight: 'blue',
  move: 'blue',
  grid: 'blue',
  sidebar: 'slate',
  copy: 'violet',
  extract: 'violet',
  replace: 'violet',
  trash: 'red',
  eraser: 'pink',
  compress: 'amber',
  history: 'amber',
  undo: 'slate',
  redo: 'slate',
  help: 'slate',
  more: 'slate',
  cursor: 'slate',
  hand: 'slate',
  text: 'indigo',
  edit: 'indigo',
  bold: 'indigo',
  italic: 'indigo',
  alignLeft: 'indigo',
  alignCenter: 'indigo',
  alignRight: 'indigo',
  pen: 'blue',
  marker: 'amber',
  highlight: 'yellow',
  underline: 'violet',
  strikeout: 'violet',
  rect: 'teal',
  ellipse: 'teal',
  line: 'teal',
  arrow: 'teal',
  whiteout: 'slate',
  note: 'amber',
  signature: 'indigo',
  wand: 'pink',
  sparkle: 'pink',
  front: 'teal',
  back: 'teal',
  zoomIn: 'slate',
  zoomOut: 'slate',
  fitWidth: 'slate',
  fitPage: 'slate',
  folder: 'blue',
};
export const toneClass = (name: IconName) => (TONE[name] ? `tone tone-${TONE[name]}` : '');

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
