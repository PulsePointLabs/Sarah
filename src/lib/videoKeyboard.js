// Android external keyboards may provide key but leave code empty/Unidentified.
// Keep physical keypad codes when available, and recover ordinary shortcuts
// without converting composition or modified text into playback commands.
export function videoShortcutCode(event = {}) {
  if (event.isComposing || event.keyCode === 229) return '';
  if (event.code && event.code !== 'Unidentified') return event.code;
  const key = event.key || '';
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `${event.location === 3 ? 'Numpad' : 'Digit'}${key}`;
  const names = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };
  if (names[key]) return names[key];
  if (/^(Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Enter)$/.test(key)) return key;
  const legacy = Number(event.keyCode || event.which);
  if (legacy >= 65 && legacy <= 90) return `Key${String.fromCharCode(legacy)}`;
  if (legacy >= 48 && legacy <= 57) return `Digit${legacy - 48}`;
  if (legacy >= 96 && legacy <= 105) return `Numpad${legacy - 96}`;
  return ({ 27:'Escape', 32:'Space', 37:'ArrowLeft', 38:'ArrowUp', 39:'ArrowRight', 40:'ArrowDown', 107:'NumpadAdd', 109:'NumpadSubtract' })[legacy] || '';
}
