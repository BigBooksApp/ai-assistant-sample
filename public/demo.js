// Demo mode (#demo): the interface with synthetic data and no sign-in.
//
// It exists so the streaming, thinking, markdown, and history behaviours can be seen
// without an account or a model key. Nothing here touches the network; the "stream"
// is a timer replaying a canned answer in chunks the same shape the API sends.

const ANSWER = `Your spending rose **$412** month over month, and almost all of it is in two categories.

| Category | July | August | Change |
| --- | ---: | ---: | ---: |
| Groceries | $842 | $1,104 | **+$262** |
| Utilities | $186 | $329 | +$143 |
| Dining out | $310 | $317 | +$7 |

Two things stand out:

1. **Groceries** — you shopped 18 times in August against 12 in July. The average basket
   barely moved ($70 to $61), so this is trip frequency, not price.
2. **Utilities** — a single $143 charge on Aug 12 from *Metro Power*, which reads like a
   summer catch-up bill rather than a new recurring cost.

Everything else was flat. If August's grocery cadence holds, budget about **$1,050/month**
going forward rather than the $850 you have assigned now.`;

const THINKING = `The question is about month-over-month change, so I need actuals for July and August \
broken out by category, not a total. Pulling the category register for both months, then \
differencing them. Groceries and utilities are the only lines that move more than $50 \
- checking whether the utilities jump is one charge or a rate change before calling it recurring.`;

export const DEMO_CONVERSATIONS = [
  { id: 'demo-1', name: 'Why did my spending increase?', version: 2, updatedDate: daysAgo(0) },
  { id: 'demo-2', name: 'Find subscriptions I don’t use.', version: 4, updatedDate: daysAgo(2) },
  { id: 'demo-3', name: 'Am I on track with my budget?', version: 2, updatedDate: daysAgo(6) },
  { id: 'demo-4', name: 'Summarize my finances in five bullet points.', version: 2, updatedDate: daysAgo(19) },
];

const DEMO_MESSAGES = {
  'demo-1': [
    { role: 'USER', text: 'Why did my spending increase?' },
    { role: 'ASSISTANT', text: ANSWER, thinking: THINKING },
  ],
  'demo-2': [
    { role: 'USER', text: 'Find subscriptions I don’t use.' },
    {
      role: 'ASSISTANT',
      thinking: 'Recurring charges are the ones with a stable merchant and a monthly cadence. '
        + 'Cross-referencing each against the last 90 days of account activity to see which ones '
        + 'have a matching usage signal.',
      text: `Four subscriptions billed every month this year. Two look dormant:

- **Cloud Storage Plus** — $9.99/mo, $119.88/yr. No related activity since March.
- **Streaming Bundle** — $17.99/mo, $215.88/yr. Last used in April, by your own note on the entry.

The other two — *Password Manager* ($3/mo) and *Music* ($10.99/mo) — show steady use.

Cancelling the first two saves **$335.76 a year**.`,
    },
  ],
  'demo-3': [
    { role: 'USER', text: 'Am I on track with my budget?' },
    {
      role: 'ASSISTANT',
      text: `Two thirds through the month, you have spent **71%** of what you assigned. Close, with one exception.

> Groceries is at 94% with nine days left.

Everything else has room: Dining out 48%, Transport 55%, Household 61%. Nothing is over yet.`,
    },
  ],
  'demo-4': [
    { role: 'USER', text: 'Summarize my finances in five bullet points.' },
    {
      role: 'ASSISTANT',
      text: `- Net worth is **$148,320**, up $2,140 this month, almost all of it market movement.
- Cash on hand is $11,480 across two checking accounts — roughly 3.1 months of expenses.
- Debt is one card at $2,310 and a mortgage at $196,000; the card carries 21.9% APR.
- You saved 14% of income over the last three months, against a 20% target.
- The only category consistently over budget is groceries, by about $200/month.`,
    },
  ],
};

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

export const demoConversation = (id) => ({
  id,
  name: (DEMO_CONVERSATIONS.find((c) => c.id === id) || {}).name || 'Conversation',
  version: 2,
  turnState: 'COMPLETED',
  messages: (DEMO_MESSAGES[id] || []).map((m, i) => ({ ...m, id: id + '-' + i, sequence: i })),
});

/**
 * Replays a canned answer through the same callback shape as a real stream, so the
 * rendering path under test is the real one. Returns a function that stops it early,
 * which is what the Stop button calls.
 */
export function demoStream(onEvent) {
  let stopped = false;
  const chunks = [];
  for (let i = 0; i < THINKING.length; i += 24) chunks.push({ event: 'thinking', data: THINKING.slice(i, i + 24) });
  for (let i = 0; i < ANSWER.length; i += 12) chunks.push({ event: null, data: ANSWER.slice(i, i + 12) });

  const CHUNKS_PER_MS = 1 / 16;
  const started = performance.now();
  let i = 0;
  onEvent({ event: 'conversation', data: '{"id":"demo-new","version":1}' });
  // Emitted against the clock, not once per tick: browsers clamp timers in a background
  // tab to one a second, and a per-tick loop would stretch a two-second demo into two
  // minutes. Falling behind makes the replay chunkier, never slower.
  const timer = setInterval(() => {
    if (stopped) return;
    const due = Math.min(chunks.length, Math.ceil((performance.now() - started) * CHUNKS_PER_MS));
    while (i < due) onEvent(chunks[i++]);
    if (i >= chunks.length) {
      clearInterval(timer);
      onEvent({ event: 'done', data: '{"id":"demo-new"}' });
    }
  }, 16);

  return () => { stopped = true; clearInterval(timer); onEvent({ event: 'done', data: '{"id":"demo-new"}' }); };
}
