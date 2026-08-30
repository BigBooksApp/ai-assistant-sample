// BigBooks AI assistant configuration.
//
// Fill in CLIENT_ID with a PUBLIC OAuth client registered in BigBooks
// (token endpoint auth method "none", PKCE / S256). Create one at
// https://www.bigbooks.app/clients. That client must have:
//   • Redirect URI  = this app's URL, e.g. http://localhost:5173/
//
// The CORS allow-list for /oauth2/token and /oauth2/userInfo is derived from the
// web origins of your registered redirect URIs, so registering the redirect URI
// is all it takes — there is no separate origin field. Note that
// http://localhost:5173 and http://127.0.0.1:5173 are DIFFERENT origins.
//
// No client secret goes here — this file ships to the browser. PKCE replaces it.
//
// There is no model API key here either, and there is nowhere to put one. BigBooks
// calls the model provider with the key stored on the party that owns this OAuth
// client — add yours at https://www.bigbooks.app/ai-secrets. See the README.

export const CONFIG = {
  CLIENT_ID: '',                                  // <-- your public client_id

  // Authorization server (issuer) and REST API live on different hosts.
  ISSUER: 'https://www.bigbooks.app',
  API: 'https://api.bigbooks.app',
  AUTHORIZE_URL: 'https://www.bigbooks.app/oauth2/authorize',
  TOKEN_URL: 'https://www.bigbooks.app/oauth2/token',
  USERINFO_URL: 'https://www.bigbooks.app/oauth2/userInfo',

  // Where you manage the BYOK model provider keys this app spends.
  SECRETS_URL: 'https://www.bigbooks.app/ai-secrets',

  // openid is required to receive the `bigbooks:party` userInfo claim.
  SCOPES: 'openid profile email',

  // Where the OAuth redirect lands. Must exactly match a registered redirect URI.
  REDIRECT_URI: window.location.origin + window.location.pathname,

  // BASIC answers with the domain tools; AGENTIC adds workflow orchestration
  // (routing, parallelization, orchestrator-workers) on top of them.
  DEFAULT_CHAT_TYPE: 'BASIC',

  // How many suggested prompts the empty state offers.
  SUGGESTION_COUNT: 5,
};
