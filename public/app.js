import { CONFIG } from './config.js';
import { samplePrompts } from './prompts.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { readEvents, eventJson } from './sse.js';
import { demoConversation, demoSearch, demoStream } from './demo.js';

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);

const relative = (iso) => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
  if (mins < 60 * 24 * 7) return Math.round(mins / (60 * 24)) + 'd ago';
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// ------------------------------------------------------------------- PKCE
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 64]).join('');
}

async function s256(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// ---------------------------------------------------------------- session
const TOKEN_KEY = 'bb_token';

const getToken = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return t && t.access_token && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
};

const setToken = (json) =>
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: json.access_token,
    id_token: json.id_token || null,
    expiresAt: Date.now() + ((Number(json.expires_in) || 300) - 30) * 1000,
  }));

const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// ------------------------------------------------------------- OAuth flow
async function beginLogin() {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(CONFIG.AUTHORIZE_URL + '?' + p);
}

const cleanUrl = () => history.replaceState({}, '', CONFIG.REDIRECT_URI);

// Returns true if we consumed an OAuth redirect.
async function completeRedirect() {
  const q = new URLSearchParams(window.location.search);
  if (q.has('error')) {
    cleanUrl();
    throw new Error('Authorization failed: ' + q.get('error') + ' ' + (q.get('error_description') || ''));
  }
  if (!q.has('code')) return false;

  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier || q.get('state') !== sessionStorage.getItem('pkce_state')) {
    cleanUrl();
    throw new Error('OAuth state mismatch — please try signing in again.');
  }
  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: CONFIG.REDIRECT_URI,
      client_id: CONFIG.CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) { cleanUrl(); throw new Error('Token exchange failed (' + res.status + '). ' + text.slice(0, 300)); }
  setToken(JSON.parse(text));
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  cleanUrl();
  return true;
}

// ----------------------------------------------------------- API requests
class AuthExpired extends Error {}

function authHeaders(extra) {
  const token = getToken();
  if (!token) throw new AuthExpired('Not signed in');
  return Object.assign({ Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' }, extra || {});
}

async function api(method, path, { query, party, body, headers } = {}) {
  const url = new URL(CONFIG.API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const h = authHeaders(headers);
  if (party) h['X-Acting-Party-ID'] = party;
  if (body !== undefined) h['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error('Network/CORS error calling ' + path + '. Is this origin registered as a redirect URI on the BigBooks OAuth client? (' + e.message + ')');
  }
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  const text = await res.text();
  if (!res.ok) throw new Error(describeError(res.status, path, text));
  return text ? JSON.parse(text) : null;
}

const apiGet = (path, opts) => api('GET', path, opts);
const apiPost = (path, opts) => api('POST', path, opts);

// BigBooks error bodies are { errors: [...], code: "..." } — switch on code, show the message.
function describeError(status, path, text) {
  try {
    const body = JSON.parse(text);
    if (body && Array.isArray(body.errors)) return status + ' ' + (body.code || '') + ' from ' + path + ': ' + body.errors.join('; ');
  } catch { /* fall through to the raw body */ }
  return status + ' from ' + path + ': ' + (text.slice(0, 300) || '(empty body)');
}

function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}

function partyFromClaims(claims) {
  if (!claims) return null;
  for (const k of ['bigbooks:party', 'bigbooks:party_id', 'party', 'party_id']) {
    const v = claims[k];
    if (typeof v === 'string' && v) return { id: v, name: claims.name || claims.email };
    if (v && typeof v === 'object' && v.id) return { id: v.id, name: v.name || claims.name || claims.email };
  }
  return null;
}

// Access tokens carry no party claim, so the documented bootstrap is GET /oauth2/userInfo.
// The id_token often already carries it, which saves a round trip.
async function fetchParty() {
  const token = getToken();
  const fromToken = partyFromClaims(decodeJwt(token.id_token || '')) || partyFromClaims(decodeJwt(token.access_token || ''));
  if (fromToken) return fromToken;

  const res = await fetch(CONFIG.USERINFO_URL, { headers: authHeaders() }).catch((e) => {
    throw new Error('Could not resolve your party: the userInfo call was blocked. The CORS allow-list is built from your client\'s registered redirect URIs — check that ' + CONFIG.REDIRECT_URI + ' is registered exactly. (' + e.message + ')');
  });
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  if (!res.ok) throw new Error('userInfo failed (' + res.status + ')');
  const party = partyFromClaims(await res.json());
  if (party) return party;
  throw new Error('No bigbooks:party claim in the token or userInfo. Ensure the "openid" scope is granted.');
}

// --------------------------------------------------------------- app state
const state = {
  demo: false,
  party: null,
  who: '',
  conversations: [],
  search: '',         // the phrase currently filtering the sidebar ('' = show everything)
  current: null,      // { id, version, name }
  messages: [],       // { role, text, thinking, error }
  streaming: false,
  abort: null,        // AbortController for the live stream (or demo's stopper)
  chatType: CONFIG.DEFAULT_CHAT_TYPE,
};

// ---------------------------------------------------------- conversations
const conversationPath = (id) => '/v1/ai/conversations/' + encodeURIComponent(id);

// Searches run on the server, which matches the phrase against each conversation's name
// *and* its user/assistant messages, case-insensitively. Wildcards are escaped server-side,
// so the raw text goes on the wire untouched.
let searchSeq = 0;

async function loadConversations() {
  // Typing fires several of these; responses can land out of order, and the last one to
  // arrive is not necessarily the one for the phrase now in the box. Stamp and discard.
  const seq = ++searchSeq;
  const phrase = state.search;

  const conversations = state.demo
    ? demoSearch(phrase)
    : (await apiGet('/v1/ai/conversations', {
        party: state.party,
        query: { page_size: 50, page_number: 0, phrase },
      })).conversations || [];

  if (seq !== searchSeq) return; // a newer search already went out
  state.conversations = conversations;
  renderHistory();
}

let searchTimer;
function onSearchInput(value) {
  state.search = value.trim();
  clearTimeout(searchTimer);
  // Long enough that a typed word is one request, short enough to feel live.
  searchTimer = setTimeout(() => loadConversations().catch(reportError), 250);
}

function clearSearch() {
  if (!state.search && !$('#search').value) return;
  $('#search').value = '';
  onSearchInput('');
}

async function openConversation(id) {
  closeDrawer();
  if (state.streaming) return;
  const convo = state.demo ? demoConversation(id) : await apiGet(conversationPath(id), { party: state.party });
  adoptConversation(convo);
  renderHistory();
  renderMessages();
  focusInput();
}

/** Replaces the on-screen turn history with the server's copy — the authoritative one. */
function adoptConversation(convo) {
  state.current = { id: convo.id, version: convo.version, name: convo.name };
  state.messages = (convo.messages || [])
    // SYSTEM and TOOL rows are part of the transcript the model sees, not the conversation
    // the user had. Assistant rows can also be empty when a turn failed mid-flight.
    .filter((m) => (m.role === 'USER' || m.role === 'ASSISTANT') && (m.text || m.thinking))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map((m) => ({ role: m.role, text: m.text || '', thinking: m.thinking || '' }));
  $('#chat-title').textContent = convo.name || 'Conversation';
}

function newChat() {
  closeDrawer();
  if (state.streaming) return;
  state.current = null;
  state.messages = [];
  $('#chat-title').textContent = 'New chat';
  renderHistory();
  renderMessages();
  shuffleSuggestions();
  focusInput();
}

// ----------------------------------------------------------- send a turn
async function send(text) {
  const prompt = text.trim();
  if (!prompt || state.streaming) return;

  hideBanner();
  state.messages.push({ role: 'USER', text: prompt });
  const turn = { role: 'ASSISTANT', text: '', thinking: '', pending: true };
  state.messages.push(turn);
  setStreaming(true);
  renderMessages();

  try {
    await streamTurn(prompt, turn, /* allowRetry */ true);
  } catch (e) {
    if (e instanceof AuthExpired) return showGate('Your session expired. Please sign in again.');
    if (e.name !== 'AbortError') turn.error = e.message;
  } finally {
    turn.pending = false;
    setStreaming(false);
    renderMessages();
  }

  // The stream carries text; the conversation carries the title, the next If-Match
  // version, and the persisted thinking. Re-read it rather than guessing at any of them.
  if (state.current && !state.demo) {
    await refreshCurrent().catch(() => {});
    await loadConversations().catch(() => {});
  }
}

/**
 * One streamed turn. Starting a conversation and continuing one are different endpoints
 * but the same event stream, so only the request differs.
 */
async function streamTurn(prompt, turn, allowRetry) {
  const onEvent = ({ event, data }) => {
    switch (event) {
      case 'conversation': {
        const ref = eventJson(data);
        // Arrives first, and for a brand-new conversation it is the only place the id
        // appears before `done` — Stop needs it, so adopt it immediately.
        if (ref.id) {
          state.current = { id: ref.id, version: ref.version, name: (state.current || {}).name || prompt };
          // The server names a new conversation from its first turn; until the post-`done`
          // re-read brings that name back, the prompt itself is the honest placeholder.
          $('#chat-title').textContent = state.current.name;
        }
        break;
      }
      case 'thinking':
        turn.thinking += data;
        paintTurn(turn);
        break;
      case 'done':
        break;
      case 'error': {
        // Only failures raised *after* the stream opened land here — by then the response
        // has committed to 200 text/event-stream and no status can change. Everything the
        // server can check up front (version, ownership, fair use) is an HTTP status
        // instead, handled below.
        const err = eventJson(data);
        turn.error = friendlyError(err.code, err.message);
        break;
      }
      default:
        // Unnamed event: a chunk of the answer.
        turn.text += data;
        paintTurn(turn);
    }
  };

  if (state.demo) {
    await new Promise((resolve) => {
      const stop = demoStream((ev) => { onEvent(ev); if (ev.event === 'done') resolve(); });
      state.abort = { abort: () => { stop(); resolve(); } };
    });
    state.current = state.current || { id: 'demo-new', version: 1, name: prompt };
    $('#chat-title').textContent = state.current.name;
    return;
  }

  const controller = new AbortController();
  state.abort = controller;

  const continuing = !!(state.current && state.current.id);
  const res = await fetch(CONFIG.API + (continuing ? conversationPath(state.current.id) + '/stream' : '/v1/ai/conversations/start/stream'), {
    method: continuing ? 'PUT' : 'POST',
    signal: controller.signal,
    headers: authHeaders(Object.assign(
      { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Acting-Party-ID': state.party },
      continuing ? { 'If-Match': String(state.current.version) } : {},
    )),
    body: JSON.stringify(continuing
      ? { text: prompt, chatType: state.chatType }
      : { userChat: prompt, chatType: state.chatType }),
  });

  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }

  if (res.status === 409 && allowRetry) {
    // Someone else advanced this conversation (another tab, another device), so our
    // If-Match was stale and nothing was written. Take the fresh version and replay this
    // turn once; a second conflict is a real problem, not a race. Only the version is
    // adopted — re-reading the messages here would swap out the `turn` object the caller
    // is still painting into.
    const convo = await apiGet(conversationPath(state.current.id), { party: state.party });
    state.current.version = convo.version;
    turn.text = '';
    turn.thinking = '';
    return streamTurn(prompt, turn, false);
  }

  if (!res.ok) {
    // A pre-stream refusal: 409 stale If-Match, 404 unknown conversation, 400 rejected
    // body, 429 fair use. The body is the same { code, errors } shape the rest of the API
    // returns, so it reads through the same translator as an in-stream error event.
    const failure = failureFromBody(res.status, await res.text());
    turn.error = friendlyError(failure.code, failure.message);
    return;
  }

  await readEvents(res, onEvent);
}

/** Reads BigBooks' { code, errors } error body into the { code, message } shape of an error event. */
function failureFromBody(status, text) {
  try {
    const body = JSON.parse(text);
    if (body && (body.code || Array.isArray(body.errors))) {
      return { code: body.code || null, message: (body.errors || []).join('; ') || null };
    }
  } catch { /* not JSON — fall through to the status */ }
  return { code: null, message: 'The assistant could not answer (HTTP ' + status + ').' };
}

/** Re-reads the current conversation, waiting out a turn that has not finished persisting. */
async function refreshCurrent(attempt = 0) {
  const convo = await apiGet(conversationPath(state.current.id), { party: state.party });
  // COMPLETED is written atomically with the answer, so GENERATING here means the reply
  // has not landed yet and the messages we would adopt are one short.
  if (convo.turnState === 'GENERATING' && attempt < 4) {
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    return refreshCurrent(attempt + 1);
  }
  if (convo.turnState === 'GENERATING') {
    // Still not persisted. The version and title are safe to take; the messages are not —
    // adopting a transcript that is one turn short would erase the answer on screen.
    state.current = { id: convo.id, version: convo.version, name: convo.name };
    $('#chat-title').textContent = convo.name || 'Conversation';
    return;
  }
  adoptConversation(convo);
  renderMessages();
}

async function stopTurn() {
  if (!state.streaming) return;
  // Tell the server first — it keeps whatever partial answer exists and marks the turn
  // STOPPED. Dropping the socket alone would leave the turn generating server-side.
  if (state.current && state.current.id && !state.demo) {
    await apiPost(conversationPath(state.current.id) + '/stop', { party: state.party }).catch(() => {});
  }
  if (state.abort) state.abort.abort();
}

// Failures reach us two ways — an HTTP status before the stream opens, an `error` event
// after — and both parse to the same { code, message }. Most already carry a message meant
// for a person (fair use, entitlement) so they pass straight through. The one worth
// translating is the missing-key case, an internal error whose text explains nothing.
function friendlyError(code, message) {
  const text = message || 'The assistant could not answer.';
  return /No AI properties/i.test(text)
    ? 'No model provider key is available for this account. BigBooks is bring-your-own-key and never spends a shared one — add yours at ' + CONFIG.SECRETS_URL + ', signed in as the account that owns this OAuth client.'
    : text;
}

// ------------------------------------------------------------- rendering
function renderHistory() {
  const nav = $('#history');
  const phrase = state.search;

  $('#history-head').textContent = !phrase
    ? 'Conversations'
    : state.conversations.length + (state.conversations.length === 1 ? ' match' : ' matches');

  if (!state.conversations.length) {
    nav.innerHTML = '<p class="history-empty muted">'
      + (phrase ? 'Nothing matches &ldquo;' + escapeHtml(phrase) + '&rdquo;.' : 'No conversations yet.')
      + '</p>';
    return;
  }

  const currentId = (state.current || {}).id;
  nav.innerHTML = state.conversations.map((c) => {
    const name = c.name || 'Untitled';
    const when = relative(c.updatedDate || c.createdDate);
    return '<button class="convo" data-id="' + escapeHtml(c.id) + '"'
      + (c.id === currentId ? ' aria-current="true"' : '')
      + ' title="' + escapeHtml(name) + '">'
      + highlight(name, phrase)
      // The server matches message text too, so a row can be a hit with nothing visibly
      // marked. Saying where it matched beats leaving the user to wonder.
      + (phrase && !containsPhrase(name, phrase) ? '<span class="in-dialog">matched in the conversation</span>' : '')
      + (when ? '<time>' + escapeHtml(when) + '</time>' : '')
      + '</button>';
  }).join('');
}

const containsPhrase = (text, phrase) => text.toLowerCase().includes(phrase.toLowerCase());

/** Escapes `text`, then wraps each case-insensitive occurrence of `phrase` in a <mark>. */
function highlight(text, phrase) {
  if (!phrase) return escapeHtml(text);
  const lower = text.toLowerCase();
  const needle = phrase.toLowerCase();
  const out = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    out.push(escapeHtml(text.slice(at, i)), '<mark>', escapeHtml(text.slice(i, i + needle.length)), '</mark>');
    at = i + needle.length;
  }
  out.push(escapeHtml(text.slice(at)));
  return out.join('');
}

function renderMessages() {
  const list = $('#messages');
  $('#empty').hidden = state.messages.length > 0;
  list.innerHTML = state.messages.map((m, i) => messageHtml(m, i)).join('');
  scrollToEnd();
}

function messageHtml(m, i) {
  if (m.role === 'USER') {
    return '<div class="msg user"><div class="bubble">' + escapeHtml(m.text) + '</div></div>';
  }
  return '<div class="msg assistant" data-i="' + i + '">' + assistantInner(m) + '</div>';
}

function assistantInner(m) {
  const parts = [];
  if (m.thinking) {
    // Open while it streams — watching the reasoning arrive is the point — then collapsed,
    // because on re-read the answer is what the user came back for.
    parts.push('<details class="thinking' + (m.pending ? ' live' : '') + '"' + (m.pending ? ' open' : '') + '>'
      + '<summary>' + (m.pending && !m.text ? 'Thinking&hellip;' : 'Thinking') + '</summary>'
      + '<div class="thinking-body">' + escapeHtml(m.thinking) + '</div></details>');
  }
  if (m.text) parts.push('<div class="answer">' + renderMarkdown(m.text) + '</div>');
  // The caret doubles as the "working on it" indicator before the first token lands.
  if (m.pending) parts.push('<span class="caret" aria-label="Generating"></span>');
  if (m.error) {
    parts.push('<div class="msg-error">' + linkify(escapeHtml(m.error)) + '</div>');
  }
  return parts.join('');
}

// Turns a bare URL inside an already-escaped error string into a link, so the BYOK
// message can be clicked straight through to the key page.
const linkify = (escaped) =>
  escaped.replace(/https?:\/\/[^\s<]+[^\s<.,]/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');

/**
 * Repaints only the streaming turn. Re-rendering every message on each token would
 * re-parse the whole transcript's markdown dozens of times a second.
 */
let paintQueued = false;
function paintTurn(turn) {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    const i = state.messages.indexOf(turn);
    const el = $('#messages .msg.assistant[data-i="' + i + '"]');
    if (!el) return renderMessages();
    // Keep the disclosure state the user chose mid-stream instead of forcing it back open.
    const open = el.querySelector('.thinking') ? el.querySelector('.thinking').open : null;
    el.innerHTML = assistantInner(turn);
    const details = el.querySelector('.thinking');
    if (details && open !== null) details.open = open;
    scrollToEnd();
  });
}

// Only follow the stream while the user is already near the bottom; yanking the view
// down while they are reading earlier output is the classic chat-UI annoyance.
function scrollToEnd() {
  const el = $('#stream');
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distance < 240) el.scrollTop = el.scrollHeight;
}

function setStreaming(on) {
  state.streaming = on;
  $('#send').hidden = on;
  $('#stop').hidden = !on;
  $('#input').disabled = on;
  $('#new-chat').disabled = on;
  if (!on) { state.abort = null; focusInput(); }
}

function shuffleSuggestions() {
  $('#suggestions').innerHTML = samplePrompts(CONFIG.SUGGESTION_COUNT)
    .map((p) => '<button class="suggestion" type="button">' + escapeHtml(p) + '</button>')
    .join('');
}

const focusInput = () => { if (!matchMedia('(max-width: 820px)').matches) $('#input').focus(); };

// ------------------------------------------------------------------ chrome
function showBanner(html, kind) {
  const b = $('#banner');
  b.className = 'banner' + (kind ? ' ' + kind : '');
  b.innerHTML = html + '<button class="link-btn dismiss" data-dismiss>Dismiss</button>';
  b.hidden = false;
}
const hideBanner = () => { $('#banner').hidden = true; };

function showGate(message) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  if (message) $('#gate-message').textContent = message;
  $('#gate-config').hidden = !!CONFIG.CLIENT_ID;
  $('#signin-btn').disabled = !CONFIG.CLIENT_ID;
}

let toastTimer;
function flash(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// The scrim is both the dimmer and the tap-to-close target, so it only exists while the
// drawer is open — left in the tree it would swallow every click on the chat pane.
function openDrawer() {
  $('#app').classList.add('drawer-open');
  $('#scrim').hidden = false;
}
function closeDrawer() {
  $('#app').classList.remove('drawer-open');
  $('#scrim').hidden = true;
}

// -------------------------------------------------------------- Plaid Link
// POST /v1/plaid/public/token → Plaid.create(link_token) → the user picks a bank →
// onSuccess → POST /v1/plaid/access/token, which exchanges it server-side (BigBooks holds
// the Plaid secret) and imports the item. The assistant's tools read what that import
// creates, so linking is what gives the model anything to talk about.
let linking = false;

function setLinkBusy(busy) {
  linking = busy;
  const el = $('#link-btn');
  el.disabled = busy;
  el.lastChild.textContent = busy ? ' Opening Plaid…' : ' ' + el.dataset.label;
}

async function openPlaidLink() {
  if (linking) return;
  if (state.demo) return flash('Demo mode — linking is disabled.');
  if (!window.Plaid) return showBanner('Plaid Link failed to load — check your network or ad blocker, then reload.', 'error');

  hideBanner();
  setLinkBusy(true);
  try {
    const { token } = await apiPost('/v1/plaid/public/token', {
      party: state.party,
      body: { clientName: 'BigBooks AI Assistant', language: 'en', countryCodes: ['US'], clientUserId: state.party },
    });
    window.Plaid.create({
      token,
      onSuccess: async (publicToken, metadata) => {
        try {
          await exchangePublicToken(publicToken, metadata);
          flash('Account linked — importing transactions…');
          hideBanner();
        } catch (e) {
          if (e instanceof AuthExpired) return showGate('Your session expired. Please sign in again.');
          showBanner('Linking failed: ' + escapeHtml(e.message), 'error');
        } finally {
          setLinkBusy(false);
        }
      },
      onExit: (err) => {
        setLinkBusy(false);
        if (err) showBanner('Plaid Link: ' + escapeHtml(err.display_message || err.error_message || err.error_code || 'exited before finishing.'), 'error');
      },
    }).open();
  } catch (e) {
    setLinkBusy(false);
    if (e instanceof AuthExpired) return showGate('Your session expired. Please sign in again.');
    showBanner('Could not start Plaid Link: ' + escapeHtml(e.message), 'error');
  }
}

function exchangePublicToken(publicToken, metadata) {
  const inst = metadata.institution || {};
  return apiPost('/v1/plaid/access/token', {
    party: state.party,
    body: {
      publicToken,
      party: state.party,
      linkSessionId: metadata.link_session_id,
      // The webhook is the API's own endpoint, matching what the server registered when it
      // minted the link token. It follows the API host; it is not a value you choose.
      webhook: CONFIG.API + '/v1/plaid/webhook',
      institution: inst.institution_id ? { id: inst.institution_id, name: inst.name } : null,
      accounts: (metadata.accounts || []).map((a) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
    },
  });
}

/** Nothing linked means the assistant has no data to answer from — say so up front. */
async function checkLinkedAccounts() {
  const data = await apiGet('/v1/plaid/items', { party: state.party });
  if ((data.items || []).length === 0) {
    showBanner('<span>No accounts linked yet. The assistant answers from your own books, so link a bank, card, or investment account first.</span>');
  }
}

// -------------------------------------------------------------------- wiring
function wire() {
  $('#signin-btn').addEventListener('click', beginLogin);
  $('#new-chat').addEventListener('click', newChat);
  $('#reshuffle').addEventListener('click', shuffleSuggestions);
  $('#link-btn').addEventListener('click', openPlaidLink);
  $('#open-drawer').addEventListener('click', openDrawer);
  $('#close-drawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#stop').addEventListener('click', stopTurn);

  // Demo mode is read once at start-up, so toggling #demo has to reload rather than
  // leave a signed-out page sitting behind a hash it never looked at again.
  window.addEventListener('hashchange', () => window.location.reload());

  $('#signout').addEventListener('click', () => {
    clearToken();
    window.location.assign(CONFIG.REDIRECT_URI);
  });

  $('#agentic').addEventListener('change', (e) => {
    state.chatType = e.target.checked ? 'AGENTIC' : 'BASIC';
  });

  $('#search').addEventListener('input', (e) => onSearchInput(e.target.value));
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { clearSearch(); e.target.blur(); }
  });

  $('#history').addEventListener('click', (e) => {
    const btn = e.target.closest('.convo');
    if (btn) openConversation(btn.dataset.id).catch(reportError);
  });

  $('#suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion');
    if (btn) send(btn.textContent).catch(reportError);
  });

  $('#banner').addEventListener('click', (e) => { if (e.target.dataset.dismiss !== undefined) hideBanner(); });

  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer-form').requestSubmit();
    }
  });

  $('#composer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    autosize();
    send(text).catch(reportError);
  });
}

function reportError(e) {
  if (e instanceof AuthExpired) return showGate('Your session expired. Please sign in again.');
  showBanner(escapeHtml(e.message), 'error');
}

// ---------------------------------------------------------------- bootstrap
async function main() {
  wire();
  shuffleSuggestions();

  state.demo = window.location.hash === '#demo';

  if (state.demo) {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#who-name').textContent = 'Demo mode';
    $('#signout').hidden = true;
    await loadConversations();
    renderMessages();
    showBanner('<span><strong>Demo mode.</strong> Synthetic data, canned answers, nothing saved. Remove <code>#demo</code> from the URL to sign in.</span>');
    return;
  }

  try {
    await completeRedirect();
  } catch (e) {
    return showGate(e.message);
  }

  if (!getToken()) return showGate();

  $('#gate').hidden = true;
  $('#app').hidden = false;

  try {
    const party = await fetchParty();
    state.party = party.id;
    $('#who-name').textContent = party.name || 'Signed in';
    await loadConversations();
    renderMessages();
    focusInput();
    // Not blocking: an empty-books warning is useful, but never a reason to stall the UI.
    checkLinkedAccounts().catch(() => {});
  } catch (e) {
    if (e instanceof AuthExpired) return showGate('Your session expired. Please sign in again.');
    showGate(e.message);
  }
}

main();
