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
      // NOTE: the spec says strip one leading space after the colon, and that is what
      // EventSource does. We deliberately do not. Spring writes the payload as bare
      // `data:` + value, so for an answer-token chunk that begins with a space (" $842.17")
      // the space *is* the payload, and stripping it runs the words together. Named events
      // here all carry JSON, where a leading space would not survive to matter either way.
      const value_ = colon < 0 ? '' : line.slice(colon + 1);

      if (field === 'event') name = value_;
      else if (field === 'data') data.push(value_);
      // `id` and `retry` are meaningless for a one-shot stream that is never resumed.
    }

    if (done) { dispatch(); return; }
  }
}

/** Parses a named event's JSON payload, tolerating anything unexpected on the wire. */
export function eventJson(data) {
  try { return JSON.parse(data); } catch { return {}; }
}
