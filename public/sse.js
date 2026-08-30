// Server-sent events over fetch().
//
// EventSource would be the obvious tool and is the wrong one here: it cannot set an
// Authorization header and cannot POST, and both conversation streams are authenticated
// POST/PUT requests. So we read the body ourselves. The framing below is the SSE wire
// format — `field:value` lines, a blank line dispatches, `:` lines are comments (the
// server sends one every few seconds as a keep-alive).

/**
 * Reads the SSE stream in `response`, calling `onEvent({ event, data })` per dispatched
 * event. `event` is null for unnamed events, which on this API are answer-token chunks.
 * Resolves when the stream ends; rejects if the reader is aborted.
 */
export async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name = null;
  let data = [];

  const dispatch = () => {
    if (data.length) onEvent({ event: name, data: data.join('\n') });
    name = null;
    data = [];
  };

  for (;;) {
    const { value, done } = await reader.read();
    // `stream: true` matters: a chunk boundary can land mid-UTF-8-sequence, and a
    // one-shot decode would turn a split multi-byte character into a replacement char.
    buffer += decoder.decode(value, { stream: !done });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);

      if (!line) { dispatch(); continue; }
      if (line.startsWith(':')) continue; // keep-alive comment

      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      // One leading space after the colon is delimiter, not payload: the spec has every
      // client drop it, and EventSource does. The server pads each data line with exactly
      // one space so that a compliant parse round-trips the value, which means an answer
      // chunk that genuinely begins with a space (" $842.17") arrives as "  $842.17" and
      // keeps its own. Skipping this strip does not preserve text, it adds a space to
      // every chunk. Do not trim the value further either — a chunk can be pure whitespace.
      const raw = colon < 0 ? '' : line.slice(colon + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;

      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      // `id` and `retry` are meaningless for a one-shot stream that is never resumed.
    }

    if (done) { dispatch(); return; }
  }
}

/** Parses a named event's JSON payload, tolerating anything unexpected on the wire. */
export function eventJson(data) {
  try { return JSON.parse(data); } catch { return {}; }
}
