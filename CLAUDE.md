# Working on PDF Workspace

Read `ARCHITECTURE.md` first. The rules that keep the design intact:

1. **State changes only through `WorkspaceController.apply()`** (via its methods). Never mutate
   state; write a pure function in `src/core/operations.ts` and call it from the controller.
2. **Address pages and annotations by id**, never by index captured before an operation.
3. **Never rasterize or regenerate a PDF to perform an edit.** Sources are immutable; the final
   PDF is built only in `src/engine/export.ts`.
4. **Annotations live in page space** (points, top-left of the unrotated page). Use
   `src/core/geometry.ts` for every conversion.
5. **Screen and export share code**: text layout (`engine/textLayout.ts`) and stroke smoothing
   (`core/paths.ts`). Change them together or the fidelity test fails.
6. **Every user-visible failure is a `WorkspaceError`** with a message that says what failed.
7. **Test the chain, not just the feature**: extend `tests/unit/workflow.test.ts` and
   `tests/e2e/workflow.spec.ts` when adding an operation.

Commands: `npm test` (unit), `npm run test:e2e` (browser), `npm run typecheck`, `npm run build`.
