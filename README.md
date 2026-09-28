# PDF Workspace

A browser-based PDF workspace. Import PDFs and images, then merge, reorder, insert, delete,
rotate, compress, annotate and sign — **all on one live document** — and download the
finished PDF only when you are done. Nothing is uploaded: every file stays in your browser.

Unlike one-shot tools (merge → download → re-upload → compress → download → …), every
operation here edits the same workspace, in any order, as many times as you like, with one
undo history across everything.

## Using it

| To… | Do this |
|---|---|
| Start | Drop PDFs or images on the start screen, or **Choose files**. Several files are merged in the order you pick them. |
| Add more | **Add files** (appends), or drop files onto the page list *between two pages* to insert them exactly there. |
| Insert at a position | **Insert ▸ PDF pages / Images / Blank page**, the **+** that appears between thumbnails, or right-click a page ▸ *Insert before/after*. The dialog shows the other file's pages so you can pick all or some (`1-3, 5`). |
| Select pages | Click; **Ctrl/⌘-click** to add; **Shift-click** for a range; **Ctrl/⌘ A** for all. |
| Reorder | Drag thumbnails (the **Organize** view shows a big grid), or **Alt + ↑/↓**. |
| Delete / rotate / duplicate | Toolbar buttons, the hover buttons on each thumbnail, the right-click menu, or **Delete**. Every action can be undone. |
| Replace a page | Right-click ▸ *Replace page…* |
| Download some pages | Select them ▸ **More ▸ Download pages as a new PDF** (the workspace is unchanged). |
| Move pages to another workspace | **More ▸ Copy / move to another workspace…** |
| Compress | **Compress** ▸ Lossless / Balanced / Strong. You keep editing the compressed document; **Undo** reverts it. |
| Annotate | Pick a tool: Text, Pen, Marker, Eraser, Highlight, Underline, Strikethrough, Rectangle, Ellipse, Line, Arrow, Whiteout, Sticky note, Image, **Sign**. Options (colour — red is a preset — thickness, opacity, font, size, bold, italic, alignment) appear under the toolbar. |
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

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the document model, the operation/history
design, rendering, compression, export and the known limitations.
