import { describe, expect, it } from 'vitest';
import * as H from '../../src/core/history';
import * as Ops from '../../src/core/operations';
import type { Annotation, SourceDoc, WorkspaceState } from '../../src/core/types';
import { validateState } from '../../src/core/validation';

function source(id: string, n: number): SourceDoc {
  return {
    id,
    name: `${id}.pdf`,
    origin: 'pdf',
    blobId: `blob_${id}`,
    byteLength: 1000,
    pageCount: n,
    pages: Array.from({ length: n }, () => ({ width: 612, height: 792, rotation: 0 as const })),
  };
}

function ws(...docs: [string, number][]): WorkspaceState {
  let s = Ops.createWorkspace('t');
  for (const [id, n] of docs) {
    const src = source(id, n);
    s = Ops.addSources(s, [src]);
    s = Ops.insertPages(s, Ops.pagesFromSource(src), s.pages.length);
  }
  return s;
}

const labels = (s: WorkspaceState) => s.pages.map((p) => `${p.sourceId}${p.sourcePageIndex + 1}`);
const ink = (id: string): Annotation => ({ id, type: 'ink', points: [1, 1, 5, 5], color: '#ff0000', width: 2, opacity: 1 });

describe('page operations keep stable identity', () => {
  it('merges documents in order', () => {
    expect(labels(ws(['A', 3], ['B', 2]))).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
  });

  it('inserts at an exact position', () => {
    const s = ws(['A', 4]);
    const c = source('C', 2);
    const next = Ops.insertPages(Ops.addSources(s, [c]), Ops.pagesFromSource(c), 2);
    expect(labels(next)).toEqual(['A1', 'A2', 'C1', 'C2', 'A3', 'A4']);
  });

  it('moves pages by id before an anchor, keeping relative order', () => {
    const s = ws(['A', 6]);
    const [p1, , p3, , p5] = s.pages;
    const next = Ops.movePages(s, [p5.id, p1.id], p3.id);
    expect(labels(next)).toEqual(['A2', 'A1', 'A5', 'A3', 'A4', 'A6']);
  });

  it('moves page 10 to position 2 without detaching its annotations', () => {
    let s = ws(['A', 12]);
    const p10 = s.pages[9];
    s = Ops.addAnnotations(s, p10.id, [ink('an_x')]);
    s = Ops.movePagesToIndex(s, [p10.id], 1);
    expect(s.pages[1].id).toBe(p10.id);
    expect(s.pages[1].annotations.map((a) => a.id)).toEqual(['an_x']);
    expect(s.pages.filter((p) => p.annotations.length).length).toBe(1);
  });

  it('anchoring on a page that is itself moving uses the next unmoved page', () => {
    const s = ws(['A', 5]);
    const [p1, p2, p3] = s.pages;
    const next = Ops.movePages(s, [p2.id, p3.id], p2.id);
    expect(labels(next)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
    const n2 = Ops.movePages(s, [p1.id], null);
    expect(labels(n2)).toEqual(['A2', 'A3', 'A4', 'A5', 'A1']);
  });

  it('deleting a page deletes its annotations with it', () => {
    let s = ws(['A', 3]);
    s = Ops.addAnnotations(s, s.pages[1].id, [ink('an_1')]);
    s = Ops.deletePages(s, [s.pages[1].id]);
    expect(labels(s)).toEqual(['A1', 'A3']);
    expect(s.pages.flatMap((p) => p.annotations)).toHaveLength(0);
  });

  it('duplicates pages with independent annotation copies', () => {
    let s = ws(['A', 2]);
    s = Ops.addAnnotations(s, s.pages[0].id, [ink('an_orig')]);
    const { state, newIds } = Ops.duplicatePages(s, [s.pages[0].id]);
    expect(labels(state)).toEqual(['A1', 'A1', 'A2']);
    expect(state.pages[1].id).toBe(newIds[0]);
    expect(state.pages[1].annotations[0].id).not.toBe('an_orig');
    expect(validateState(state)).toEqual([]);
  });

  it('rotation accumulates and normalises', () => {
    let s = ws(['A', 1]);
    s = Ops.rotatePages(s, [s.pages[0].id], 90);
    s = Ops.rotatePages(s, [s.pages[0].id], 270);
    expect(s.pages[0].rotation).toBe(0);
    s = Ops.rotatePages(s, [s.pages[0].id], -90);
    expect(s.pages[0].rotation).toBe(270);
  });

  it('never mutates the input state', () => {
    const s = ws(['A', 3]);
    const frozen = JSON.stringify(s);
    Ops.deletePages(s, [s.pages[0].id]);
    Ops.movePages(s, [s.pages[2].id], s.pages[0].id);
    Ops.addAnnotations(s, s.pages[0].id, [ink('an_z')]);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('z-order and removal of annotations', () => {
    let s = ws(['A', 1]);
    const id = s.pages[0].id;
    s = Ops.addAnnotations(s, id, [ink('a'), ink('b'), ink('c')]);
    s = Ops.reorderAnnotations(s, id, ['a'], 'front');
    expect(s.pages[0].annotations.map((a) => a.id)).toEqual(['b', 'c', 'a']);
    s = Ops.reorderAnnotations(s, id, ['a'], 'backward');
    expect(s.pages[0].annotations.map((a) => a.id)).toEqual(['b', 'a', 'c']);
    s = Ops.removeAnnotations(s, [{ pageId: id, annotationId: 'b' }]);
    expect(s.pages[0].annotations.map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('prunes unused sources but history keeps them for undo', () => {
    const s = ws(['A', 1], ['B', 1]);
    let h = H.createHistory(s);
    const del = Ops.pruneSources(Ops.deletePages(s, [s.pages[1].id]));
    expect(Object.keys(del.sources)).toEqual(['A']);
    h = H.commit(h, del, 'Deleted');
    h = H.undo(h);
    expect(Object.keys(H.present(h).sources).sort()).toEqual(['A', 'B']);
    expect(labels(H.present(h))).toEqual(['A1', 'B1']);
  });
});

describe('history', () => {
  it('undo/redo walks the timeline and a new commit drops the redo branch', () => {
    const s0 = ws(['A', 3]);
    let h = H.createHistory(s0);
    const s1 = Ops.deletePages(s0, [s0.pages[0].id]);
    h = H.commit(h, s1, 'Delete');
    const s2 = Ops.rotatePages(s1, [s1.pages[0].id], 90);
    h = H.commit(h, s2, 'Rotate');
    expect(H.undoLabel(h)).toBe('Rotate');
    h = H.undo(h);
    expect(H.present(h)).toBe(s1);
    expect(H.redoLabel(h)).toBe('Rotate');
    h = H.commit(h, Ops.renameWorkspace(s1, 'x'), 'Rename');
    expect(H.canRedo(h)).toBe(false);
    expect(h.entries.map((e) => e.label)).toEqual(['Opened workspace', 'Delete', 'Rename']);
  });

  it('respects the history limit', () => {
    let s = ws(['A', 1]);
    let h = H.createHistory(s);
    for (let i = 0; i < 30; i++) {
      s = Ops.rotatePages(s, [s.pages[0].id], 90);
      h = H.commit(h, s, `r${i}`, 10);
    }
    expect(h.entries).toHaveLength(10);
    expect(H.present(h)).toBe(s);
  });
});

describe('validation', () => {
  it('rejects duplicate ids and dangling references', () => {
    const s = ws(['A', 2]);
    const bad = { ...s, pages: [s.pages[0], { ...s.pages[1], id: s.pages[0].id }] };
    expect(validateState(bad).join()).toMatch(/duplicate page id/);
    const dangling = { ...s, pages: [{ ...s.pages[0], sourcePageIndex: 9 }] };
    expect(validateState(dangling).join()).toMatch(/outside/);
  });
});
