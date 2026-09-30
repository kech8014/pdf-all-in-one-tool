# PDF — all-in-one PDF workspace

A browser-based PDF workspace. Import PDFs and images, then merge, reorder, insert, delete,
rotate, compress, annotate and sign — **all on one live document** — and download the
finished PDF only when you are done. Nothing is uploaded: every file stays in your browser.

Unlike one-shot tools (merge → download → re-upload → compress → download → …), every
operation here edits the same workspace, in any order, as many times as you like, with one
undo history across everything.

## Using it

| To… | Do this |
|---|---|
| Start | Drop PDFs or images on the start screen, or **Choose files**. With several files you land on **Organize PDFs** first: one card per file — drag the cards (or use the arrows) to decide which file comes first, remove a file, then **Save order — show pages**. Adding more PDFs later (Add files, drag & drop) opens this view again. |
| Switch views | **Edit** (annotate), **Organize pages** (page grid), **Organize PDFs** (whole files) — top right. |
| Add more | **Add files** (appends). Click the green **+** between two pages to pick files and insert them exactly there (right-click the **+** for a blank page or to pick only some pages), or drop files onto that spot. |
| Insert at a position | **Insert ▸ PDF pages / Images / Blank page**, the **+** that appears between thumbnails, or right-click a page ▸ *Insert before/after*. The dialog shows the other file's pages so you can pick all or some (`1-3, 5`). |
| Select pages | Click; **Ctrl/⌘-click** to add; **Shift-click** for a range; **Ctrl/⌘ A** for all. |
| Reorder | Drag thumbnails (the **Organize** view shows a big grid), or **Alt + ↑/↓**. |
| Delete / rotate / duplicate | Toolbar buttons, the hover buttons on each thumbnail, the right-click menu, or **Delete**. Every action can be undone. |
| Replace a page | Right-click ▸ *Replace page…* |
| Download some pages | Select them ▸ **More ▸ Download pages as a new PDF** (the workspace is unchanged). |
| Move pages to another workspace | **More ▸ Copy / move to another workspace…** |
| Compress | Automatic: **Download PDF** shows "Auto-compressing…" and saves the smaller file (photos at 150 DPI; text and drawings stay vector). The dialog's *File size* option offers lossless, smallest, or none. Your workspace keeps the originals. |
| Annotate | Pick a tool: Text, Pen, Marker, Eraser, Highlight, Underline, Strikethrough, Rectangle, Ellipse, Line, Arrow, Whiteout, Sticky note, Image, **Sign**. Options (colour — red is a preset — thickness, opacity, font, size, bold, italic, alignment) appear under the toolbar. |
| Clean drawing | Pen and marker strokes are smoothed as you draw. **Smart shapes** (pen options): *Auto* straightens lines (snapping to 0°/45°/90° when close) and turns a circle, ellipse, rectangle or triangle drawn on its own into a perfect one; handwriting is never turned into shapes. Hold still for half a second at the end of any stroke to snap it on demand — this also gives perfect arcs and angles. *Hold* snaps only on hold; *Off* never snaps. |
| Handwriting → text | Write with the Pen, then **Auto detect**: the handwriting on the page (or just the strokes you selected) becomes typed, editable text in the same place, size and colour. Drawings and ticks are left as they are. One **Undo** brings the handwriting back. |
| Edit an annotation | **Select** tool: click to select, drag to move, drag the handles to resize, double-click text to edit it, **Delete** to remove. **Ctrl/⌘ C / V / D** copy, paste (onto any page), duplicate. **Ctrl/⌘ ] / [** bring to front / send to back. |
| Zoom | The zoom bar (type any %, or Fit width / Fit page), **Ctrl/⌘ + scroll**, **Ctrl/⌘ + / −**. Hold **Space** and drag (or use the Pan tool) to move around. |
| Undo anything | **Ctrl/⌘ Z** / **Ctrl/⌘ Shift Z**, or open **History** and click any earlier step. |
| Finish | **Download PDF**. The workspace stays open — download again any time. |

Work is saved automatically in the browser (IndexedDB) after every change, including the
undo history, so a refresh or a closed tab loses nothing. **Workspaces** (top-left) lists
everything saved in this browser. Press **?** for all keyboard shortcuts.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build in dist/
npm test             # unit + engine tests (Node)
npm run test:e2e     # browser tests (Playwright/Chromium)
```

Node 22+. Deploys as a static site (Vercel, Netlify, any static host): build command
`npm run build`, output directory `dist`.

### Handwriting recognition

**Auto detect** reads handwriting with Claude's vision model through the serverless
function `api/handwriting.ts` (deployed automatically on Vercel). Set the environment
variable **`ANTHROPIC_API_KEY`** in the Vercel project (Settings → Environment Variables)
to enable it; `HANDWRITING_MODEL` optionally overrides the model. Only an image of the pen
strokes is sent — never the PDF. Without a key (or when running `npm run dev`), the app
falls back to on-device OCR (Tesseract, loaded on first use), which reads neat print but
is much weaker on joined-up handwriting.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the document model, the operation/history
design, rendering, compression, export and the known limitations.
