/** Stable, collision-resistant identifiers. Pages are never addressed by index internally. */
export function newId(prefix: 'ws' | 'src' | 'pg' | 'an' | 'blob'): string {
  const c = globalThis.crypto;
  const raw =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID().replace(/-/g, '')
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${prefix}_${raw.slice(0, 20)}`;
}
