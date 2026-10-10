// Turns message text into safe HTML: *actions* become italics, **bold** stays bold.
// Everything is escaped first, so nothing the model writes can run as code.

export function escapeHtml(s) {
  return (s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderText(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // An unfinished *action while the reply is still streaming in.
  html = html.replace(/\*([^*\n]+)$/g, '<em>$1</em>');
  return html
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
