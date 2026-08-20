// 面板前端 · 内联 SVG 图标集（描边风格仿 SF Symbols：24 viewBox、stroke=currentColor、
// fill none、stroke-width 1.8、round caps/joins）。无外部图标库，离线可用。
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20l1.2-4.2L16.6 4.4a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z"/><path d="M14.5 6.5l3 3"/>',
  trash: '<path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l1 12.5h9l1-12.5M10 11v5.5M14 11v5.5"/>',
  bolt: '<path d="M13 2.5 5 13.5h5.5L11 21.5l8-11h-5.5L13 2.5z"/>',
  grip: '<circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.5" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  xmark: '<path d="M6 6l12 12M18 6L6 18"/>',
  qrcode: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zM20 14v3M17 20h3v-3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 16z"/><path d="M10.3 21a1.7 1.7 0 0 0 3.4 0"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  sliders: '<path d="M4 8h10M17.5 8H20M4 16h4M11.5 16H20"/><circle cx="15.5" cy="8" r="1.8"/><circle cx="8.5" cy="16" r="1.8"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l1.9-1.9a5 5 0 0 0-7.1-7.1l-1 1M14 10a5 5 0 0 0-7.1 0l-1.9 1.9a5 5 0 0 0 7.1 7.1l1-1"/>',
};
export function icon(name) {
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (ICONS[name] || '') + '</svg>';
}
