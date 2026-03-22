import { InlineKeyboard, Keyboard } from "grammy";

export function toRows<T>(flat: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < flat.length; i += size) {
    rows.push(flat.slice(i, i + size));
  }
  return rows;
}

export function toggleGrid(
  presets: string[],
  selected: Set<string> | string[],
  callbackPrefix: string,
  perRow: number,
  caseSensitive = true,
): InlineKeyboard {
  const raw = Array.isArray(selected) ? selected : [...selected];
  const set = new Set(caseSensitive ? raw : raw.map((s) => s.toLowerCase()));
  const isOn = (item: string) => set.has(caseSensitive ? item : item.toLowerCase());
  const kb = new InlineKeyboard();
  for (const row of toRows(presets, perRow)) {
    for (const p of row) kb.text(isOn(p) ? `\u2705 ${p}` : p, `${callbackPrefix}:${p}`);
    kb.row();
  }
  return kb;
}

export function replyKb(paused: boolean): Keyboard {
  return new Keyboard()
    .text("\u2699\ufe0f Settings")
    .text(paused ? "\u25b6 Resume" : "\u23f8 Pause")
    .row()
    .text("\ud83d\udcca Activity")
    .text("\ud83d\udd0c Sources")
    .resized();
}
