// A small CommonMark-ish renderer, deliberately hand-rolled.
//
// A sample with no build step also has no npm, and pulling marked.js off a CDN would put a
// third party between the model's answer and the screen. The subset here is the subset the
// assistant actually emits: headings, bold/italic, inline code, fenced code, links, bullet
// and numbered lists, blockquotes, tables, and rules. Anything outside it degrades to plain
// text rather than breaking.
//
// Everything is escaped *before* any markup is generated, so no branch below can emit
// model-authored HTML. That ordering is the whole safety argument — keep it if you edit.

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only http(s) and mailto survive; javascript: and data: URLs render as their own text.
const safeHref = (url) => (/^(https?:\/\/|mailto:)/i.test(url.trim()) ? escapeHtml(url.trim()) : null);

// Placeholders for parked inline-code spans. Private-use code points, because a naive
// marker like " 0 " would be reinstated over any bare number the model happened to write.
const OPEN = '\uE000';
const CLOSE = '\uE001';

// Inline spans, applied to already-escaped text. Code first: its content must not be
// re-scanned for emphasis, so each span is parked behind a placeholder and restored last.
function inline(escaped) {
  const codes = [];
  let out = escaped
    .replace(/[\uE000\uE001]/g, '')
    .replace(/(`+)([\s\S]*?)\1/g, (_, __, code) => OPEN + (codes.push(code.trim()) - 1) + CLOSE);

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const href = safeHref(url);
      return href ? '<img src="' + href + '" alt="' + alt + '" loading="lazy">' : m;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) => {
      const href = safeHref(url);
      return href ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : m;
    })
    // Bare URLs the model wrote without link syntax.
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g,
      (_, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/\uE000(\d+)\uE001/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
}

const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const alignOf = (spec) => {
  const s = spec.trim();
  if (s.startsWith(':') && s.endsWith(':')) return ' style="text-align:center"';
  if (s.endsWith(':')) return ' style="text-align:right"';
  return '';
};

const startsBlock = (l) =>
  /^\s*(#{1,6}\s|>|```|~~~)/.test(l) || /^\s*(---+|\*\*\*+|___+)\s*$/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l);

/**
 * Markdown to HTML. The input is untrusted model output; the output is safe to assign to
 * innerHTML because every character of it passed through escapeHtml on the way here.
 */
export function renderMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. An unterminated fence runs to the end of the message — which is exactly
    // what a half-streamed answer looks like — so it renders instead of swallowing the rest.
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#-]*)\s*$/);
    if (fence) {
      const body = [];
      const close = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++; // consume the closing fence, if there was one
      const lang = fence[2] ? ' class="lang-' + escapeHtml(fence[2]) + '"' : '';
      html.push('<pre><code' + lang + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { html.push('<hr>'); i++; continue; }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      html.push('<h' + level + '>' + inline(escapeHtml(heading[2])) + '</h' + level + '>');
      i++;
      continue;
    }

    // Table: a header row whose next line is the alignment rule.
    if (line.includes('|') && isTableRule(lines[i + 1] || '')) {
      const heads = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(splitRow(lines[i]));
      const head = heads.map((h, c) => '<th' + (aligns[c] || '') + '>' + inline(escapeHtml(h)) + '</th>').join('');
      const body = rows.map((r) =>
        '<tr>' + heads.map((_, c) => '<td' + (aligns[c] || '') + '>' + inline(escapeHtml(r[c] || '')) + '</td>').join('') + '</tr>'
      ).join('');
      html.push('<div class="md-table"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s*>\s?/, ''));
      html.push('<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>');
      continue;
    }

    const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        // Continuation lines: indented under the item, or lazily wrapped directly beneath it.
        const parts = [m[2]];
        for (i++; i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
          parts.push(lines[i].replace(/^\s{1,4}/, ''));
        }
        items.push(parts.join('\n'));
        // A blank line between items keeps the list going; two blank lines end it.
        if (i < lines.length && !lines[i].trim() && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1] || '')) i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? ' start="' + (parseInt(bullet[1], 10) || 1) + '"' : '';
      // An item stays inline-only unless it grew a block of its own, so simple lists stay tight.
      const rendered = items
        .map((t) => (t.includes('\n') ? renderMarkdown(t) : inline(escapeHtml(t))))
        .map((t) => '<li>' + t + '</li>')
        .join('');
      html.push('<' + tag + start + '>' + rendered + '</' + tag + '>');
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const para = [];
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || startsBlock(l)) break;
      if (l.includes('|') && isTableRule(lines[i + 1] || '')) break;
      para.push(l);
    }
    // Two trailing spaces is markdown's hard break; a lone newline just joins the lines.
    html.push('<p>' + inline(escapeHtml(para.join('\n'))).replace(/ {2,}\n/g, '<br>').replace(/\n/g, ' ') + '</p>');
  }

  return html.join('\n');
}

export { escapeHtml };
