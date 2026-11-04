// ═══════════════════════════════════════════════════════════
//  KANGA — serveur bancaire (Cloudflare Worker)
//  Lit les soldes des comptes d'Adam via Enable Banking et les sert à « Espace Adam ».
//
//  À configurer dans Cloudflare (aucun secret dans ce fichier) :
//    Secrets   EB_APP_ID       identifiant de l'application Enable Banking
//              EB_PRIVATE_KEY  contenu complet du fichier .pem téléchargé
//              ADAM_TOKEN      mot de passe long choisi par Adam (accès à ce serveur)
//    KV        liaison nommée BANK
//    Cron      0 */6 * * *     (soldes relus automatiquement 4 fois par jour)
//
//  Routes :
//    GET /                         test (jeton requis)
//    GET /start?aspsp=&country=    relier ou renouveler une banque (jeton requis, redirige vers la banque)
//    GET /callback                 retour de la banque (appelé par Enable Banking)
//    GET /balances[?refresh=1]     soldes, état des consentements, historique (jeton requis)
//    GET /remove?key=              oublier une banque (jeton requis)
//    POST /settings                réglages privés d'Adam, ex. montant Youssouf (jeton requis)
// ═══════════════════════════════════════════════════════════

const EB = 'https://api.enablebanking.com';
const APP_URL = 'https://ada-wq.github.io/gestionnaire-change/';
// type de solde préféré : disponible d'abord, comptable ensuite
const BALANCE_ORDER = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD', 'OPAV', 'OPBD', 'PRCD', 'VALU', 'OTHR', 'INFO', 'FWAV'];
const MIN_REFRESH_MS = 15 * 60 * 1000;   // une actualisation manuelle au plus toutes les 15 minutes

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    try {
      if (url.pathname === '/callback') return await callback(url, env);

      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
      if (!env.ADAM_TOKEN || !safeEqual(token, env.ADAM_TOKEN)) return json({ error: 'Accès refusé' }, 401);

      if (url.pathname === '/start') return await start(url, env);
      if (url.pathname === '/balances') {
        if (url.searchParams.get('refresh') === '1') await refreshAll(env, psuHeaders(req), null, true);
        return json(await publicState(env));
      }
      if (url.pathname === '/settings' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const settings = (await env.BANK.get('settings', 'json')) || {};
        if ('youssouf' in body) {
          const v = Number(body.youssouf);
          if (!isFinite(v)) return json({ error: 'Montant invalide' }, 400);
          settings.youssouf = v;
          settings.youssoufNote = String(body.youssoufNote || '').slice(0, 200);
          settings.youssoufAt = new Date().toISOString();
        }
        await env.BANK.put('settings', JSON.stringify(settings));
        return json(await publicState(env));
      }
      if (url.pathname === '/remove') {
        const banks = (await env.BANK.get('banks', 'json')) || {};
        delete banks[url.searchParams.get('key') || ''];
        await env.BANK.put('banks', JSON.stringify(banks));
        return json(await publicState(env));
      }
      return json({ ok: true, service: 'KANGA banques', configured: !!(env.EB_APP_ID && env.EB_PRIVATE_KEY && env.BANK) });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // déclencheur planifié (cron) : actualisation sans l'utilisateur
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env, null, null, false));
  }
};

// ── Relier une banque : demande d'autorisation puis redirection vers la banque ──
async function start(url, env) {
  const aspsp = url.searchParams.get('aspsp');
  const country = (url.searchParams.get('country') || 'FR').toUpperCase();
  if (!aspsp) return json({ error: 'Paramètre aspsp manquant' }, 400);

  // durée d'accès : la plus longue autorisée par la banque, au plus 180 jours
  let seconds = 180 * 86400;
  try {
    const list = await eb(env, `/aspsps?country=${country}&psu_type=personal`);
    const found = (list.aspsps || []).find(a => a.name === aspsp);
    if (found && found.maximum_consent_validity) seconds = Math.min(seconds, found.maximum_consent_validity);
  } catch (e) { /* on garde 180 jours */ }

  const state = crypto.randomUUID();
  await env.BANK.put('state:' + state, JSON.stringify({ aspsp, country }), { expirationTtl: 900 });
  const r = await eb(env, '/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: new Date(Date.now() + (seconds - 3600) * 1000).toISOString() },
      aspsp: { name: aspsp, country },
      state,
      redirect_url: url.origin + '/callback',
      psu_type: 'personal'
    })
  });
  return Response.redirect(r.url, 302);
}

// ── Retour de la banque : ouverture de la session, mémorisation des comptes ──
async function callback(url, env) {
  const err = url.searchParams.get('error');
  if (err) return backToApp('erreur', url.searchParams.get('error_description') || err);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const st = state ? await env.BANK.get('state:' + state, 'json') : null;
  if (!code || !st) return backToApp('erreur', 'Lien expiré ou invalide : recommencez depuis Espace Adam.');
  await env.BANK.delete('state:' + state);

  const s = await eb(env, '/sessions', { method: 'POST', body: JSON.stringify({ code }) });
  const name = (s.aspsp && s.aspsp.name) || st.aspsp;
  const country = (s.aspsp && s.aspsp.country) || st.country;
  const key = name + '|' + country;
  const banks = (await env.BANK.get('banks', 'json')) || {};
  banks[key] = {
    name, country,
    session_id: s.session_id,
    valid_until: (s.access && s.access.valid_until) || null,
    linkedAt: new Date().toISOString(),
    accounts: (s.accounts || []).map(a => ({
      uid: a.uid,
      iban: (a.account_id && a.account_id.iban) || '',
      name: a.name || a.product || '',
      currency: a.currency || ''
    }))
  };
  await env.BANK.put('banks', JSON.stringify(banks));
  try { await refreshAll(env, null, key, false); } catch (e) { /* les soldes viendront à la prochaine actualisation */ }
  return backToApp('ok', name);
}

// ── Lecture des soldes de toutes les banques (ou d'une seule) ──
async function refreshAll(env, psu, onlyKey, manual) {
  const banks = (await env.BANK.get('banks', 'json')) || {};
  const state = (await env.BANK.get('state', 'json')) || { balances: {}, history: [] };
  if (manual && state.refreshedAt && Date.now() - Date.parse(state.refreshedAt) < MIN_REFRESH_MS) return state;

  for (const [key, bank] of Object.entries(banks)) {
    if (onlyKey && key !== onlyKey) continue;
    for (const acc of bank.accounts) {
      const prev = state.balances[acc.uid] || {};
      try {
        const r = await eb(env, `/accounts/${acc.uid}/balances`, {}, psu);
        const list = r.balances || [];
        const pick = BALANCE_ORDER.map(t => list.find(b => b.balance_type === t)).find(Boolean) || list[0];
        state.balances[acc.uid] = pick
          ? { amount: Number(pick.balance_amount.amount), currency: pick.balance_amount.currency, type: pick.balance_type, at: new Date().toISOString() }
          : { ...prev, error: 'Aucun solde renvoyé par la banque', errorAt: new Date().toISOString() };
      } catch (e) {
        state.balances[acc.uid] = { ...prev, error: String(e.message).slice(0, 240), errorAt: new Date().toISOString() };
      }
    }
  }

  state.refreshedAt = new Date().toISOString();
  // historique : un point par jour, total par devise (KANGA convertit en € à l'affichage)
  const byCur = {};
  for (const bank of Object.values(banks)) for (const acc of bank.accounts) {
    const b = state.balances[acc.uid];
    if (b && typeof b.amount === 'number') byCur[b.currency] = (byCur[b.currency] || 0) + b.amount;
  }
  const day = state.refreshedAt.slice(0, 10);
  state.history = (state.history || []).filter(h => h.d !== day).concat([{ d: day, byCur }]).slice(-400);
  await env.BANK.put('state', JSON.stringify(state));
  return state;
}

// ── Ce qui est envoyé à KANGA (IBAN masqués) ──
async function publicState(env) {
  const banks = (await env.BANK.get('banks', 'json')) || {};
  const state = (await env.BANK.get('state', 'json')) || { balances: {}, history: [] };
  return {
    settings: (await env.BANK.get('settings', 'json')) || {},
    refreshedAt: state.refreshedAt || null,
    history: state.history || [],
    banks: Object.entries(banks).map(([key, b]) => ({
      key, name: b.name, country: b.country, valid_until: b.valid_until, linkedAt: b.linkedAt,
      accounts: b.accounts.map(a => ({
        uid: a.uid, name: a.name, currency: a.currency,
        iban: a.iban ? '•••• ' + a.iban.slice(-4) : '',
        ...(state.balances[a.uid] || {})
      }))
    }))
  };
}

// ── Appels à Enable Banking, signés par un jeton JWT (RS256) ──
async function eb(env, path, opts = {}, psu = null) {
  const r = await fetch(EB + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + (await makeJwt(env)), 'Content-Type': 'application/json', ...(psu || {}) }
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (!r.ok) throw new Error(`Enable Banking ${r.status} sur ${path.split('?')[0]} : ${body.message || body.error || text.slice(0, 200)}`);
  return body;
}

async function makeJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID }) + '.' +
               enc({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 });
  const key = await importPrivateKey(env.EB_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
}

let cachedKey = null;
async function importPrivateKey(pem) {
  if (cachedKey) return cachedKey;
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  if (isPkcs1) der = pkcs1ToPkcs8(der);
  cachedKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return cachedKey;
}
// Clé au format « RSA PRIVATE KEY » (PKCS#1) : on l'enveloppe en PKCS#8, seul format accepté par WebCrypto
function pkcs1ToPkcs8(pkcs1) {
  const len = n => { if (n < 128) return [n]; const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; };
  const tlv = (tag, content) => [tag, ...len(content.length), ...content];
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return new Uint8Array(tlv(0x30, [0x02, 0x01, 0x00, ...rsaAlgorithm, ...tlv(0x04, Array.from(pkcs1))]));
}

// ── Outils ──
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function psuHeaders(req) {
  const ip = req.headers.get('CF-Connecting-IP');
  const ua = req.headers.get('User-Agent');
  return ip && ua ? { 'Psu-Ip-Address': ip, 'Psu-User-Agent': ua } : null;
}
function backToApp(status, msg) {
  return Response.redirect(APP_URL + '#espace-adam?bank=' + status + '&msg=' + encodeURIComponent(msg), 302);
}
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return res;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }));
}
