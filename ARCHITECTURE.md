# Architecture

## The one idea

The workspace is **one canonical document state**. Every feature — merge, insert, delete,
reorder, rotate, duplicate, replace, compress, annotate — is a pure function from one state
to the next. Nothing produces an intermediate PDF. The final PDF is generated from the state
only when the user downloads it.

```
 files ──ingest──▶ SOURCES (immutable PDF bytes in the blob store)
                        ▲
 state = { sources, pages: [ {id, sourceId, sourcePageIndex, rotation, annotations[]} ], meta }
                        │
   operations.ts  (pure: state → state)      history.ts (linear timeline of states)
                        │
   render (pdf.js)  ◀───┴───▶  export (pdf-lib): copy pages + draw annotations → PDF
```

### Why it can be chained forever

* **Stable ids, never indexes.** Every page has an id. Moving page 10 to position 2 moves an
  object; its annotations, rotation and source reference travel with it. Operations take ids
  (`movePages(ids, beforeId)`), so nothing can attach to the wrong page after a reorder.
* **Sources are immutable.** Pages reference `(sourceId, pageIndex)` into validated PDFs.
  Images and blank pages are converted to one-page PDFs on ingest, so there is exactly one
  kind of page.
* **Annotations are overlays in page space** (points, top-left origin of the *unrotated*
  page). They are independent of zoom and view rotation, so they survive reordering,
  rotation, duplication and compression untouched, and stay editable until export.
* **Compression swaps source bytes, not pages.** `compress` produces a new PDF per source
  with *the same pages in the same order and geometry* (verified before it is accepted) and
  points the source at it. Page ids, order, rotation and annotations are unaffected, so the
  user simply keeps editing — and Undo restores the previous bytes.

### Undo/redo

`history.ts` keeps a timeline of immutable states. Because operations never mutate,
consecutive states share every unchanged page and annotation object, so hundreds of steps
cost little memory. Binary data lives in the blob store and is referenced by id. Page
operations and annotation edits share **one** history. Bursts of small edits (typing, style
sliders, nudging) are coalesced into a single step. Every commit passes
`validateState()` (unique ids, valid references, finite geometry); an invalid state is
rejected before it can reach history, storage or export.

## Modules

| Concern | Module |
|---|---|
| Model types | `src/core/types.ts` |
| Operations (pure) | `src/core/operations.ts` |
| Undo/redo | `src/core/history.ts` |
| Invariants | `src/core/validation.ts` |
| Coordinates (page ↔ display ↔ PDF), hit testing | `src/core/geometry.ts` |
| Stroke smoothing (shared by screen and PDF) | `src/core/paths.ts` |
| Errors with user-facing messages | `src/core/errors.ts` |
| PDF parsing, decryption, image → page | `src/engine/ingest.ts`, `imageInfo.ts` |
| Browser image decoding (WebP, GIF, BMP, TIFF, AVIF…) | `src/engine/browserImages.ts` |
| Compression | `src/engine/compress.ts`, `predictor.ts`, `browserCodec.ts` |
| Export | `src/engine/export.ts` |
| Text layout (shared by screen and PDF) | `src/engine/textLayout.ts` |
| Background worker | `src/workers/*` |
| Rendering, thumbnails, caches | `src/render/pdfRender.ts` |
| Controller (the only writer of state) | `src/store/controller.ts` |
| Persistence (IndexedDB), workspaces | `src/persistence/idb.ts`, `src/store/session.ts` |
| UI | `src/ui/**` |

`WorkspaceController` has no React or DOM dependency: the unit tests drive exactly the code
the app runs. The heavy PDF work runs behind the `EngineApi` interface — in a Web Worker in
the browser, in-process in tests.

## Libraries

| Library | Used for | Why |
|---|---|---|
| **pdf.js** (`pdfjs-dist`, Mozilla) | rendering, thumbnails | The reference open-source renderer; handles scans, JPEG2000/JBIG2, CJK fonts, broken files. The *legacy* build is used so older browsers work too. |
| **@cantoo/pdf-lib** | parsing, copying pages, drawing annotations, saving | Actively maintained fork of pdf-lib (the original has not been released since 2022) with decryption support and fixes. |
| **fflate** | Flate (de)compression in the compressor | Fast, small, already a pdf-lib dependency. |
| **utif** | TIFF decoding | Browsers cannot decode TIFF. |
| React 19 + Vite | UI and build | No state or UI framework beyond React; the model is plain TypeScript. |

## Quality: nothing is rasterized

* Export **copies** each original page object (`copyPages`), so text stays text, vectors stay
  vectors, fonts and images are carried over byte-for-byte. Annotations are added as vector
  drawing operators (text uses the PDF standard fonts; sticky notes become real `/Text`
  comments), after isolating the original content stream so it cannot distort them.
* Images added as pages embed the **original JPEG/PNG bytes** (EXIF orientation applied with
  the placement matrix — no re-encode). Other formats become lossless PNG.
* The on-screen text uses the same layout function and font metrics as the exporter, so line
  breaks match exactly. The browser test `fidelity.spec.ts` compares the editor with the
  exported pages pixel by pixel (≤ 0.01 % difference, rotated pages included).

## Performance

* The viewer mounts only the pages near the viewport; pages render at device resolution
  (capped at 16 MP per canvas) and renders are cancelled when the user scrolls away.
* Thumbnails render lazily through a priority queue (newest request first, 2 at a time) into
  an LRU cache keyed by `(blob, page, rotation)`, so reordering never re-renders anything.
  Off-screen thumbnails are skipped by the browser (`content-visibility: auto`).
* pdf.js documents are kept in an LRU and closed on eviction. Blob bytes have an LRU cache
  (256 MB) over IndexedDB.
* Parsing, compression and export run in a Web Worker.
* Measured (Chromium): a 300-page file loads in ~1 s, jumps to page 250 in ~0.5 s, exports in
  ~1.5 s; 600 pages merge, reorder and export in the Node test in a few seconds.

## Persistence

IndexedDB stores the workspace record (state **and** undo history — structured clone keeps
shared objects shared) and the blobs, namespaced per workspace. Saves are debounced (400 ms)
and flushed when the tab is hidden. On open, blobs no longer referenced by any state in the
saved history are garbage-collected. A corrupted record falls back to its last valid state.

## Known limitations (and what the app does about them)

* **Whiteout is not redaction.** It covers content visually; the text underneath is still in
  the file. The tool says so. Secure redaction requires removing content from the page's
  content stream, which cannot be done reliably for arbitrary PDFs in the browser.
* **Text annotations use the 14 standard PDF fonts** (Helvetica, Times, Courier and their
  bold/italic variants). Characters outside Windows-1252 (e.g. CJK, emoji) are exported as
  `?`; the editor warns while typing. Embedding a Unicode font is a planned extension.
* **Form fields and links of original pages** are copied with the page, but interactive
  forms (AcroForm) are not merged across documents.
* **Compression** re-encodes photos (JPEG and 8-bit RGB/gray Flate images). CMYK/Indexed
  images, masks, and line-art-like images are left untouched to avoid artifacts. Vector
  content and fonts are never modified.
* **Password-protected PDFs** are decrypted on import (the user types the password) and
  stored decrypted in the browser.
* **HEIC** photos only work in browsers that can decode them (Safari).
* Storage is per browser. Clearing site data removes saved workspaces; download to keep a
  copy.

## Tests

* `tests/unit` (Vitest, Node): operations and history, ingest/decrypt/images/EXIF, export
  (order, rotation, colours, pen widths, notes, duplicates), compression, **the full
  specified chained workflow** at controller level, randomized merge/insert/delete/reorder/
  compress cycles, and a 600-page document.
* `tests/e2e` (Playwright, real Chromium): **the full chained workflow through the UI** (merge
  → delete → insert PDF → insert JPG → reorder → compress → zoom → red text → 5 px / 2 px pen
  → shapes → undo/redo → organizer edits → export → reopen and verify → reload), annotation
  editing, eraser, copy/paste, markup/notes/images/signatures, organizer operations, file
  drops at an exact position, WebP/TIFF, errors (damaged, unsupported, password), a
  300-page document, multiple workspaces, and editor-vs-export pixel fidelity.
