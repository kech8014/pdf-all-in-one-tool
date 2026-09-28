export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export const PRESET_COLORS = [
  { name: 'Red', value: '#e11d2a' },
  { name: 'Black', value: '#111111' },
  { name: 'Blue', value: '#1d4ed8' },
  { name: 'Green', value: '#15803d' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Purple', value: '#7e22ce' },
  { name: 'White', value: '#ffffff' },
] as const;

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', value: '#ffe14d' },
  { name: 'Green', value: '#7ee787' },
  { name: 'Blue', value: '#79c0ff' },
  { name: 'Pink', value: '#ff9bd2' },
  { name: 'Orange', value: '#ffb366' },
] as const;
