/**
 * User-facing error with a stable code. Every failure the UI can show goes through
 * this type so the message says WHAT failed and nothing is silently dropped.
 */
export type ErrorCode =
  | 'PDF_PARSE'
  | 'PDF_ENCRYPTED'
  | 'PDF_EMPTY'
  | 'IMAGE_DECODE'
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_LARGE'
  | 'EXPORT_FAILED'
  | 'COMPRESS_FAILED'
  | 'RENDER_FAILED'
  | 'STORAGE_FAILED'
  | 'STATE_INVALID'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class WorkspaceError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.detail = detail;
  }
}

export function toWorkspaceError(err: unknown, fallback: ErrorCode, context: string): WorkspaceError {
  if (err instanceof WorkspaceError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new WorkspaceError(fallback, context, detail);
}

/** Serializable form, used to carry errors across the worker boundary. */
export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  detail?: string;
}

export function errorToPayload(err: unknown): ErrorPayload {
  const e = toWorkspaceError(err, 'INTERNAL', 'Unexpected error');
  return { code: e.code, message: e.message, detail: e.detail };
}

export function payloadToError(p: ErrorPayload): WorkspaceError {
  return new WorkspaceError(p.code, p.message, p.detail);
}
