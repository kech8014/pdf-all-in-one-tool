import { getPage } from '../../core/operations';
import type { WorkspaceController } from '../../store/controller';
import { ui } from '../uiStore';

/**
 * Finish editing the text box / sticky note in progress. New, empty drafts are dropped
 * (clicking with the text tool and clicking away creates nothing); an existing one
 * emptied by the user is deleted. Exactly one undo step is recorded.
 */
export function commitEditDraft(ctl: WorkspaceController) {
  const d = ui.get().editDraft;
  if (!d) return;
  ui.set({ editDraft: null });
  const empty = !d.ann.text.trim();
  const page = getPage(ctl.state, d.pageId);
  if (!page) return;
  const kind = d.ann.type === 'text' ? 'text' : 'note';
  if (d.isNew) {
    if (empty) return;
    ctl.addAnnotation(d.pageId, d.ann, kind === 'text' ? 'Added text' : 'Added note');
    ui.set({ selectedAnns: { pageId: d.pageId, ids: [d.ann.id] } });
    return;
  }
  const original = page.annotations.find((a) => a.id === d.ann.id);
  if (!original) return;
  if (empty) {
    ctl.removeAnnotations([{ pageId: d.pageId, annotationId: d.ann.id }], kind === 'text' ? 'Deleted empty text' : 'Deleted empty note');
    ui.set({ selectedAnns: null });
    return;
  }
  if (JSON.stringify(original) !== JSON.stringify(d.ann)) {
    ctl.updateAnnotations(d.pageId, [d.ann], kind === 'text' ? 'Edited text' : 'Edited note');
  }
}

export function cancelEditDraft() {
  if (ui.get().editDraft) ui.set({ editDraft: null });
}
