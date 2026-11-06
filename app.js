// ══════════════════════════════════════════════
//  FIREBASE — BASE PRINCIPALE
// ══════════════════════════════════════════════
const mainCfg = {
  apiKey:"AIzaSyBOze4uwJHuRd-UVOcLemRn1AFxA93UBcQ",
  authDomain:"gestion-change.firebaseapp.com",
  projectId:"gestion-change",
  storageBucket:"gestion-change.firebasestorage.app",
  messagingSenderId:"773358376046",
  appId:"1:773358376046:web:c4de3857d99b6c9608027f",
  databaseURL:"https://gestion-change-default-rtdb.europe-west1.firebasedatabase.app/"
};
// ══════════════════════════════════════════════
//  FIREBASE — BASE MIROIR
// ══════════════════════════════════════════════
const mirrorCfg = {
  apiKey:"AIzaSyAx4BZoKxkD4yMI0RerQLNvgo1dGLtaGIE",
  authDomain:"kanga-backup.firebaseapp.com",
  databaseURL:"https://kanga-backup-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:"kanga-backup",
  storageBucket:"kanga-backup.firebasestorage.app",
  messagingSenderId:"483789075229",
  appId:"1:483789075229:web:0c4acfec76f1459d3467f4"
};

const mainApp   = firebase.initializeApp(mainCfg,   'main');
const mirrorApp = firebase.initializeApp(mirrorCfg, 'mirror');
const db        = firebase.database(mainApp);
const mirrorDb  = firebase.database(mirrorApp);

let euroT = [], cfaT = [], notes = [], holdings = [];
let currentNote = null, noteTimer = null;
let lastDeleted = null, undoTimer = null;
let editingHoldingId = null;
const MAX_SNAPS = 10;
const MIRROR_DAYS = 14;
const TRASH_DAYS = 30;
const SUIVI_ALERT_DAYS = 7;
const OFFICIAL_RATE = 655.957;
const DEFAULT_RATE  = 665;
let customRate = parseFloat(localStorage.getItem('kanga_totalRate')) || DEFAULT_RATE;
const sortState = { euro:{col:'date',dir:-1}, cfa:{col:'date',dir:-1} };

// « Patrimoine avec suivi » : taux du patrimoine (1 € = … CFA) et taux par défaut d'une transaction en cours
const SUIVI_PAT_RATE = 665;
const SUIVI_TX_RATES = { euro: { in: 665, out: 690 }, cfa: { in: 690, out: 665 } };
let suiviPatRate = parseFloat(localStorage.getItem('kanga_suiviPatRate')) || SUIVI_PAT_RATE;
let suiviAdj = [], suiviAdjEditing = null;   // ajustements manuels en €

// ── Taux personnalisé pour le KPI Patrimoine total ──
function applyTotalRate() {
  const v = parseFloat(document.getElementById('totalRate').value);
  customRate = (v && v > 0) ? v : OFFICIAL_RATE;
  localStorage.setItem('kanga_totalRate', customRate);
  db.ref('/settings/customRate').set(customRate).catch(()=>{});
  updateAll();
}
function resetTotalRate() {
  customRate = OFFICIAL_RATE;
  document.getElementById('totalRate').value = '';
  localStorage.removeItem('kanga_totalRate');
  db.ref('/settings/customRate').set(null).catch(()=>{});
  updateAll();
}

// ══ ARGENT DÉTENU PAR DES PERSONNES (hors transactions Euro/CFA) ══
function saveHoldings() { db.ref('/holdings').set(holdings).catch(e => console.error(e)); scheduleMirror(); }
function holdingsTotalEUR() {
  return holdings.reduce((s,h) => s + (h.devise === 'CFA' ? (h.montant||0) / customRate : (h.montant||0)), 0);
}
function patrimoineTotal() {
  const eS = euroT.reduce((a,b) => a + (b.entree||0) - (b.sortie||0), 0);
  const cS = cfaT.reduce((a,b) => a + (b.entree||0) - (b.sortie||0), 0);
  return eS + cS / customRate + holdingsTotalEUR();
}
function addHolding(e) {
  e.preventDefault();
  const personne = document.getElementById('hPerson').value;
  const devise   = document.getElementById('hDevise').value;
  const montant  = parseFloat(document.getElementById('hMontant').value) || 0;
  const remarque = document.getElementById('hNote').value || '';
  requireUnlock(() => {
    if (editingHoldingId) {
      const h = holdings.find(x=>x.id===editingHoldingId);
      if (h) { h.personne = personne; h.devise = devise; h.montant = montant; h.remarque = remarque; }
      editingHoldingId = null;
      document.getElementById('holdingSubmitBtn').textContent = '+ Ajouter';
    } else {
      holdings.push({ id: genId(), personne, devise, montant, remarque, createdAt: new Date().toISOString() });
    }
    saveHoldings(); renderHoldings(); updateAll();
    document.getElementById('holdingForm').reset();
    toast('Enregistré', 'ok');
  });
  return false;
}
function editHolding(id) {
  const h = holdings.find(x=>x.id===id); if (!h) return;
  document.getElementById('hPerson').value   = h.personne;
  document.getElementById('hDevise').value   = h.devise;
  document.getElementById('hMontant').value  = h.montant;
  document.getElementById('hNote').value     = h.remarque || '';
  editingHoldingId = id;
  document.getElementById('holdingSubmitBtn').textContent = 'Mettre à jour';
  document.getElementById('hPerson').focus();
}
function deleteHolding(id) {
  if (!confirm('Supprimer ce montant ?')) return;
  const idx = holdings.findIndex(x=>x.id===id);
  if (idx < 0) return;
  const item = holdings[idx];
  requireUnlock(() => {
    holdings.splice(idx, 1);
    saveHoldings(); renderHoldings(); updateAll();
    toast('Montant supprimé', '', () => {
      holdings.splice(idx, 0, item);
      saveHoldings(); renderHoldings(); updateAll();
      toast('Suppression annulée', 'ok');
    });
  });
}
function renderHoldings() {
  const body = document.getElementById('holdingsBody');
  const cnt  = document.getElementById('holdingsCount');
  if (!body) return;
  cnt.textContent = holdings.length + ' entrée' + (holdings.length>1?'s':'');
  if (!holdings.length) { body.innerHTML = '<tr><td colspan="6" class="empty">Aucun montant enregistré</td></tr>'; return; }
  body.innerHTML = holdings.map(h => {
    const eq     = fmtEuro(h.devise==='CFA' ? (h.montant||0)/customRate : (h.montant||0));
    const native = h.devise==='CFA' ? fmtCFA(h.montant||0) : fmtEuro(h.montant||0);
    return `<tr>
      <td class="c-person"><span class="person-link" data-name="${esc(h.personne)}">${esc(h.personne)}</span></td>
      <td class="c-cur"><span class="badge ${h.devise==='EUR'?'badge-euro':'badge-cfa'}">${h.devise}</span></td>
      <td class="c-amt num" style="font-weight:600;">${native}</td>
      <td class="c-eq num">${eq}</td>
      <td class="c-note${h.remarque ? '' : ' is-empty'}">${esc(h.remarque)||'—'}</td>
      <td class="c-act">
        <button class="act-btn" onclick="editHolding('${h.id}')" title="Modifier">${svgIc('edit')}</button>
        <button class="act-btn act-del" onclick="deleteHolding('${h.id}')" title="Supprimer">${svgIc('trash')}</button>
      </td>
    </tr>`;
  }).join('');
}

// ══ RECHERCHE GLOBALE (personne, remarque, date, montant, devise, taux) ══
let gsBlurTimer = null;
function onGlobalSearch(qRaw) {
  const box = document.getElementById('gsResults');
  const q = qRaw.trim().toLowerCase();
  if (!q) { box.classList.remove('show'); box.innerHTML=''; return; }
  const all = [
    ...euroT.map((t,i)=>({...t, cur:'euro', _idx:i})),
    ...cfaT.map((t,i)=>({...t, cur:'cfa', _idx:i}))
  ];
  const results = all.filter(t => {
    const hay = [
      t.personne, t.remarque, t.categorie, t.date, t.operation,
      String(t.entree), String(t.sortie), String(t.taux||''), t.cur==='euro'?'euro €':'cfa fcfa'
    ].join(' ').toLowerCase();
    return hay.includes(q);
  }).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);

  if (!results.length) {
    box.innerHTML = '<div class="gs-empty">Aucun résultat pour « ' + esc(qRaw) + ' »</div>';
  } else {
    const fmt = (t) => t.cur==='euro' ? fmtEuro(t.entree||t.sortie) : fmtCFA(t.entree||t.sortie);
    box.innerHTML = results.map(t => `
      <div class="gs-item" onmousedown="goToResult('${t.cur}','${t._idx}')">
        <div class="gs-item-left">
          <div class="gs-item-title">${esc(t.personne)} <span class="badge badge-cat" style="margin-left:4px;">${t.cur==='euro'?'€':'CFA'}</span></div>
          <div class="gs-item-sub">${t.date} · ${esc(t.categorie||t.operation)} ${t.remarque?'· '+esc(t.remarque):''}</div>
        </div>
        <div class="gs-item-amt ${t.entree>0?'val-in':'val-out'}">${fmt(t)}</div>
      </div>`).join('') + `<div class="gs-footer">${results.length} résultat(s) affiché(s)</div>`;
  }
  box.classList.add('show');
}
function goToResult(cur, idx) {
  switchTab(cur);
  const t = cur==='euro' ? euroT[idx] : cfaT[idx];
  if (t) {
    document.getElementById(cur+'Srch').value = t.personne;
    applyFilters(cur);
  }
  document.getElementById('gsResults').classList.remove('show');
  document.getElementById('globalSearch').value = '';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.global-search-wrap')) document.getElementById('gsResults').classList.remove('show');
});

// ══ FICHE PERSONNE ══
function openPersonProfile(name) {
  const eT = euroT.filter(t=>t.personne===name);
  const cT = cfaT.filter(t=>t.personne===name);
  const eBal = eT.reduce((a,b)=>a+b.entree-b.sortie,0);
  const cBal = cT.reduce((a,b)=>a+b.entree-b.sortie,0);
  const all = [
    ...eT.map(t=>({...t, cur:'EUR'})),
    ...cT.map(t=>({...t, cur:'CFA'}))
  ].sort((a,b)=>b.date.localeCompare(a.date));
  const firstDate = all.length ? all[all.length-1].date : '—';
  const lastDate = all.length ? all[0].date : '—';

  document.getElementById('personName').textContent = name;
  document.getElementById('personMeta').textContent =
    `${all.length} transaction${all.length>1?'s':''} · du ${firstDate} au ${lastDate}`;
  document.getElementById('personStats').innerHTML = `
    <div class="kpi kpi-euro" style="padding:14px 16px;" data-icon="💶">
      <div class="kpi-label">Balance Euro</div>
      <div class="kpi-value" style="font-size:1.15rem;">${fmtEuro(eBal)}</div>
    </div>
    <div class="kpi kpi-cfa" style="padding:14px 16px;" data-icon="💵">
      <div class="kpi-label">Balance CFA</div>
      <div class="kpi-value" style="font-size:1.15rem;">${fmtCFA(cBal)}</div>
    </div>
    <div class="kpi kpi-neutral" style="padding:14px 16px;" data-icon="🔄">
      <div class="kpi-label">Transactions</div>
      <div class="kpi-value" style="font-size:1.15rem;">${all.length}</div>
    </div>`;
  document.getElementById('personHistory').innerHTML = all.length ? all.map(t => `
    <div class="snap-item" style="margin-bottom:6px;">
      <div class="snap-info">
        <div class="snap-date">${t.date} <span class="badge ${t.operation==='Entrée'?'badge-in':'badge-out'}" style="margin-left:6px;">${t.operation}</span></div>
        <div class="snap-meta">${t.categorie?esc(t.categorie)+' · ':''}${esc(t.remarque)||'—'}</div>
      </div>
      <div class="${t.entree>0?'val-in':'val-out'}">${t.cur==='EUR'?fmtEuro(t.entree||t.sortie):fmtCFA(t.entree||t.sortie)}</div>
    </div>`).join('') : '<div class="snap-empty">Aucune transaction</div>';
  document.getElementById('personModal').classList.add('open');
}
function closePersonProfile() { document.getElementById('personModal').classList.remove('open'); }

// ══ VERROUILLAGE PAR CODE (écriture/modification/suppression) ══
const KANGA_PIN = '2326';
let pendingAction = null;
function isUnlocked() { return localStorage.getItem('kanga_unlocked') === '1'; }
function requireUnlock(action) {
  if (isUnlocked()) { action(); return; }
  pendingAction = action;
  document.getElementById('pinError').textContent = '';
  document.getElementById('pinInput').value = '';
  document.getElementById('pinModal').classList.add('open');
  setTimeout(()=>document.getElementById('pinInput').focus(), 100);
}
function closePinModal() {
  document.getElementById('pinModal').classList.remove('open');
  pendingAction = null;
}
function submitPin(e) {
  e.preventDefault();
  const val = document.getElementById('pinInput').value;
  if (val === KANGA_PIN) {
    localStorage.setItem('kanga_unlocked', '1');
    document.getElementById('pinModal').classList.remove('open');
    toast('Appareil déverrouillé', 'ok');
    const act = pendingAction; pendingAction = null;
    if (act) act();
  } else {
    document.getElementById('pinError').textContent = 'Code incorrect, réessayez.';
    document.getElementById('pinInput').value = '';
    document.getElementById('pinInput').focus();
  }
  return false;
}

// ══ VERROU D'ACCÈS — écran plein avant ouverture de l'application ══
function checkAppLock() {
  const overlay = document.getElementById('appLock');
  if (isUnlocked()) { overlay.style.display = 'none'; return; }
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('appLockInput')?.focus(), 150);
}
function submitAppLock(e) {
  e.preventDefault();
  const val = document.getElementById('appLockInput').value;
  if (val === KANGA_PIN) {
    localStorage.setItem('kanga_unlocked', '1');
    document.getElementById('appLock').style.display = 'none';
  } else {
    document.getElementById('appLockError').textContent = 'Code incorrect, réessayez.';
    document.getElementById('appLockInput').value = '';
    document.getElementById('appLockInput').focus();
  }
  return false;
}

// ══ THÈME (synchronisé via Firebase /settings/theme) ══
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeBtn').innerHTML = svgIc(t === 'dark' ? 'sun' : 'moon');
  const st = document.getElementById('themeState');
  if (st) st.textContent = t === 'dark' ? 'Sombre' : 'Clair';
  // couleur de la barre d'état du téléphone
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1e1b4b' : '#312e81');
}
function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  db.ref('/settings/theme').set(t).catch(()=>{});
}

// ── TOAST (avec bouton Annuler optionnel) ──
function toast(msg, type='', undoFn=null) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${msg}</span>` + (undoFn ? `<button class="toast-undo" onclick="doUndo()">Annuler</button>` : '');
  el.className = 'toast show ' + type;
  window._undoFn = undoFn;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => el.className = 'toast', undoFn ? 6000 : 3000);
}
function doUndo() {
  if (window._undoFn) { window._undoFn(); window._undoFn = null; }
  document.getElementById('toast').className = 'toast';
}

// ── CONNECTION ──
// Retire les symboles (✓ ✗ ⏳ …) en tête des anciens libellés d'état
function cleanStatus(text) { return String(text).replace(/^[^\wÀ-ÿ]+/, ''); }

function setConn(state, text) {
  const p = document.getElementById('connPill');
  document.getElementById('connText').textContent = cleanStatus(text);
  p.className = 'status ' + (state === 'online' ? 'st-ok' : state === 'sync' ? 'st-sync' : 'st-off');
}

// ── MIRROR STATUS ──
function setMirror(state, text) {
  const p = document.getElementById('mirrorPill');
  p.className = 'status ' + ({ ok: 'st-ok', sync: 'st-sync', error: 'st-off' }[state] || 'st-idle');
  p.innerHTML = '<span class="dot"></span>' + esc(cleanStatus(text));
}

// ════════════════════════════════════════════
//  SAUVEGARDE MIROIR — auto à chaque transaction
// ════════════════════════════════════════════
async function syncMirror(manual = false) {
  setMirror('sync', '⏳ Sauvegarde...');
  const now  = new Date();
  const key  = now.toISOString().replace(/[:.]/g, '-');
  const snap = {
    savedAt: now.toISOString(),
    label: manual ? 'Manuel' : 'Auto',
    euroCount: euroT.length, cfaCount: cfaT.length, notesCount: notes.length, holdingsCount: holdings.length,
    euroTransactions: euroT, cfaTransactions: cfaT, notes: notes, holdings: holdings, suiviAjustements: suiviAdj
  };
  try {
    await mirrorDb.ref(`/history/${key}`).set(snap);
    await mirrorDb.ref('/latest').set({ savedAt: snap.savedAt, label: snap.label, euroCount: snap.euroCount, cfaCount: snap.cfaCount });
    await pruneSnaps();
    const ts = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    const ds = now.toLocaleDateString('fr-FR');
    setMirror('ok', `Sauvegardé à ${ts}`);
    document.getElementById('backupSub').innerHTML =
      `Dernière sauvegarde : <b>${ds} à ${ts}</b> · ${manual ? 'Manuelle' : 'Auto (modification)'}`;
    if (manual) toast('Sauvegarde créée', 'ok');
  } catch(e) {
    console.error(e);
    setMirror('error', 'Échec de la sauvegarde');
    if (manual) toast('Erreur lors de la sauvegarde', 'err');
  }
}

async function pruneSnaps() {
  const snap = await mirrorDb.ref('/history').once('value');
  if (!snap.exists()) return;
  const keys = Object.keys(snap.val()).sort();
  // on garde les MAX_SNAPS plus récentes + la plus récente de chacun des MIRROR_DAYS derniers jours
  const keep = new Set(keys.slice(-MAX_SNAPS));
  const days = new Set();
  for (const k of keys.slice().reverse()) {
    const day = k.slice(0, 10);
    if (!days.has(day) && days.size < MIRROR_DAYS) { days.add(day); keep.add(k); }
  }
  const upd = {};
  keys.filter(k => !keep.has(k)).forEach(k => upd[`/history/${k}`] = null);
  if (Object.keys(upd).length) await mirrorDb.ref().update(upd);
}

// Sauvegarde miroir automatique 4 s après la dernière modification (regroupe les rafales)
let mirrorTimer = null;
function scheduleMirror() { clearTimeout(mirrorTimer); mirrorTimer = setTimeout(() => syncMirror(false), 4000); }

async function loadHistorySnaps() {
  const snap = await mirrorDb.ref('/history').once('value');
  if (!snap.exists()) return [];
  return Object.entries(snap.val()).map(([k,v]) => ({key:k, ...v}))
    .sort((a,b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function renderSnapList(list, containerId, withBtn) {
  const el = document.getElementById(containerId);
  if (!list.length) { el.innerHTML = '<div class="snap-empty">Aucune sauvegarde disponible.<br>Ajoutez une transaction pour créer la première.</div>'; return; }
  el.innerHTML = list.map(s => {
    const d = new Date(s.savedAt);
    const date = d.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
    const time = d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});
    const tag = s.label === 'Auto' ? '<span class="snap-tag snap-tag-auto">Auto</span>' : '<span class="snap-tag snap-tag-manual">Manuel</span>';
    return `<div class="snap-item">
      <div class="snap-info">
        <div class="snap-date">${date} · ${time} ${tag}</div>
        <div class="snap-meta">${s.euroCount || 0} transactions Euro · ${s.cfaCount || 0} CFA · ${s.notesCount || 0} notes</div>
      </div>
      ${withBtn ? `<button class="snap-restore-btn" onclick="confirmRestore('${s.key}','${date} à ${time}')">${svgIc('restore')}Restaurer</button>` : ''}
    </div>`;
  }).join('');
}

async function openHistory() {
  document.getElementById('histModal').classList.add('open');
  document.getElementById('histList').innerHTML = '<div class="loading">Chargement...</div>';
  renderSnapList(await loadHistorySnaps(), 'histList', true);
}
function closeHistory() { document.getElementById('histModal').classList.remove('open'); }
async function openRestore() {
  document.getElementById('restModal').classList.add('open');
  document.getElementById('restList').innerHTML = '<div class="loading">Chargement...</div>';
  renderSnapList(await loadHistorySnaps(), 'restList', true);
}
function closeRestore() { document.getElementById('restModal').classList.remove('open'); }

async function confirmRestore(key, label) {
  if (!confirm(`Restaurer les données du :\n${label}\n\nLes données actuelles seront remplacées. Continuer ?`)) return;
  requireUnlock(async () => {
    setMirror('sync', '⏳ Restauration...');
    try {
      const snap = await mirrorDb.ref(`/history/${key}`).once('value');
      if (!snap.exists()) { toast('Snapshot introuvable', 'err'); return; }
      const d = snap.val();
      euroT = toArr(d.euroTransactions);
      cfaT  = toArr(d.cfaTransactions);
      notes = toArr(d.notes);
      await db.ref().update({ '/euroTransactions': euroT, '/cfaTransactions': cfaT });
      await db.ref('/notes').set(notes);
      // les anciennes sauvegardes n'ont pas de holdings : on ne touche pas aux montants détenus dans ce cas
      if (d.holdings) { holdings = toArr(d.holdings); await db.ref('/holdings').set(holdings); renderHoldings(); }
      if (d.suiviAjustements) await db.ref('/suiviAjustements').set(suiviAdjObject(d.suiviAjustements));
      updateAll(); renderNotesList(); closeHistory(); closeRestore();
      setMirror('ok', '✅ Restauré');
      logAction('Restauration miroir', null, null, label);
      toast('Données restaurées avec succès', 'ok');
    } catch(e) { console.error(e); setMirror('error','✗ Échec'); toast('Erreur restauration','err'); }
  });
}

// ════════════════════════════════════════════
//  BASE PRINCIPALE — LECTURE / ÉCRITURE
// ════════════════════════════════════════════
function saveToDB() {
  setConn('sync', 'Sync...');
  db.ref().update({ '/euroTransactions': euroT, '/cfaTransactions': cfaT })
    .then(() => setConn('online', '✓ Connecté'))
    .catch(() => { setConn('offline', '✗ Hors ligne'); toast('Erreur de synchronisation', 'err'); });
}
function saveNotes() { db.ref('/notes').set(notes).catch(e => console.error(e)); }

// Firebase renvoie un objet (et non un tableau) si les index sont creux
function toArr(v) { return Array.isArray(v) ? v.filter(Boolean) : (v ? Object.values(v) : []); }
const TX_PATH = { euro:'euroTransactions', cfa:'cfaTransactions' };

// Modification atomique d'une liste de transactions : fn reçoit le tableau courant du serveur
// et renvoie le nouveau tableau. Évite d'écraser les changements faits depuis un autre appareil.
function mutateTx(type, fn) {
  setConn('sync', 'Sync...');
  return db.ref(TX_PATH[type]).transaction(cur => fn(toArr(cur)))
    .then(res => { setConn('online', '✓ Connecté'); scheduleMirror(); return res; })
    .catch(() => { setConn('offline', '✗ Hors ligne'); toast('Erreur de synchronisation', 'err'); return null; });
}

function onTxSnapshot(type, s) {
  let arr = toArr(s.val());
  if (arr.some(t => !t.id)) {
    // migration : les anciennes transactions reçoivent un identifiant stable
    const fixed = arr.map(t => t.id ? t : { ...t, id: genId() });
    mutateTx(type, a => a.map((t,i) => t.id ? t : { ...t, id: (fixed[i] && fixed[i].id) || genId() }));
    arr = fixed;
  }
  if (type === 'euro') euroT = arr; else cfaT = arr;
  document.getElementById(type + 'Loading').style.display = 'none';
  updateAll();
}

function listen() {
  setConn('sync', 'Connexion...');
  db.ref('euroTransactions').on('value', s => onTxSnapshot('euro', s));
  db.ref('cfaTransactions').on('value', s => onTxSnapshot('cfa', s));
  db.ref('notes').on('value', s => {
    notes = s.exists() ? s.val() : [];
    renderNotesList();
    saveLocalCache();
  });
  db.ref('holdings').on('value', s => {
    holdings = s.exists() ? s.val() : [];
    renderHoldings();
    updateAll();
  });
  db.ref('settings/theme').on('value', s => { if (s.exists()) applyTheme(s.val()); });
  db.ref('settings/customRate').on('value', s => {
    if (s.exists() && s.val()) { customRate = s.val(); localStorage.setItem('kanga_totalRate', customRate); }
    else if (s.exists() === false || s.val() === null) { customRate = OFFICIAL_RATE; }
    updateAll();
  });
  db.ref('settings/suiviPatRate').on('value', s => {
    const v = parseFloat(s.val());
    suiviPatRate = v > 0 ? v : SUIVI_PAT_RATE;
    try { localStorage.setItem('kanga_suiviPatRate', suiviPatRate); } catch (e) {}
    updateAll();
  });
  db.ref('suiviAjustements').on('value', s => {
    suiviAdj = Object.values(s.val() || {}).filter(a => a && a.id).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    updateAll();
  });
  db.ref('.info/connected').on('value', s => {
    setConn(s.val() ? 'online' : 'offline', s.val() ? '✓ Connecté' : '✗ Hors ligne');
  });
}

// ════════════════════════════════════════════
//  DONNÉES INITIALES (si base vide)
// ════════════════════════════════════════════
const HD = {
  euro:[
    {date:'2024-01-01',operation:'Sortie',entree:0,sortie:0,personne:'Youssouf / Abakar',remarque:''},
    {date:'2024-01-02',operation:'Entrée',entree:3000,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-03',operation:'Sortie',entree:0,sortie:23,personne:'Issa',remarque:'Différence taux 670 et 675'},
    {date:'2024-01-04',operation:'Sortie',entree:0,sortie:1482,personne:'Ibni',remarque:''},
    {date:'2024-01-05',operation:'Sortie',entree:0,sortie:72,personne:'Ibni',remarque:''},
    {date:'2024-01-06',operation:'Entrée',entree:148,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-07',operation:'Entrée',entree:1874,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-08',operation:'Entrée',entree:74,sortie:0,personne:'Issa',remarque:'Médicament'},
    {date:'2024-01-09',operation:'Sortie',entree:0,sortie:512,personne:'Berdei',remarque:'Médicament'},
    {date:'2024-01-10',operation:'Sortie',entree:0,sortie:701,personne:'Soulou',remarque:'Médicament'},
    {date:'2024-01-11',operation:'Sortie',entree:0,sortie:47,personne:'Youssouf',remarque:'Part Youssouf pharma'},
    {date:'2024-01-12',operation:'Entrée',entree:224,sortie:0,personne:'Moi',remarque:'100000/3 = 33 333,333'},
    {date:'2024-01-13',operation:'Entrée',entree:74,sortie:0,personne:'Issa',remarque:'33333/700 = 47,619'},
    {date:'2024-01-14',operation:'Entrée',entree:3000,sortie:0,personne:'Faris',remarque:'SOLDE FINAL'},
    {date:'2024-01-15',operation:'Sortie',entree:0,sortie:2421.4,personne:'Youssouf pharmacie',remarque:'Valise commande'},
    {date:'2024-01-16',operation:'Entrée',entree:100,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-17',operation:'Sortie',entree:0,sortie:2200,personne:'Retrait',remarque:'Retrait espèce'},
    {date:'2024-01-18',operation:'Entrée',entree:3315,sortie:0,personne:'Issa',remarque:'4000$ Issa'},
    {date:'2024-01-19',operation:'Sortie',entree:0,sortie:1000,personne:'Youssouf',remarque:'Youssouf'},
    {date:'2024-01-20',operation:'Entrée',entree:3000,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-21',operation:'Entrée',entree:794,sortie:0,personne:'Ms Ibni',remarque:''},
    {date:'2024-01-22',operation:'Entrée',entree:300,sortie:0,personne:'Ms ibni',remarque:''},
    {date:'2024-01-23',operation:'Entrée',entree:100,sortie:0,personne:'Issa',remarque:''},
    {date:'2024-01-24',operation:'Sortie',entree:0,sortie:70,personne:'Issa',remarque:'Bénéfice Issa'}
  ],
  cfa:[
    {date:'2024-01-01',operation:'Entrée',entree:4865000,sortie:0,personne:'Capital initial',remarque:''},
    {date:'2024-01-02',operation:'Sortie',entree:0,sortie:400000,personne:'You',remarque:''},
    {date:'2024-01-03',operation:'Sortie',entree:0,sortie:350000,personne:'Abakar Doungous',remarque:''},
    {date:'2024-01-04',operation:'Sortie',entree:0,sortie:2020000,personne:'Issa',remarque:''},
    {date:'2024-01-05',operation:'Sortie',entree:0,sortie:100000,personne:'Moi',remarque:''},
    {date:'2024-01-06',operation:'Entrée',entree:1030000,sortie:0,personne:'Ibni Alhadj',remarque:''},
    {date:'2024-01-07',operation:'Sortie',entree:0,sortie:10000,personne:'Abbas',remarque:'Retrait Abbas'},
    {date:'2024-01-08',operation:'Entrée',entree:50000,sortie:0,personne:'Ibni',remarque:''},
    {date:'2024-01-09',operation:'Sortie',entree:0,sortie:100000,personne:'Issa',remarque:''},
    {date:'2024-01-10',operation:'Sortie',entree:0,sortie:1265000,personne:'Issa',remarque:''},
    {date:'2024-01-11',operation:'Sortie',entree:0,sortie:50000,personne:'Issa',remarque:''},
    {date:'2024-01-12',operation:'Sortie',entree:0,sortie:10000,personne:'Abbas',remarque:'Retrait Abbas'},
    {date:'2024-01-13',operation:'Sortie',entree:0,sortie:50000,personne:'Moi',remarque:''},
    {date:'2024-01-14',operation:'Entrée',entree:460000,sortie:0,personne:'Youssouf pharmacie',remarque:''},
    {date:'2024-01-15',operation:'Sortie',entree:0,sortie:50000,personne:'Issa',remarque:''},
    {date:'2024-01-16',operation:'Sortie',entree:0,sortie:10000,personne:'Abbas',remarque:'Retrait Abbas'},
    {date:'2024-01-17',operation:'Sortie',entree:0,sortie:67500,personne:'Issa',remarque:''},
    {date:'2024-01-18',operation:'Sortie',entree:0,sortie:532000,personne:'Ms Ibni',remarque:''},
    {date:'2024-01-19',operation:'Sortie',entree:0,sortie:67000,personne:'Issa',remarque:''}
  ]
};

// ════════════════════════════════════════════
//  FORMATS
// ════════════════════════════════════════════
function fmtEuro(n) { return n.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' €'; }
function fmtCFA(n)  { return Math.round(n).toLocaleString('fr-FR') + ' CFA'; }
// Icône du sprite SVG défini dans index.html
function svgIc(name) { return `<svg class="ic"><use href="#i-${name}"/></svg>`; }
function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ════════════════════════════════════════════
//  TABS
// ════════════════════════════════════════════
const PAGES = {
  suivi:     ['Suivi', ''],
  dash:      ['Tableau de bord', 'Soldes, montants détenus et dernières opérations'],
  euro:      ['Euro', ''],
  cfa:       ['CFA', ''],
  analytics: ['Analyses', 'Entrées, sorties et tendances'],
  notes:     ['Notes', 'Notes partagées'],
  assistant: ['Assistant IA', 'Posez vos questions sur vos transactions, votre patrimoine et vos notes'],
  adam:      ['Espace Adam', 'Soldes de mes banques']
};
let currentTab = 'suivi';

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(tab + 'Tab').classList.add('active');
  if (tab === 'analytics') renderAnalytics();
  if (tab === 'dash') renderDashboard();
  if (tab === 'suivi') renderSuivi();
  if (tab === 'assistant') aiRender();
  if (tab === 'adam') adamRender();
  document.getElementById('topbar').classList.remove('search-open');
  updateNav(tab);
  updatePageHeader();
  window.scrollTo({ top: 0 });
}

// Titre et sous-titre de la barre du haut, selon la page affichée
function updatePageHeader() {
  const [title, sub] = PAGES[currentTab] || ['', ''];
  let s = sub;
  if (currentTab === 'euro' || currentTab === 'cfa') {
    const arr = currentTab === 'euro' ? euroT : cfaT;
    const bal = arr.reduce((a, b) => a + (b.entree || 0) - (b.sortie || 0), 0);
    s = `Solde : ${currentTab === 'euro' ? fmtEuro(bal) : fmtCFA(bal)} · ${arr.length} transaction${arr.length > 1 ? 's' : ''}`;
  } else if (currentTab === 'suivi') {
    const open = [...euroT, ...cfaT].filter(t => t.statut === 'en_cours');
    const late = open.filter(t => suiviAge(t) > SUIVI_ALERT_DAYS).length;
    s = open.length ? `${open.length} à vérifier${late ? ` · ${late} en retard` : ''}` : 'Tout est à jour';
  }
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSub').textContent = s;
}

// ── Navigation téléphone : barre du bas, menu "Plus", bouton + ──
function updateNav(tab) {
  const main = ['dash', 'euro', 'cfa', 'suivi'];
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === (main.includes(tab) ? tab : 'more'));
  });
  document.getElementById('fab').classList.toggle('show', main.includes(tab));
}
function openMore() {
  document.getElementById('moreConn').textContent = 'Connexion : ' + document.getElementById('connText').textContent;
  document.getElementById('moreBackup').innerHTML = document.getElementById('backupSub').innerHTML;
  document.getElementById('moreSheet').classList.add('open');
}
function closeMore() { document.getElementById('moreSheet').classList.remove('open'); }
function moreGo(fn) { closeMore(); fn(); }
function toggleSearch() {
  const bar = document.getElementById('topbar');
  bar.classList.toggle('search-open');
  if (bar.classList.contains('search-open')) setTimeout(() => document.getElementById('globalSearch').focus(), 50);
}

// ── Nouvelle transaction : fenêtre Euro ou CFA ──
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openAdd(type) {
  closeModal('addChoiceModal');
  const today = new Date().toISOString().split('T')[0];
  const dateEl = document.getElementById(type === 'euro' ? 'eDate' : 'cDate');
  if (!dateEl.value) dateEl.value = today;
  document.getElementById(type === 'euro' ? 'addEuroModal' : 'addCfaModal').classList.add('open');
  setTimeout(() => document.getElementById(type === 'euro' ? 'ePerson' : 'cPerson').focus(), 120);
}
function closeAdd(type) { closeModal(type === 'euro' ? 'addEuroModal' : 'addCfaModal'); }
// sur les pages Euro / CFA on ouvre directement la bonne devise, sinon on demande
function newTx() {
  if (currentTab === 'euro' || currentTab === 'cfa') openAdd(currentTab);
  else document.getElementById('addChoiceModal').classList.add('open');
}
// anciens noms conservés
function goAdd(type) { openAdd(type); }
function quickAdd() { newTx(); }

// ════════════════════════════════════════════
//  CONVERTISSEUR
// ════════════════════════════════════════════
function getRate() { return parseFloat(document.getElementById('cvRate').value) || OFFICIAL_RATE; }
function convert(src) {
  const rate = getRate();
  const eurEl = document.getElementById('cvEur'), cfaEl = document.getElementById('cvCfa');
  if (src === 'eur') {
    const v = parseFloat(eurEl.value);
    cfaEl.value = isNaN(v) ? '' : Math.round(v * rate);
  } else {
    const v = parseFloat(cfaEl.value);
    eurEl.value = isNaN(v) ? '' : (v / rate).toFixed(2);
  }
  const e = parseFloat(eurEl.value), c = parseFloat(cfaEl.value);
  document.getElementById('cvResult').textContent = (!isNaN(e) && !isNaN(c))
    ? `${fmtEuro(e)} = ${fmtCFA(c)} · taux 1 € = ${rate.toLocaleString('fr-FR')} CFA`
    : 'Saisissez un montant pour convertir.';
}
function swapConvert() {
  // Le montant affiché en € devient le montant CFA (et inversement), puis on recalcule
  const eurEl = document.getElementById('cvEur'), cfaEl = document.getElementById('cvCfa');
  const e = eurEl.value;
  eurEl.value = cfaEl.value;
  cfaEl.value = e;
  convert('eur');
}
function setRate(r) { document.getElementById('cvRate').value = r; convert('eur'); }

// ════════════════════════════════════════════
//  FILTRES + TRI
// ════════════════════════════════════════════
function getFilters(t) {
  return {
    q:    document.getElementById(t+'Srch').value.toLowerCase(),
    op:   document.getElementById(t+'FOp').value,
    cat:  document.getElementById(t+'FCat').value,
    from: document.getElementById(t+'FFrom').value,
    to:   document.getElementById(t+'FTo').value
  };
}
function filterT(arr, f) {
  return arr.filter(t => {
    const hay = (t.personne + ' ' + (t.remarque||'') + ' ' + (t.categorie||'')).toLowerCase();
    if (f.q && !hay.includes(f.q)) return false;
    if (f.op && t.operation !== f.op) return false;
    if (f.cat && (t.categorie||'') !== f.cat) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    return true;
  });
}
// Solde cumulé calculé dans l'ordre chronologique, quel que soit l'ordre d'affichage
function withSolde(arr) {
  const order = arr.map((t,i) => ({t, i}))
    .sort((a,b) => (a.t.date||'').localeCompare(b.t.date||'') || a.i - b.i);
  let s = 0; const bal = new Map();
  order.forEach(o => { s += (o.t.entree||0) - (o.t.sortie||0); bal.set(o.i, s); });
  return arr.map((t,i) => ({...t, solde: bal.get(i), _i: i}));
}

function sortTable(type, col) {
  const st = sortState[type];
  if (st.col === col) st.dir = -st.dir; else { st.col = col; st.dir = 1; }
  applyFilters(type);
}
function applySort(type, rows) {
  const st = sortState[type];
  ['date','entree','sortie','personne'].forEach(c => {
    const el = document.getElementById(`${type}-arr-${c}`);
    if (el) el.textContent = st.col === c ? (st.dir === 1 ? '▲' : '▼') : '';
  });
  if (!st.col) return rows;
  const c = st.col, d = st.dir;
  return [...rows].sort((a,b) => {
    const va = a[c], vb = b[c];
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va - vb);
    return cmp * d || (a._i - b._i) * d;
  });
}
const PAGE_SIZE = 15;
const pageState = { euro:1, cfa:1 };
function applyFilters(type) {
  const arr = type === 'euro' ? euroT : cfaT;
  const rows = applySort(type, filterT(withSolde(arr), getFilters(type)));
  const maxPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (pageState[type] > maxPage) pageState[type] = maxPage;
  const start = (pageState[type]-1) * PAGE_SIZE;
  displayT(type, rows.slice(start, start + PAGE_SIZE), rows.length, maxPage);
}
function goToPage(type, page) {
  const rows = applySort(type, filterT(withSolde(type==='euro'?euroT:cfaT), getFilters(type)));
  const maxPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  pageState[type] = Math.min(Math.max(1, page), maxPage);
  applyFilters(type);
}
function filterChanged(type) { pageState[type] = 1; applyFilters(type); }
function resetFilters(type) {
  ['Srch','FOp','FCat','FFrom','FTo'].forEach(s => {
    const el = document.getElementById(type+s);
    if (el) el.value = '';
  });
  sortState[type] = {col:'date', dir:-1};
  pageState[type] = 1;
  applyFilters(type);
}
// ════════════════════════════════════════════
//  MISE À JOUR GLOBALE
// ════════════════════════════════════════════
function updateAll() {
  const eS = euroT.reduce((a,b)=>a+b.entree-b.sortie,0);
  const cS = cfaT.reduce((a,b)=>a+b.entree-b.sortie,0);
  const total = patrimoineTotal();

  const curMonth = new Date().toISOString().slice(0,7);
  const mE = euroT.filter(t=>t.date.startsWith(curMonth));
  const mC = cfaT.filter(t=>t.date.startsWith(curMonth));
  const mIn  = mE.reduce((a,b)=>a+b.entree,0) + mC.reduce((a,b)=>a+b.entree,0)/customRate;
  const mOut = mE.reduce((a,b)=>a+b.sortie,0) + mC.reduce((a,b)=>a+b.sortie,0)/customRate;

  document.getElementById('kpiEuro').textContent    = fmtEuro(eS);
  document.getElementById('kpiEuroSub').textContent = eS >= 0 ? '▲ Positif' : '▼ Négatif';
  document.getElementById('kpiCFA').textContent     = fmtCFA(cS);
  document.getElementById('kpiCFASub').textContent  = cS >= 0 ? '▲ Positif' : '▼ Négatif';
  document.getElementById('kpiTotal').textContent   = fmtEuro(total);
  document.getElementById('kpiTotalSub').textContent = `1€ = ${customRate.toLocaleString('fr-FR')} CFA` + (customRate !== OFFICIAL_RATE ? ' (personnalisé)' : ' (officiel)');
  if (!document.getElementById('totalRate').matches(':focus') && !document.getElementById('totalRate').value) {
    document.getElementById('totalRate').value = customRate !== OFFICIAL_RATE ? customRate : '';
  }
  document.getElementById('kpiMIn').textContent     = fmtEuro(mIn);
  document.getElementById('kpiMInSub').textContent  = (mE.filter(t=>t.entree>0).length + mC.filter(t=>t.entree>0).length) + ' opérations (équiv. €)';
  document.getElementById('kpiMOut').textContent    = fmtEuro(mOut);
  document.getElementById('kpiMOutSub').textContent = (mE.filter(t=>t.sortie>0).length + mC.filter(t=>t.sortie>0).length) + ' opérations (équiv. €)';
  document.getElementById('kpiTx').textContent      = euroT.length + cfaT.length;
  document.getElementById('kpiTxSub').textContent   = euroT.length + ' Euro · ' + cfaT.length + ' CFA';

  applyFilters('euro'); applyFilters('cfa');
  updateSuggestions();
  updateMonthSelector();
  renderSuivi();
  renderSuiviPat();
  updatePageHeader();
  if (currentTab === 'adam' && adamOpen && adamData) adamPaint();   // le solde Euro de KANGA a pu changer
  saveLocalCache();
  if (document.getElementById('dashTab').classList.contains('active')) renderDashboard();
  if (document.getElementById('analyticsTab').classList.contains('active')) renderAnalytics();
}

function updateSuggestions() {
  const persons = [...new Set([...euroT,...cfaT].map(t=>t.personne).filter(Boolean))].sort();
  document.getElementById('personsList').innerHTML = persons.map(p=>`<option value="${esc(p)}"></option>`).join('');
  ['euro','cfa'].forEach(type => {
    const arr = type==='euro' ? euroT : cfaT;
    const cats = [...new Set(arr.map(t=>t.categorie).filter(Boolean))].sort();
    const sel = document.getElementById(type+'FCat');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Toutes</option>' + cats.map(c=>`<option value="${esc(c)}" ${c===cur?'selected':''}>${esc(c)}</option>`).join('');
  });
}

// (Analyses) liste des personnes pour le filtre — l'ancien nom de fonction est conservé
function updateMonthSelector() {
  const sel = document.getElementById('aPerson');
  if (!sel) return;
  const cur = sel.value;
  const persons = [...new Set([...euroT, ...cfaT].map(t => t.personne).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Toutes</option>' + persons.map(p => `<option value="${esc(p)}" ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('');
}

// ════════════════════════════════════════════
//  AFFICHAGE TABLE
// ════════════════════════════════════════════
function displayT(type, rows, totalCount, maxPage) {
  const body = document.getElementById(type+'Body');
  const cnt  = document.getElementById(type+'Count');
  const isE  = type === 'euro';
  totalCount = totalCount ?? rows.length;
  maxPage = maxPage ?? 1;
  body.innerHTML = '';
  cnt.textContent = totalCount + ' ligne' + (totalCount>1?'s':'');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty">Aucune transaction</td></tr>`;
    renderPagination(type, maxPage);
    return;
  }
  const fmt = n => isE ? fmtEuro(n) : fmtCFA(n);
  rows.forEach(t => {
    const tr = body.insertRow();
    const sc = t.solde > 0 ? 'val-pos' : t.solde < 0 ? 'val-neg' : 'val-neu';
    tr.innerHTML = `
      <td class="c-date">${t.date}</td>
      <td class="c-op"><span class="badge ${t.operation==='Entrée'?'badge-in':'badge-out'}">${t.operation}</span>${suiviBadge(t)}</td>
      <td class="c-in ${t.entree>0?'val-in':'is-empty'}">${t.entree>0?'+'+fmt(t.entree):'—'}</td>
      <td class="c-out ${t.sortie>0?'val-out':'is-empty'}">${t.sortie>0?'−'+fmt(t.sortie):'—'}</td>
      <td class="c-solde ${sc}">${fmt(t.solde)}</td>
      <td class="c-person"><span class="person-link" data-name="${esc(t.personne)}">${esc(t.personne)}</span></td>
      <td class="c-cat${t.categorie?'':' is-empty'}">${t.categorie?`<span class="badge badge-cat">${esc(t.categorie)}</span>`:'—'}</td>
      <td class="c-note${t.remarque?'':' is-empty'}" title="${esc(t.remarque||'')}">${esc(t.remarque)||'—'}</td>
      <td class="c-act">
        <button class="act-btn" onclick="openEdit('${type}','${t.id}')" title="Modifier">${svgIc('edit')}</button>
        <button class="act-btn" onclick="dupT('${type}','${t.id}')" title="Dupliquer à aujourd'hui">${svgIc('copy')}</button>
        <button class="act-btn act-del" onclick="delT('${type}','${t.id}')" title="Supprimer">${svgIc('trash')}</button>
      </td>`;
  });
  renderPagination(type, maxPage);
}
function renderPagination(type, maxPage) {
  const el = document.getElementById(type+'Pagination');
  if (!el) return;
  const cur = pageState[type];
  if (maxPage <= 1) { el.innerHTML = ''; return; }
  let btns = '';
  for (let p=1; p<=maxPage; p++) {
    if (p===1 || p===maxPage || Math.abs(p-cur)<=1) {
      btns += `<button class="page-btn ${p===cur?'active':''}" onclick="goToPage('${type}',${p})">${p}</button>`;
    } else if (p===2 || p===maxPage-1) {
      btns += `<span class="page-dots">…</span>`;
    }
  }
  el.innerHTML = `
    <button class="page-nav" onclick="goToPage('${type}',${cur-1})" ${cur<=1?'disabled':''}>‹ Préc.</button>
    ${btns}
    <button class="page-nav" onclick="goToPage('${type}',${cur+1})" ${cur>=maxPage?'disabled':''}>Suiv. ›</button>`;
}

// ════════════════════════════════════════════
//  EDIT / DELETE / DUPLICATE
// ════════════════════════════════════════════
function openEdit(type, id) {
  const t = (type==='euro' ? euroT : cfaT).find(x => x.id === id);
  if (!t) return;
  // si les montants désignent sans ambiguïté le sens, on corrige une éventuelle incohérence d'opération
  const op = (t.entree>0) !== (t.sortie>0) ? (t.entree>0 ? 'Entrée' : 'Sortie') : t.operation;
  document.getElementById('editType').value = type;
  document.getElementById('editId').value   = id;
  document.getElementById('edDate').value   = t.date;
  document.getElementById('edOp').value     = op;
  document.getElementById('edIn').value     = t.entree || '';
  document.getElementById('edOut').value    = t.sortie || '';
  document.getElementById('edSuivi').value  = t.contrepartie || '';
  document.getElementById('edStatut').value = t.statut || '';
  document.getElementById('edPerson').value = t.personne;
  document.getElementById('edCat').value    = t.categorie||'';
  document.getElementById('edRate').value   = t.taux||'';
  document.getElementById('edNote').value   = t.remarque||'';
  document.getElementById('editModal').classList.add('open');
}
function closeEdit() { document.getElementById('editModal').classList.remove('open'); document.getElementById('editForm').reset(); }
document.getElementById('editForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const type = document.getElementById('editType').value;
  const id   = document.getElementById('editId').value;
  const am   = readAmounts('edIn', 'edOut', 'edOp');
  if (!am) { toast('Remplissez soit Entrée, soit Sortie (pas les deux)', 'err'); return; }
  const upd  = {
    date: document.getElementById('edDate').value,
    operation: am.operation,
    entree: am.entree,
    sortie: am.sortie,
    personne: document.getElementById('edPerson').value,
    categorie: document.getElementById('edCat').value || null,
    remarque: document.getElementById('edNote').value,
    taux: parseFloat(document.getElementById('edRate').value)||null
  };
  const contrepartie = document.getElementById('edSuivi').value || null;
  const statut = document.getElementById('edStatut').value || null;
  const before = (type==='euro' ? euroT : cfaT).find(x => x.id === id);
  requireUnlock(() => {
    const today = new Date().toISOString().split('T')[0];
    mutateTx(type, a => a.map(x => {
      if (x.id !== id) return x;
      const merged = { ...x, ...upd, id, contrepartie, statut };
      if (statut !== 'termine') merged.termineLe = null;
      else if (!merged.termineLe) merged.termineLe = today;
      return merged;
    }));
    logAction('Modification', type, { ...before, ...upd, id }, diffTx(before, { ...upd, contrepartie, statut }));
    closeEdit(); toast('Transaction modifiée', 'ok');
  });
});

function delT(type, id) {
  const arr = type==='euro' ? euroT : cfaT;
  const idx = arr.findIndex(t => t.id === id);
  if (idx < 0) return;
  const item = arr[idx];
  requireUnlock(() => {
    mutateTx(type, a => a.filter(t => t.id !== id));
    trashPut(type, item);
    logAction('Suppression', type, item);
    toast('Transaction supprimée', '', () => {
      trashDrop(id);
      logAction('Annulation de suppression', type, item);
      mutateTx(type, a => {
        if (a.some(t => t.id === id)) return a;
        const at = Math.min(idx, a.length);
        return [...a.slice(0, at), item, ...a.slice(at)];
      });
      toast('Suppression annulée', 'ok');
    });
  });
}

function dupT(type, id) {
  const t = (type==='euro' ? euroT : cfaT).find(x => x.id === id);
  if (!t) return;
  requireUnlock(() => {
    const copy = { ...t, id: genId(), date: new Date().toISOString().split('T')[0],
      ...suiviFields(t.contrepartie) };
    mutateTx(type, a => [...a, copy]);
    logAction('Duplication', type, copy);
    toast('Transaction dupliquée à aujourd\'hui', 'ok');
  });
}

// ════════════════════════════════════════════
//  FORMULAIRES — sauvegarde miroir auto
// ════════════════════════════════════════════
document.getElementById('euroForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const form = this;
  requireUnlock(() => {
    const am = readAmounts('eIn', 'eOut', 'eOp');
    if (!am) { toast('Remplissez soit Entrée, soit Sortie (pas les deux)', 'err'); return; }
    const tx = {
      id: genId(),
      date: document.getElementById('eDate').value,
      operation: am.operation,
      entree: am.entree,
      sortie: am.sortie,
      personne: document.getElementById('ePerson').value,
      categorie: document.getElementById('eCat').value || null,
      remarque: document.getElementById('eNote').value,
      taux: parseFloat(document.getElementById('eRate').value)||null,
      ...suiviFields(document.getElementById('eSuivi').value, document.getElementById('eStatut').value)
    };
    mutateTx('euro', a => [...a, tx]);
    logAction('Ajout', 'euro', tx);
    form.reset();
    document.getElementById('eDate').value = new Date().toISOString().split('T')[0];
    closeAdd('euro');
    toast('Transaction ajoutée', 'ok');
  });
});

document.getElementById('cfaForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const form = this;
  requireUnlock(() => {
    const am = readAmounts('cIn', 'cOut', 'cOp');
    if (!am) { toast('Remplissez soit Entrée, soit Sortie (pas les deux)', 'err'); return; }
    const tx = {
      id: genId(),
      date: document.getElementById('cDate').value,
      operation: am.operation,
      entree: am.entree,
      sortie: am.sortie,
      personne: document.getElementById('cPerson').value,
      categorie: document.getElementById('cCat').value || null,
      remarque: document.getElementById('cNote').value,
      taux: parseFloat(document.getElementById('cRate').value)||null,
      ...suiviFields(document.getElementById('cSuivi').value, document.getElementById('cStatut').value)
    };
    mutateTx('cfa', a => [...a, tx]);
    logAction('Ajout', 'cfa', tx);
    form.reset();
    document.getElementById('cDate').value = new Date().toISOString().split('T')[0];
    closeAdd('cfa');
    toast('Transaction ajoutée', 'ok');
  });
});

// ════════════════════════════════════════════
//  DONUT SVG (utilitaire)
// ════════════════════════════════════════════
function donutSVG(segments, centerLabel, centerSub) {
  const total = segments.reduce((s,x)=>s+x.value,0) || 1;
  const R = 54, C = 2*Math.PI*R;
  let offset = 0;
  const circles = segments.map(s => {
    const frac = s.value/total;
    const el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${s.color}" stroke-width="17"
      stroke-dasharray="${(frac*C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-offset*C).toFixed(1)}"
      transform="rotate(-90 70 70)" stroke-linecap="butt"><title>${s.label}: ${s.text}</title></circle>`;
    offset += frac;
    return el;
  }).join('');
  const legend = segments.map(s =>
    `<div class="donut-legend-item"><span class="donut-dot" style="background:${s.color}"></span>${s.label} · <b class="num" style="color:${s.color}">${s.text}</b></div>`
  ).join('');
  return `<svg width="140" height="140" viewBox="0 0 140 140">
      ${circles}
      <text x="70" y="66" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)" font-family="var(--font-mono)">${centerLabel}</text>
      <text x="70" y="84" text-anchor="middle" font-size="8.5" fill="var(--text3)">${centerSub}</text>
    </svg>
    <div class="donut-legend">${legend}</div>`;
}

// ════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════
function renderDashboard() {
  // Donut balance globale
  const eS = euroT.reduce((a,b)=>a+b.entree-b.sortie,0);
  const cSEur = cfaT.reduce((a,b)=>a+b.entree-b.sortie,0) / customRate;
  const hEur = holdingsTotalEUR();
  const total = eS + cSEur + hEur;
  document.getElementById('dashDonut').innerHTML = donutSVG([
    {label:'Euro', value:Math.max(eS,0), color:'var(--euro)', text:fmtEuro(eS)},
    {label:'CFA (en €)', value:Math.max(cSEur,0), color:'var(--cfa)', text:fmtEuro(cSEur)},
    {label:'Chez les personnes (en €)', value:Math.max(hEur,0), color:'#8b5cf6', text:fmtEuro(hEur)}
  ], fmtEuro(total).replace(' €','€'), 'patrimoine total');

  // Dernières transactions mixtes
  const mixed = [
    ...euroT.map((t,i)=>({...t, cur:'EUR', _idx:i})),
    ...cfaT.map((t,i)=>({...t, cur:'CFA', _idx:i}))
  ].sort((a,b)=> b.date.localeCompare(a.date)).slice(0,8);
  const rb = document.getElementById('recentBody');
  document.getElementById('recentCount').textContent = '8 plus récentes';
  rb.innerHTML = mixed.length ? mixed.map(t => {
    const amt = t.entree > 0 ? t.entree : t.sortie;
    const fmt = t.cur==='EUR' ? fmtEuro : fmtCFA;
    return `<tr>
      <td class="c-date">${t.date}</td>
      <td class="c-cur"><span class="badge ${t.cur==='EUR'?'badge-euro':'badge-cfa'}">${t.cur}</span></td>
      <td class="c-op"><span class="badge ${t.operation==='Entrée'?'badge-in':'badge-out'}">${t.operation}</span></td>
      <td class="c-amt ${t.entree>0?'val-in':'val-out'}">${t.entree>0?'+':'−'}${fmt(amt)}</td>
      <td class="c-person"><span class="person-link" data-name="${esc(t.personne)}">${esc(t.personne)}</span></td>
      <td class="c-cat${t.categorie?'':' is-empty'}">${t.categorie?`<span class="badge badge-cat">${esc(t.categorie)}</span>`:'—'}</td>
      <td class="c-note${t.remarque?'':' is-empty'}">${esc(t.remarque)||'—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Aucune transaction</td></tr>';

  // Balances par personne
  ['euro','cfa'].forEach(type => {
    const arr = type==='euro' ? euroT : cfaT;
    const fmt = type==='euro' ? fmtEuro : fmtCFA;
    const bp = {};
    arr.forEach(t => { bp[t.personne] = (bp[t.personne]||0) + t.entree - t.sortie; });
    const list = Object.entries(bp).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,8);
    const max = Math.max(...list.map(x=>Math.abs(x[1])), 1);
    const el = document.getElementById(type==='euro'?'dashBalEuro':'dashBalCfa');
    el.innerHTML = list.length ? list.map(([n,v]) => `
      <div class="bar-row">
        <div class="bar-label" title="${esc(n)}">${esc(n)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(Math.abs(v)/max*100).toFixed(1)}%;background:${v>=0?'var(--green)':'var(--red)'};"></div></div>
        <div class="bar-val" style="color:${v>=0?'var(--green)':'var(--red)'};">${v>=0?'+':''}${fmt(v)}</div>
      </div>`).join('')
      : '<div style="color:var(--text3);font-size:.8rem;">Aucune donnée</div>';
  });
}
// ════════════════════════════════════════════
//  ANALYTICS
// ════════════════════════════════════════════
// Analyses : filtres (devise, période, personne), comparaison avec la période précédente,
// courbe du solde, barres mensuelles, répartitions, suivi et plus grosses opérations.
function aPeriodChanged() {
  const custom = document.getElementById('aPeriod').value === 'custom';
  document.querySelectorAll('.a-custom').forEach(el => { el.style.display = custom ? '' : 'none'; });
  renderAnalytics();
}
function aYmd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function aDateFr(s) { return s ? new Date(s + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : ''; }
function aMonthFr(m, long) {
  const [y, mo] = m.split('-');
  return new Date(+y, mo - 1, 1).toLocaleDateString('fr-FR', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
}
// nombre court pour les axes : 12,5 k · 1,2 M
function aShort(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : a >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(Math.round(n));
  return s.replace('.0 ', ' ').replace('.', ',');
}

// Période choisie + période précédente de même durée (pour les comparaisons)
function aRange() {
  const p = document.getElementById('aPeriod').value;
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  let from = '', to = '', label = 'Toute la période', prevFrom = '', prevTo = '';
  const month = (yy, mm) => [aYmd(new Date(yy, mm, 1)), aYmd(new Date(yy, mm + 1, 0))];
  if (p === 'month')      { [from, to] = month(y, m);     [prevFrom, prevTo] = month(y, m - 1); label = aMonthFr(from.slice(0, 7), true); }
  else if (p === 'prev')  { [from, to] = month(y, m - 1); [prevFrom, prevTo] = month(y, m - 2); label = aMonthFr(from.slice(0, 7), true); }
  else if (p === '3m')    { from = aYmd(new Date(y, m - 2, 1));  to = aYmd(new Date(y, m + 1, 0)); prevFrom = aYmd(new Date(y, m - 5, 1));  prevTo = aYmd(new Date(y, m - 2, 0)); label = '3 derniers mois'; }
  else if (p === '12m')   { from = aYmd(new Date(y, m - 11, 1)); to = aYmd(new Date(y, m + 1, 0)); prevFrom = aYmd(new Date(y, m - 23, 1)); prevTo = aYmd(new Date(y, m - 11, 0)); label = '12 derniers mois'; }
  else if (p === 'year')  { from = y + '-01-01'; to = y + '-12-31'; prevFrom = (y - 1) + '-01-01'; prevTo = (y - 1) + '-12-31'; label = 'Année ' + y; }
  else if (p === 'custom') {
    from = document.getElementById('aFrom').value; to = document.getElementById('aTo').value;
    label = (from ? 'du ' + aDateFr(from) : 'depuis le début') + (to ? ' au ' + aDateFr(to) : " jusqu'à aujourd'hui");
    if (from && to) {
      const f = new Date(from + 'T00:00:00'), t = new Date(to + 'T00:00:00');
      const days = Math.round((t - f) / 864e5) + 1;
      const pt = new Date(f); pt.setDate(pt.getDate() - 1);
      const pf = new Date(pt); pf.setDate(pf.getDate() - days + 1);
      prevFrom = aYmd(pf); prevTo = aYmd(pt);
    }
  }
  return { from, to, prevFrom, prevTo, label };
}
const aIn = (r, from, to) => (!from || r.date >= from) && (!to || r.date <= to);

// Lignes unifiées ; en mode « les deux », le CFA est converti en € au taux de référence
function aRows(type, person) {
  const rows = [];
  if (type !== 'cfa') euroT.forEach(t => rows.push({ ...t, cur: 'euro', in: t.entree || 0, out: t.sortie || 0 }));
  if (type !== 'euro') {
    const k = type === 'all' ? 1 / customRate : 1;
    cfaT.forEach(t => rows.push({ ...t, cur: 'cfa', in: (t.entree || 0) * k, out: (t.sortie || 0) * k }));
  }
  return (person ? rows.filter(r => r.personne === person) : rows).filter(r => r.date);
}

function aDelta(cur, prev, upIsGood) {
  if (prev === null) return '';
  if (!prev) return cur ? '<span class="delta-up">nouveau</span> vs période préc.' : '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const up = pct >= 0, good = upIsGood ? up : !up;
  return `<span class="${good ? 'delta-up' : 'delta-down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)} %</span> vs période préc.`;
}

function renderAnalytics() {
  const type = document.getElementById('aType').value;
  const person = document.getElementById('aPerson').value;
  const fmt = type === 'cfa' ? fmtCFA : fmtEuro;
  const R = aRange();
  const all = aRows(type, person);
  const data = all.filter(r => aIn(r, R.from, R.to));
  const prev = R.prevFrom ? all.filter(r => aIn(r, R.prevFrom, R.prevTo)) : null;
  const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);

  const totIn = sum(data, 'in'), totOut = sum(data, 'out'), net = totIn - totOut;
  const pIn = prev ? sum(prev, 'in') : null, pOut = prev ? sum(prev, 'out') : null;
  const before = all.filter(r => R.from && r.date < R.from);
  const startBal = sum(before, 'in') - sum(before, 'out');
  const endBal = startBal + net;

  document.getElementById('aPeriodInfo').innerHTML =
    `<b>${esc(R.label)}</b> · ${data.length} transaction${data.length > 1 ? 's' : ''}` +
    (person ? ` · ${esc(person)}` : '') +
    (type === 'all' ? ` · CFA converti au taux 1 € = ${customRate.toLocaleString('fr-FR')} CFA` : '') +
    (prev ? ` · comparé au ${aDateFr(R.prevFrom)} – ${aDateFr(R.prevTo)}` : '');

  const kpi = (cls, icon, label, value, sub) => `<div class="kpi ${cls}">
      <div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-ic">${svgIc(icon)}</span></div>
      <div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  document.getElementById('aKpis').innerHTML =
    kpi('kpi-green', 'up', 'Entrées', fmt(totIn), `${data.filter(r => r.in > 0).length} opérations ${aDelta(totIn, pIn, true) ? '· ' + aDelta(totIn, pIn, true) : ''}`) +
    kpi('kpi-red', 'down', 'Sorties', fmt(totOut), `${data.filter(r => r.out > 0).length} opérations ${aDelta(totOut, pOut, false) ? '· ' + aDelta(totOut, pOut, false) : ''}`) +
    kpi(net >= 0 ? 'kpi-gold' : 'kpi-red', 'swap', 'Variation nette', (net >= 0 ? '+' : '') + fmt(net),
        prev ? aDelta(net, (pIn || 0) - (pOut || 0), true) || 'sur la période' : 'sur la période') +
    kpi('kpi-neutral', 'wallet', 'Solde en fin de période', fmt(endBal),
        R.from ? `au début : ${fmt(startBal)}` : `${[...new Set(data.map(r => r.personne))].length} personnes`);

  // ── Courbe du solde (en escalier : le solde ne bouge qu'aux opérations) ──
  const byDay = {};
  data.forEach(r => { byDay[r.date] = (byDay[r.date] || 0) + r.in - r.out; });
  const days = Object.keys(byDay).sort();
  const pts = [];
  let bal = startBal;
  if (R.from) pts.push({ d: R.from, v: startBal });
  days.forEach(d => { bal += byDay[d]; pts.push({ d, v: bal }); });
  const today = aYmd(new Date());
  const endDay = R.to && R.to < today ? R.to : today;
  if (pts.length && pts[pts.length - 1].d < endDay) pts.push({ d: endDay, v: bal });
  document.getElementById('aBalSub').textContent = type === 'all' ? '(Euro + CFA en €, hors argent détenu)' : '';
  aChartBalance(document.getElementById('aBalanceChart'), pts, fmt);

  // ── Barres mensuelles ──
  const byMonth = {};
  data.forEach(r => { const m = r.date.slice(0, 7); (byMonth[m] = byMonth[m] || { in: 0, out: 0, n: 0 }); byMonth[m].in += r.in; byMonth[m].out += r.out; byMonth[m].n++; });
  const months = Object.keys(byMonth).sort();
  aChartMonths(document.getElementById('trendChart'), months.slice(-24), byMonth, fmt);

  // ── Donut et répartitions ──
  document.getElementById('aDonut').innerHTML = donutSVG([
    { label: 'Entrées', value: totIn, color: 'var(--green)', text: fmt(totIn) },
    { label: 'Sorties', value: totOut, color: 'var(--red)', text: fmt(totOut) }
  ], data.length + ' op.', R.label.length > 18 ? 'sur la période' : R.label);

  const bars = (entries, color, clickable) => entries.length ? entries.map(([n, v], i, a) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(n)}">${clickable ? `<span class="person-link" data-name="${esc(n)}">${esc(n)}</span>` : esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / (a[0][1] || 1) * 100).toFixed(1)}%;background:${color};"></div></div>
      <div class="bar-val" style="color:${color};">${fmt(v)}</div>
    </div>`).join('') : '<div class="a-empty">Aucune donnée sur cette période.</div>';
  const group = (keyFn, valFn) => { const o = {}; data.forEach(r => { const v = valFn(r); if (v > 0) { const k = keyFn(r); o[k] = (o[k] || 0) + v; } }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  document.getElementById('chartCat').innerHTML = bars(group(r => r.categorie || 'Sans catégorie', r => r.in + r.out).slice(0, 8), 'var(--brand)', false);
  document.getElementById('chartPersonIn').innerHTML = bars(group(r => r.personne, r => r.in).slice(0, 7), 'var(--green)', true);
  document.getElementById('chartPersonOut').innerHTML = bars(group(r => r.personne, r => r.out).slice(0, 7), 'var(--red)', true);

  // ── Suivi sur la période ──
  const tracked = data.filter(r => r.statut);
  const open = tracked.filter(r => r.statut === 'en_cours');
  const done = tracked.filter(r => r.statut === 'termine' && r.termineLe);
  const delays = done.map(r => Math.max(0, Math.round((new Date(r.termineLe) - new Date(r.date)) / 864e5)));
  const avgDelay = delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : null;
  const late = open.filter(r => suiviAge(r) > SUIVI_ALERT_DAYS).length;
  const openBy = {};
  open.forEach(r => { const k = r.contrepartie || 'Sans contrepartie'; openBy[k] = (openBy[k] || 0) + 1; });
  document.getElementById('aSuivi').innerHTML = tracked.length ? `
    <div class="a-stats">
      <div><b>${open.length}</b><span>en cours</span></div>
      <div class="${late ? 'bad' : ''}"><b>${late}</b><span>en retard</span></div>
      <div><b>${done.length}</b><span>terminées</span></div>
      <div><b>${avgDelay === null ? '—' : avgDelay + ' j'}</b><span>délai moyen</span></div>
    </div>
    ${Object.keys(openBy).length ? `<div class="a-list">${Object.entries(openBy).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
      `<div class="a-list-row"><span>${esc(k)}</span><span class="sum-count">${n} en cours</span></div>`).join('')}</div>` : ''}`
    : '<div class="a-empty">Aucune transaction suivie sur cette période.</div>';

  // ── Plus grosses opérations ──
  const top = data.slice().sort((a, b) => Math.max(b.in, b.out) - Math.max(a.in, a.out)).slice(0, 6);
  document.getElementById('aTop').innerHTML = top.length ? `<div class="a-list">${top.map(r => {
    const amt = r.in > 0 ? r.in : r.out;
    const native = r.cur === 'euro' ? fmtEuro(r.entree || r.sortie) : fmtCFA(r.entree || r.sortie);
    return `<div class="a-list-row">
      <span class="a-top-main"><span class="person-link" data-name="${esc(r.personne)}">${esc(r.personne)}</span>
        <small>${aDateFr(r.date)} · <span class="badge ${r.cur === 'euro' ? 'badge-euro' : 'badge-cfa'}">${r.cur === 'euro' ? 'EUR' : 'CFA'}</span>${r.categorie ? ' · ' + esc(r.categorie) : ''}</small></span>
      <span class="${r.in > 0 ? 'val-in' : 'val-out'}">${r.in > 0 ? '+' : '−'}${type === 'all' && r.cur === 'cfa' ? native + ' <small>≈ ' + fmtEuro(amt) + '</small>' : fmt(amt)}</span>
    </div>`;
  }).join('')}</div>` : '<div class="a-empty">Aucune opération sur cette période.</div>';

  // ── Tableau par mois (avec évolution du net) ──
  document.getElementById('monthBody').innerHTML = months.length ? months.slice().reverse().map(m => {
    const d = byMonth[m], n = d.in - d.out;
    const i = months.indexOf(m);
    let evo = '—';
    if (i > 0) { const p = byMonth[months[i - 1]]; const diff = n - (p.in - p.out); evo = `<span class="${diff >= 0 ? 'val-pos' : 'val-neg'}">${diff >= 0 ? '▲ +' : '▼ '}${fmt(diff)}</span>`; }
    return `<tr><td>${aMonthFr(m, true)}</td><td class="num">${d.n}</td><td class="val-in">${fmt(d.in)}</td><td class="val-out">${fmt(d.out)}</td>
      <td class="${n >= 0 ? 'val-pos' : 'val-neg'}">${n >= 0 ? '+' : ''}${fmt(n)}</td><td>${evo}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">Aucune donnée</td></tr>';

  // ── Classement des personnes ──
  const bp = {};
  data.forEach(r => { const o = bp[r.personne] || (bp[r.personne] = { in: 0, out: 0, n: 0 }); o.in += r.in; o.out += r.out; o.n++; });
  const totAll = totIn + totOut || 1;
  document.getElementById('personBody').innerHTML = Object.keys(bp).length ? Object.entries(bp)
    .sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).map(([name, d]) => {
      const n = d.in - d.out;
      return `<tr><td><span class="person-link" data-name="${esc(name)}">${esc(name)}</span></td><td class="num">${d.n}</td>
        <td class="val-in">${fmt(d.in)}</td><td class="val-out">${fmt(d.out)}</td>
        <td class="${n >= 0 ? 'val-pos' : 'val-neg'}">${n >= 0 ? '+' : ''}${fmt(n)}</td>
        <td class="num" style="color:var(--text2);">${((d.in + d.out) / totAll * 100).toFixed(1)} %</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">Aucune donnée</td></tr>';
}

// Courbe du solde, dessinée à la largeur réelle de l'écran (textes lisibles sur téléphone)
function aChartBalance(el, pts, fmt) {
  if (pts.length < 2) { el.innerHTML = '<div class="a-empty">Pas assez de données sur cette période pour tracer une courbe.</div>'; return; }
  const W = Math.max(300, el.clientWidth || 700), H = W < 520 ? 200 : 250;
  const L = 54, Rt = 12, T = 12, B = 26;
  const vs = pts.map(p => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const t0 = new Date(pts[0].d).getTime(), t1 = new Date(pts[pts.length - 1].d).getTime();
  const x = d => L + ((new Date(d).getTime() - t0) / ((t1 - t0) || 1)) * (W - L - Rt);
  const y = v => T + (1 - (v - min) / (max - min)) * (H - T - B);
  let line = `M${x(pts[0].d).toFixed(1)},${y(pts[0].v).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) line += ` H${x(pts[i].d).toFixed(1)} V${y(pts[i].v).toFixed(1)}`;
  const area = `${line} V${H - B} H${x(pts[0].d).toFixed(1)} Z`;
  let grid = '';
  for (let k = 0; k <= 3; k++) {
    const v = min + (max - min) * k / 3, yy = y(v).toFixed(1);
    grid += `<line x1="${L}" x2="${W - Rt}" y1="${yy}" y2="${yy}" class="a-grid"/><text x="${L - 6}" y="${(+yy + 4)}" text-anchor="end" class="a-axis">${aShort(v)}</text>`;
  }
  const zero = min < 0 && max > 0 ? `<line x1="${L}" x2="${W - Rt}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="a-zero"/>` : '';
  const xl = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]]
    .map((p, i) => `<text x="${x(p.d).toFixed(1)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}" class="a-axis">${aDateFr(p.d)}</text>`).join('');
  const hits = pts.length <= 120 ? pts.map(p => `<circle cx="${x(p.d).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="6" class="a-hit"><title>${aDateFr(p.d)} : ${fmt(p.v)}</title></circle>`).join('') : '';
  const last = pts[pts.length - 1];
  el.innerHTML = `<svg width="${W}" height="${H}" class="a-svg" role="img" aria-label="Évolution du solde">
    <defs><linearGradient id="aBalGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c3aed" stop-opacity=".28"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></linearGradient></defs>
    ${grid}${zero}
    <path d="${area}" fill="url(#aBalGrad)"/>
    <path d="${line}" fill="none" stroke="#7c3aed" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="${x(last.d).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4.5" fill="#7c3aed" stroke="var(--surface)" stroke-width="2"/>
    ${xl}${hits}
  </svg>`;
}

// Barres groupées entrées / sorties par mois
function aChartMonths(el, months, byMonth, fmt) {
  if (!months.length) { el.innerHTML = '<div class="a-empty">Aucune donnée sur cette période.</div>'; return; }
  const W = Math.max(300, el.clientWidth || 700), H = W < 520 ? 210 : 250;
  const L = 50, Rt = 8, T = 22, B = 26;
  const max = Math.max(1, ...months.flatMap(m => [byMonth[m].in, byMonth[m].out])) * 1.08;
  const n = months.length, slot = (W - L - Rt) / n, bw = Math.max(3, Math.min(20, slot * 0.34));
  const y = v => T + (1 - v / max) * (H - T - B);
  let g = '';
  for (let k = 0; k <= 3; k++) {
    const v = max * k / 3, yy = y(v).toFixed(1);
    g += `<line x1="${L}" x2="${W - Rt}" y1="${yy}" y2="${yy}" class="a-grid"/><text x="${L - 6}" y="${(+yy + 4)}" text-anchor="end" class="a-axis">${aShort(v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / Math.floor((W - L) / 46)));
  months.forEach((m, i) => {
    const d = byMonth[m], cx = L + slot * i + slot / 2, net = d.in - d.out;
    const tip = `<title>${aMonthFr(m, true)}\nEntrées : ${fmt(d.in)}\nSorties : ${fmt(d.out)}\nNet : ${net >= 0 ? '+' : ''}${fmt(net)}</title>`;
    g += `<g class="a-bar">
      <rect x="${(cx - bw - 1).toFixed(1)}" y="${y(d.in).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - B - y(d.in)).toFixed(1)}" rx="3" fill="var(--green)">${tip}</rect>
      <rect x="${(cx + 1).toFixed(1)}" y="${y(d.out).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - B - y(d.out)).toFixed(1)}" rx="3" fill="var(--red)">${tip}</rect>
    </g>`;
    if (i % every === 0) {
      const lab = aMonthFr(m) + (m.endsWith('-01') || i === 0 ? ' ' + m.slice(2, 4) : '');
      g += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" class="a-axis">${lab}</text>`;
    }
  });
  el.innerHTML = `<svg width="${W}" height="${H}" class="a-svg" role="img" aria-label="Entrées et sorties par mois">
    ${g}
    <g class="a-legend" transform="translate(${W - 150},6)">
      <rect width="10" height="10" rx="2" fill="var(--green)"/><text x="15" y="9">Entrées</text>
      <rect x="74" width="10" height="10" rx="2" fill="var(--red)"/><text x="89" y="9">Sorties</text>
    </g>
  </svg>`;
}

// ════════════════════════════════════════════
//  NOTES
// ════════════════════════════════════════════
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function newNote() {
  requireUnlock(() => {
    const n = { id:genId(), title:'', content:'', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
    notes.unshift(n); saveNotes(); renderNotesList(); openNote(n.id);
  });
}
function openNote(id) {
  currentNote = id;
  const n = notes.find(x=>x.id===id); if (!n) return;
  document.getElementById('neEmpty').style.display = 'none';
  document.getElementById('neEditor').style.display = 'flex';
  document.getElementById('neTitle').value = n.title;
  document.getElementById('neBody').value  = n.content;
  document.getElementById('neDate').textContent   = 'Créée le ' + new Date(n.createdAt).toLocaleDateString('fr-FR');
  document.getElementById('neStatus').textContent = 'Modifiée ' + new Date(n.updatedAt).toLocaleString('fr-FR');
  renderNotesList();
  // téléphone : la note s'ouvre en plein écran (la liste est masquée)
  document.getElementById('notesLayout').classList.add('editing');
  if (!n.title && !n.content) setTimeout(() => document.getElementById('neTitle').focus(), 80);
}
// téléphone : retour de la note à la liste
function notesBack() {
  document.getElementById('notesLayout').classList.remove('editing');
  renderNotesList();
}
function autoSaveNote() {
  if (!currentNote) return;
  if (!isUnlocked()) {
    document.getElementById('neStatus').textContent = 'Verrouillé — entrez le code pour sauvegarder';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => requireUnlock(autoSaveNote), 700);
    return;
  }
  clearTimeout(noteTimer);
  document.getElementById('neStatus').textContent = 'Enregistrement...';
  noteTimer = setTimeout(() => {
    const i = notes.findIndex(x=>x.id===currentNote);
    if (i>=0) {
      notes[i].title = document.getElementById('neTitle').value;
      notes[i].content = document.getElementById('neBody').value;
      notes[i].updatedAt = new Date().toISOString();
      saveNotes(); renderNotesList();
      document.getElementById('neStatus').textContent = 'Enregistré';
    }
  }, 600);
}
function deleteNote() {
  if (!currentNote || !confirm('Supprimer cette note ?')) return;
  requireUnlock(() => {
    notes = notes.filter(n=>n.id!==currentNote); currentNote = null;
    saveNotes(); renderNotesList();
    document.getElementById('neEmpty').style.display = 'flex';
    document.getElementById('neEditor').style.display = 'none';
    document.getElementById('notesLayout').classList.remove('editing');
    toast('Note supprimée');
  });
}
function renderNotesList() {
  const q = document.getElementById('noteSearch').value.toLowerCase();
  const el = document.getElementById('notesList');
  const filtered = notes.filter(n=>!q||n.title.toLowerCase().includes(q)||n.content.toLowerCase().includes(q));
  if (!filtered.length) { el.innerHTML = '<div class="note-empty">Aucune note trouvée</div>'; return; }
  el.innerHTML = filtered.map(n=>`
    <div class="note-item ${n.id===currentNote?'active':''}" onclick="openNote('${n.id}')">
      <div class="ni-title">${esc(n.title)||'Sans titre'}</div>
      <div class="ni-preview">${esc((n.content||'').replace(/\n/g,' ').slice(0,55))||'Note vide'}</div>
      <div class="ni-date">${new Date(n.updatedAt).toLocaleDateString('fr-FR',{day:'2-digit',month:'short'})}</div>
    </div>`).join('');
}

// ════════════════════════════════════════════
//  EXPORT / IMPORT
// ════════════════════════════════════════════
function exportData() {
  const blob = new Blob([JSON.stringify({euroTransactions:euroT,cfaTransactions:cfaT,notes,holdings,suiviAjustements:suiviAdj,exportDate:new Date().toISOString()},null,2)],{type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`kanga-${new Date().toISOString().split('T')[0]}.json`; a.click();
  URL.revokeObjectURL(a.href); toast('Export JSON réussi', 'ok');
}
function exportCSV(type) {
  const arr = withSolde(type==='euro' ? euroT : cfaT);
  const sep = ';';
  const head = ['Date','Operation','Entree','Sortie','Solde cumule','Personne','Categorie','Taux','Remarque','Statut','Contrepartie','Date cloture'].join(sep);
  const csvEsc = v => `"${String(v==null?'':v).replace(/"/g,'""')}"`;
  const lines = arr.map(t => [
    t.date, t.operation,
    String(t.entree).replace('.',','), String(t.sortie).replace('.',','),
    String(t.solde.toFixed(2)).replace('.',','),
    t.personne, t.categorie||'', t.taux||'', t.remarque||'',
    t.statut === 'termine' ? 'Terminé' : t.statut === 'en_cours' ? 'En cours' : '', t.contrepartie||'', t.termineLe||''
  ].map(csvEsc).join(sep));
  const blob = new Blob(['\ufeff' + [head,...lines].join('\r\n')], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `kanga-${type}-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  URL.revokeObjectURL(a.href); toast('Export CSV réussi', 'ok');
}
function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (d.euroTransactions && d.cfaTransactions) {
        if (confirm('Remplacer toutes les données ?')) {
          requireUnlock(() => {
            euroT = toArr(d.euroTransactions); cfaT = toArr(d.cfaTransactions);
            if (d.notes) notes = toArr(d.notes);
            if (d.holdings) { holdings = toArr(d.holdings); saveHoldings(); renderHoldings(); }
            if (d.suiviAjustements) db.ref('/suiviAjustements').set(suiviAdjObject(d.suiviAjustements)).catch(() => {});
            saveToDB(); saveNotes(); updateAll(); renderNotesList();
            logAction('Import JSON', null, null, `${euroT.length} Euro · ${cfaT.length} CFA`);
            toast('Import réussi', 'ok');
          });
        }
      } else alert('Fichier invalide.');
    } catch(err) { alert('Erreur : '+err.message); }
  };
  r.readAsText(f); e.target.value = '';
}

// ════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  checkAppLock();
  fillSuiviSelects();
  fillWho();
  hydrateFromCache();
  switchTab('suivi');   // le Suivi est l'écran d'accueil
  adamNavUpdate();
  adamHandleReturn();   // retour depuis le site d'une banque (Espace Adam)

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('eDate').value = today;
  document.getElementById('cDate').value = today;

  listen();
  listenTrash();
  aiInit();

  mirrorDb.ref('/latest').once('value').then(s => {
    if (s.exists()) {
      const d = s.val(), dt = new Date(d.savedAt);
      setMirror('ok', 'Sauvegarde à jour');
      document.getElementById('backupSub').innerHTML =
        `Dernière sauvegarde : <b>${dt.toLocaleDateString('fr-FR')} à ${dt.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</b> · ${d.label}`;
    } else {
      document.getElementById('backupSub').textContent = 'Aucune sauvegarde encore — ajoutez une transaction pour en créer une.';
    }
  }).catch(() => {
    setMirror('error', 'Miroir inaccessible');
    document.getElementById('backupSub').textContent = 'Impossible de joindre la base miroir.';
  });

  // Données initiales : uniquement à la toute première utilisation (drapeau /meta/seeded),
  // pour ne pas réinjecter la démo après une suppression volontaire de toutes les transactions
  db.ref('meta/seeded').once('value').then(async s => {
    if (s.exists()) return;
    const e = await db.ref('euroTransactions').once('value');
    if (!e.exists()) {
      const withId = a => a.map(t => ({ ...t, id: genId() }));
      euroT = withId(HD.euro);
      cfaT  = withId(HD.cfa);
      saveToDB(); updateAll();
    }
    db.ref('meta/seeded').set(true).catch(()=>{});
  }).catch(()=>{});
});

// ════════════════════════════════════════════
//  SUIVI DES TRANSACTIONS (facultatif)
//  Champs ajoutés à une transaction : contrepartie, statut ('en_cours' | 'termine'),
//  termineLe (date de clôture)
// ════════════════════════════════════════════
const SUIVI_PERSONS = ['Abbas', 'Adam', 'Youssouf'];   // ordre alphabétique

function fillSuiviSelects() {
  const opts = SUIVI_PERSONS.map(p => `<option value="${p}">${p}</option>`).join('');
  ['eSuivi','cSuivi','edSuivi'].forEach(id => {
    document.getElementById(id).innerHTML = '<option value="">— Aucun —</option>' + opts;
  });
  document.getElementById('suiviFPerson').innerHTML = '<option value="">Toutes</option>' + opts;
}

// Champs de suivi d'une nouvelle transaction : une contrepartie choisie => "en cours"
// Entrée / Sortie : l'opération suit la case remplie
function syncOp(inId, outId, opId) {
  const i = parseFloat(document.getElementById(inId).value) || 0;
  const o = parseFloat(document.getElementById(outId).value) || 0;
  if (i > 0 && !(o > 0)) document.getElementById(opId).value = 'Entrée';
  else if (o > 0 && !(i > 0)) document.getElementById(opId).value = 'Sortie';
}
// Lit les deux cases ; renvoie null si les deux sont remplies
function readAmounts(inId, outId, opId) {
  const entree = parseFloat(document.getElementById(inId).value) || 0;
  const sortie = parseFloat(document.getElementById(outId).value) || 0;
  if (entree > 0 && sortie > 0) return null;
  const operation = entree > 0 ? 'Entrée' : sortie > 0 ? 'Sortie' : document.getElementById(opId).value;
  return { entree, sortie, operation };
}

// Toute nouvelle transaction est "en cours" par défaut (avec ou sans contrepartie)
function suiviFields(contrepartie, statut = 'en_cours') {
  return {
    contrepartie: contrepartie || null,
    statut,
    termineLe: statut === 'termine' ? new Date().toISOString().split('T')[0] : null
  };
}

function suiviBadge(t) {
  if (!t.statut) return '';
  const done = t.statut === 'termine';
  const who = t.contrepartie ? `Suivi avec ${esc(t.contrepartie)}` : 'Sans contrepartie';
  return ` <span class="badge badge-dot ${done ? 'badge-suivi-termine' : 'badge-suivi-encours'}" title="${who}">${done ? 'Terminé' : 'En cours'}</span>`;
}

// Ce qu'il faut vérifier selon la devise et le sens de la transaction
function suiviLabel(t) {
  const p = t.contrepartie ? ` par ${esc(t.contrepartie)}` : '';
  if (t.cur === 'euro') return `CFA récupéré${p} ?`;
  return t.operation === 'Entrée' ? `Euro envoyé${p} ?` : `Euro reçu${p} ?`;
}

function suiviRowHTML(t, done) {
  const fmt = t.cur === 'euro' ? fmtEuro : fmtCFA;
  const amt = t.entree > 0 ? t.entree : t.sortie;
  const last = done
    ? (t.termineLe ? `clos le ${t.termineLe}` : '<span style="color:var(--text3);">—</span>')
    : suiviLabel(t);
  const age = suiviAge(t);
  const late = !done && age > SUIVI_ALERT_DAYS;
  const chk = done ? '' : `<td class="c-chk"><input type="checkbox" ${suiviSel.has(t.cur + ':' + t.id) ? 'checked' : ''} onchange="toggleSuivi('${t.cur}','${t.id}',this.checked)"></td>`;
  const def = done ? 0 : suiviDefaultRate(t), eff = done ? 0 : suiviContribution(t);
  const rate = done ? '' : `<td class="c-rate">
      <input type="number" class="suivi-rate" step="0.001" min="0" inputmode="decimal" value="${parseFloat(t.tauxSuivi) > 0 ? t.tauxSuivi : ''}" placeholder="${def}"
        onchange="setSuiviTxRate('${t.cur}','${t.id}',this.value)" title="Taux pour le patrimoine avec suivi (vide = ${def} par défaut)">
      <small class="${eff < 0 ? 'val-out' : 'val-in'}" title="Effet sur le patrimoine avec suivi">${eff < 0 ? '−' : '+'}${fmtEuro(Math.abs(eff))}</small>
    </td>`;
  return `<tr>${chk}
    <td class="c-date">${t.date}${late ? ` <span class="badge badge-suivi-late" title="En cours depuis ${age} jours">${svgIc('alert')}${age} j</span>` : ''}</td>
    <td class="c-cur"><span class="badge ${t.cur==='euro'?'badge-euro':'badge-cfa'}">${t.cur==='euro'?'EUR':'CFA'}</span></td>
    <td class="c-op"><span class="badge ${t.operation==='Entrée'?'badge-in':'badge-out'}">${t.operation}</span></td>
    <td class="c-amt ${t.entree>0?'val-in':'val-out'}">${t.entree>0?'+':'−'}${fmt(amt)}</td>
    <td class="c-person"><span class="person-link" data-name="${esc(t.personne)}">${esc(t.personne)}</span></td>
    <td class="c-who${t.contrepartie ? '' : ' is-empty'}">${t.contrepartie ? `<span class="badge badge-cat">${svgIc('user')}${esc(t.contrepartie)}</span>` : '—'}</td>${rate}
    <td class="c-note">${last}</td>
    <td class="c-act">${done
      ? `<button class="act-btn txt" onclick="reopenSuivi('${t.cur}','${t.id}')">${svgIc('restore')}Rouvrir</button>`
      : `<button class="act-btn txt primary" onclick="openClose('${t.cur}','${t.id}')">${svgIc('check')}Terminer</button>`}</td>
  </tr>`;
}

function renderSuivi() {
  const f = document.getElementById('suiviFPerson').value;
  const all = [
    ...euroT.map(t => ({ ...t, cur: 'euro' })),
    ...cfaT.map(t => ({ ...t, cur: 'cfa' }))
  ].filter(t => t.statut);

  const openAll = all.filter(t => t.statut === 'en_cours');
  const badge = document.getElementById('suiviBadge');
  badge.textContent = openAll.length;
  badge.style.display = openAll.length ? '' : 'none';
  const badge2 = document.getElementById('suiviBadge2');
  badge2.textContent = openAll.length;
  badge2.style.display = openAll.length ? '' : 'none';

  // bandeau du Suivi + carte KPI en haut de page
  const late = openAll.filter(t => suiviAge(t) > SUIVI_ALERT_DAYS).length;
  let sumE = 0, sumC = 0;
  openAll.forEach(t => { const a = t.entree > 0 ? t.entree : t.sortie; if (t.cur === 'euro') sumE += a; else sumC += a; });
  const amtTxt = [sumE ? fmtEuro(sumE) : '', sumC ? fmtCFA(sumC) : ''].filter(Boolean).join(' · ') || '—';
  document.getElementById('heroOpen').textContent = openAll.length;
  document.getElementById('heroLate').textContent = late;
  document.getElementById('heroAmt').textContent  = amtTxt;
  document.getElementById('kpiSuivi').textContent = openAll.length;
  document.getElementById('kpiSuiviSub').textContent = late ? `${late} en retard (plus de ${SUIVI_ALERT_DAYS} jours)` : (openAll.length ? 'Aucun retard' : 'Rien à vérifier');

  const shown = f ? all.filter(t => t.contrepartie === f) : all;
  // les plus anciens d'abord : ce sont ceux à relancer en priorité
  const open = shown.filter(t => t.statut === 'en_cours').sort((a,b) => (a.date||'').localeCompare(b.date||''));
  suiviOpenShown = open;
  const openKeys = new Set(open.map(t => t.cur + ':' + t.id));
  [...suiviSel].forEach(k => { if (!openKeys.has(k)) suiviSel.delete(k); });
  renderSuiviSummary(openAll);
  const done = shown.filter(t => t.statut === 'termine')
    .sort((a,b) => (b.termineLe || b.date || '').localeCompare(a.termineLe || a.date || ''));

  document.getElementById('suiviOpenCount').textContent = open.length + ' en cours';
  document.getElementById('suiviDoneCount').textContent = done.length + ' terminée' + (done.length > 1 ? 's' : '');
  document.getElementById('suiviOpenBody').innerHTML = open.length
    ? open.map(t => suiviRowHTML(t, false)).join('')
    : '<tr><td colspan="10" class="empty">Aucune transaction en cours</td></tr>';
  document.getElementById('suiviDoneBody').innerHTML = done.length
    ? done.map(t => suiviRowHTML(t, true)).join('')
    : '<tr><td colspan="8" class="empty">Aucune transaction terminée</td></tr>';
  updateBulkBar();
}

// Terminer un suivi (sans lien entre transactions)
function openClose(type, id) {
  const t = (type === 'euro' ? euroT : cfaT).find(x => x.id === id);
  if (!t) return;
  const today = new Date().toISOString().split('T')[0];
  requireUnlock(() => {
    mutateTx(type, a => a.map(x => x.id === id ? { ...x, statut: 'termine', termineLe: today } : x));
    logAction('Suivi terminé', type, t);
    toast('Suivi terminé', 'ok');
  });
}

function reopenSuivi(type, id) {
  const t = (type === 'euro' ? euroT : cfaT).find(x => x.id === id);
  if (!t) return;
  requireUnlock(() => {
    mutateTx(type, a => a.map(x => x.id === id ? { ...x, statut: 'en_cours', termineLe: null } : x));
    logAction('Suivi rouvert', type, t);
    toast('Suivi rouvert', 'ok');
  });
}

// ── Suivi : ancienneté, résumé par personne, sélection en lot ──
const suiviSel = new Set();      // clés "euro:ID" / "cfa:ID" cochées
let suiviOpenShown = [];

function suiviAge(t) {
  return Math.floor((Date.now() - new Date((t.date || '') + 'T00:00:00').getTime()) / 864e5);
}

function renderSuiviSummary(openAll) {
  const box = document.getElementById('suiviSummary');
  if (!openAll.length) { box.innerHTML = '<div class="sum-empty">Aucune transaction en cours à vérifier.</div>'; return; }
  const current = document.getElementById('suiviFPerson').value;
  const bp = {};
  openAll.forEach(t => {
    const k = t.contrepartie || '';
    const o = bp[k] || (bp[k] = { n: 0, eur: 0, cfa: 0, late: 0 });
    o.n++;
    const a = t.entree > 0 ? t.entree : t.sortie;
    if (t.cur === 'euro') o.eur += a; else o.cfa += a;
    if (suiviAge(t) > SUIVI_ALERT_DAYS) o.late++;
  });
  const keys = Object.keys(bp).sort((a, b) => a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  box.innerHTML = keys.map(k => {
    const o = bp[k];
    const parts = [];
    if (o.eur) parts.push(fmtEuro(o.eur));
    if (o.cfa) parts.push(fmtCFA(o.cfa));
    return `<div class="sum-card${k && k === current ? ' active' : ''}" onclick="setSuiviFilter('${esc(k)}')">
      <div class="sum-av">${k ? esc(k.charAt(0).toUpperCase()) : '?'}</div>
      <div class="sum-body">
        <div class="sum-name"><span>${k ? esc(k) : 'Sans contrepartie'}</span><span class="sum-count">${o.n} en cours</span></div>
        <div class="sum-amt">${parts.join(' · ')}</div>
        ${o.late ? `<div class="sum-late">${svgIc('alert')}${o.late} en retard</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function setSuiviFilter(name) {
  const sel = document.getElementById('suiviFPerson');
  sel.value = sel.value === name ? '' : name;
  renderSuivi();
}

function toggleSuivi(cur, id, checked) {
  const k = cur + ':' + id;
  if (checked) suiviSel.add(k); else suiviSel.delete(k);
  updateBulkBar();
}
function toggleAllSuivi(checked) {
  suiviOpenShown.forEach(t => { const k = t.cur + ':' + t.id; if (checked) suiviSel.add(k); else suiviSel.delete(k); });
  renderSuivi();
}
function updateBulkBar() {
  const n = suiviSel.size;
  const btn = document.getElementById('suiviBulkBtn');
  btn.style.display = n ? '' : 'none';
  btn.innerHTML = `${svgIc('check')}Terminer la sélection (${n})`;
  const all = document.getElementById('suiviChkAll');
  if (all) all.checked = n > 0 && n === suiviOpenShown.length;
}
function closeSelected() {
  if (!suiviSel.size) return;
  const byType = { euro: new Set(), cfa: new Set() };
  suiviSel.forEach(k => { const [cur, id] = k.split(':'); byType[cur].add(id); });
  const n = suiviSel.size;
  requireUnlock(() => {
    const today = new Date().toISOString().split('T')[0];
    ['euro', 'cfa'].forEach(type => {
      const ids = byType[type];
      if (!ids.size) return;
      const list = (type === 'euro' ? euroT : cfaT).filter(t => ids.has(t.id));
      mutateTx(type, a => a.map(x => ids.has(x.id) ? { ...x, statut: 'termine', termineLe: today } : x));
      list.forEach(t => logAction('Suivi terminé (lot)', type, t));
    });
    suiviSel.clear();
    renderSuivi();
    toast(n + ' transaction' + (n > 1 ? 's' : '') + ' terminée' + (n > 1 ? 's' : ''), 'ok');
  });
}

// ══ PATRIMOINE AVEC SUIVI ══
// Une transaction en cours est une créance (sortie) ou une dette (entrée) tant qu'elle n'est pas terminée :
//   EUR : ± montant × taux de la transaction ÷ taux du patrimoine avec suivi
//   CFA : ± montant ÷ taux de la transaction
function suiviIsIn(t) { return (t.entree || 0) > 0; }
function suiviDefaultRate(t) { return SUIVI_TX_RATES[t.cur][suiviIsIn(t) ? 'in' : 'out']; }
function suiviTxRate(t) { const r = parseFloat(t.tauxSuivi); return r > 0 ? r : suiviDefaultRate(t); }
function suiviContribution(t) {
  const isIn = suiviIsIn(t);
  const amt = isIn ? t.entree : (t.sortie || 0);
  const v = t.cur === 'euro' ? amt * suiviTxRate(t) / suiviPatRate : amt / suiviTxRate(t);
  return isIn ? -v : v;
}
function suiviAdjValue(a) { return (a.op === '-' ? -1 : 1) * (Number(a.montant) || 0); }
// Liste (sauvegarde, import) → objet indexé par id, tel qu'enregistré dans Firebase
function suiviAdjObject(v) { const o = {}; toArr(v).forEach(a => { if (a && a.id) o[a.id] = a; }); return o; }
function suiviPatrimoine() {
  const parts = { 'euro:out': { n: 0, v: 0 }, 'euro:in': { n: 0, v: 0 }, 'cfa:out': { n: 0, v: 0 }, 'cfa:in': { n: 0, v: 0 } };
  [...euroT.map(t => ({ ...t, cur: 'euro' })), ...cfaT.map(t => ({ ...t, cur: 'cfa' }))]
    .filter(t => t.statut === 'en_cours')
    .forEach(t => { const p = parts[t.cur + ':' + (suiviIsIn(t) ? 'in' : 'out')]; p.n++; p.v += suiviContribution(t); });
  const base = patrimoineTotal();
  const suivi = Object.values(parts).reduce((s, p) => s + p.v, 0);
  const manual = suiviAdj.reduce((s, a) => s + suiviAdjValue(a), 0);
  return { base, parts, suivi, manual, total: base + suivi + manual };
}
function fmtSigned(v) { return (v < 0 ? '− ' : '+ ') + fmtEuro(Math.abs(v)); }

function renderSuiviPat() {
  const p = suiviPatrimoine();
  const gap = p.suivi + p.manual;
  document.getElementById('kpiSuiviPat').textContent = fmtEuro(p.total);
  document.getElementById('kpiSuiviPatSub').textContent = `${fmtSigned(gap)} par rapport au patrimoine`;
  const rateIn = document.getElementById('suiviPatRate');
  if (!rateIn.matches(':focus')) rateIn.value = suiviPatRate;

  const line = (label, value, sub) => `<div class="adam-calc-row">
      <span>${label}${sub ? `<small>${sub}</small>` : ''}</span>
      <b class="${value < 0 ? 'val-neg' : ''}">${fmtSigned(value)}</b>
    </div>`;
  const part = (k, label, how) => line(label, p.parts[k].v, `${p.parts[k].n} en cours · ${how}`);
  document.getElementById('suiviPatCalc').innerHTML =
    `<div class="adam-calc-row"><span>Patrimoine total<small>au taux 1 € = ${customRate.toLocaleString('fr-FR')} CFA</small></span><b>${fmtEuro(p.base)}</b></div>` +
    part('euro:out', 'Sorties EUR en cours', `montant × taux ÷ ${suiviPatRate.toLocaleString('fr-FR')}`) +
    part('euro:in',  'Entrées EUR en cours', `montant × taux ÷ ${suiviPatRate.toLocaleString('fr-FR')}`) +
    part('cfa:out',  'Sorties CFA en cours', 'montant ÷ taux') +
    part('cfa:in',   'Entrées CFA en cours', 'montant ÷ taux') +
    suiviAdj.map(a => line(esc(a.label), suiviAdjValue(a), 'ajustement manuel' + (a.who ? ' · ' + esc(a.who) : ''))).join('') +
    `<div class="adam-calc-row total"><span>Patrimoine avec suivi</span><b class="${p.total < 0 ? 'val-neg' : 'val-pos'}">${fmtEuro(p.total)}</b></div>`;

  document.getElementById('suiviAdjList').innerHTML = suiviAdj.length ? suiviAdj.map(a => `<div class="adam-other${suiviAdjEditing === a.id ? ' editing' : ''}">
      <span class="badge ${a.op === '-' ? 'badge-out' : 'badge-in'}">${a.op === '-' ? 'À enlever' : 'À ajouter'}</span>
      <span class="adam-other-label">${esc(a.label)}</span>
      <b>${fmtEuro(Number(a.montant) || 0)}</b>
      <button class="act-btn" onclick="suiviAdjEdit('${esc(a.id)}')" title="Modifier">${svgIc('edit')}</button>
      <button class="act-btn act-del" onclick="suiviAdjDelete('${esc(a.id)}')" title="Supprimer">${svgIc('trash')}</button>
    </div>`).join('') : '<div class="ai-mem-empty">Aucun ajustement. Ajoutez-en un ci-dessous pour ajouter ou enlever un montant en euros.</div>';

  document.getElementById('suiviImpact').innerHTML =
    `<span>Effet des transactions en cours sur le patrimoine : <b class="${p.suivi < 0 ? 'val-neg' : 'val-pos'}">${fmtSigned(p.suivi)}</b></span>` +
    `<span>Patrimoine avec suivi : <b>${fmtEuro(p.total)}</b> <a href="#" onclick="goSuiviPat();return false;">Détail</a></span>`;
}

function goSuiviPat() {
  switchTab('dash');
  document.getElementById('suiviPatPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applySuiviPatRate(val) {
  const v = parseFloat(val);
  suiviPatRate = v > 0 ? v : SUIVI_PAT_RATE;
  try { localStorage.setItem('kanga_suiviPatRate', suiviPatRate); } catch (e) {}
  db.ref('settings/suiviPatRate').set(v > 0 ? v : null).catch(() => {});
  updateAll();
}

// Taux propre à une transaction en cours (vide = taux par défaut selon le sens)
function setSuiviTxRate(type, id, val) {
  const t = (type === 'euro' ? euroT : cfaT).find(x => x.id === id);
  if (!t) return;
  const r = parseFloat(val);
  const next = r > 0 ? r : null;
  if ((parseFloat(t.tauxSuivi) || null) === next) return;
  const def = suiviDefaultRate({ ...t, cur: type });
  requireUnlock(() => {
    mutateTx(type, a => a.map(x => x.id === id ? { ...x, tauxSuivi: next } : x));
    logAction('Taux du suivi modifié', type, t, next ? `1 € = ${next} CFA` : `taux par défaut (${def})`);
    toast(next ? `Taux ${next} enregistré` : `Taux par défaut (${def}) rétabli`, 'ok');
  });
}

// ── Ajustements manuels (montants en € ajoutés ou enlevés du patrimoine avec suivi) ──
function suiviAdjSubmit(e) {
  e.preventDefault();
  const label = document.getElementById('suiviAdjLabel').value.trim();
  const montant = parseFloat(document.getElementById('suiviAdjAmt').value);
  const op = document.getElementById('suiviAdjOp').value === '-' ? '-' : '+';
  if (!label) { toast('Donnez un libellé', 'err'); return false; }
  if (!(montant > 0)) { toast('Montant invalide', 'err'); return false; }
  const prev = suiviAdjEditing && suiviAdj.find(a => a.id === suiviAdjEditing);
  requireUnlock(() => {
    const rec = { id: prev ? prev.id : genId(), label, montant, op, who: getWho() || 'Inconnu', at: new Date().toISOString() };
    db.ref('suiviAjustements/' + rec.id).set(rec).then(scheduleMirror).catch(() => toast('Erreur de synchronisation', 'err'));
    logAction(prev ? 'Ajustement du patrimoine modifié' : 'Ajustement du patrimoine ajouté', null, null, `${label} : ${fmtSigned(suiviAdjValue(rec))}`);
    suiviAdjCancel();
    toast(prev ? `« ${label} » mis à jour` : `« ${label} » ajouté`, 'ok');
  });
  return false;
}
function suiviAdjEdit(id) {
  const a = suiviAdj.find(x => x.id === id);
  if (!a) return;
  suiviAdjEditing = id;
  document.getElementById('suiviAdjLabel').value = a.label;
  document.getElementById('suiviAdjAmt').value = a.montant;
  document.getElementById('suiviAdjOp').value = a.op === '-' ? '-' : '+';
  document.querySelector('#suiviAdjBtn span').textContent = 'Mettre à jour';
  document.getElementById('suiviAdjCancel').style.display = '';
  renderSuiviPat();
  document.getElementById('suiviAdjAmt').focus();
}
function suiviAdjCancel() {
  suiviAdjEditing = null;
  document.getElementById('suiviAdjLabel').value = '';
  document.getElementById('suiviAdjAmt').value = '';
  document.getElementById('suiviAdjOp').value = '+';
  document.querySelector('#suiviAdjBtn span').textContent = 'Ajouter';
  document.getElementById('suiviAdjCancel').style.display = 'none';
  renderSuiviPat();
}
function suiviAdjDelete(id) {
  const a = suiviAdj.find(x => x.id === id);
  if (!a || !confirm(`Supprimer « ${a.label} » ?`)) return;
  requireUnlock(() => {
    if (suiviAdjEditing === id) suiviAdjCancel();
    db.ref('suiviAjustements/' + id).remove().then(scheduleMirror).catch(() => toast('Erreur de synchronisation', 'err'));
    logAction('Ajustement du patrimoine supprimé', null, null, `${a.label} : ${fmtSigned(suiviAdjValue(a))}`);
    toast(`« ${a.label} » supprimé`, '', () => {
      db.ref('suiviAjustements/' + id).set(a).then(scheduleMirror).catch(() => {});
      toast('Suppression annulée', 'ok');
    });
  });
}

// ── Qui utilise l'appareil + journal des modifications ──
function getWho() { try { return localStorage.getItem('kanga_who') || ''; } catch (e) { return ''; } }
function setWho(v) {
  try { localStorage.setItem('kanga_who', v); } catch (e) {}
  ['whoAmI', 'whoAmI2'].forEach(id => { const s = document.getElementById(id); if (s) s.value = v; });
  // conversations de l'assistant : privées par personne → on change de liste
  aiCurrent = null;
  aiRenderConvList();
  if (currentTab === 'assistant') aiRenderMessages();
  adamNavUpdate();
}
function fillWho() {
  ['whoAmI', 'whoAmI2'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">👤 Qui ?</option>' + SUIVI_PERSONS.map(p => `<option value="${p}">👤 ${p}</option>`).join('');
    sel.value = getWho();
  });
}

function logAction(action, type, tx, detail) {
  const rec = {
    ts: new Date().toISOString(),
    who: getWho() || 'Inconnu',
    action,
    devise: type === 'euro' ? 'EUR' : type === 'cfa' ? 'CFA' : null,
    txId: (tx && tx.id) || null,
    operation: (tx && tx.operation) || null,
    montant: tx ? (tx.entree || tx.sortie || 0) : null,
    personne: (tx && tx.personne) || null,
    detail: detail || null
  };
  db.ref('log').push(rec).catch(() => {});
}

const DIFF_FIELDS = { date:'date', operation:'opération', entree:'entrée', sortie:'sortie', personne:'personne',
  categorie:'catégorie', remarque:'remarque', taux:'taux', contrepartie:'suivi avec', statut:'statut' };
function diffTx(a, b) {
  if (!a) return null;
  const out = [];
  for (const k in DIFF_FIELDS) {
    const x = a[k] == null ? '' : String(a[k]), y = b[k] == null ? '' : String(b[k]);
    if (x !== y) out.push(`${DIFF_FIELDS[k]} : ${x || '∅'} → ${y || '∅'}`);
  }
  return out.join(' · ') || 'aucun changement';
}

async function openLog() {
  document.getElementById('logModal').classList.add('open');
  const el = document.getElementById('logList');
  el.innerHTML = '<div class="loading">Chargement...</div>';
  try {
    const snap = await db.ref('log').orderByKey().limitToLast(200).once('value');
    const list = [];
    snap.forEach(c => { list.push(c.val()); });
    list.reverse();
    el.innerHTML = list.length ? list.map(r => {
      const fmt = r.devise === 'CFA' ? fmtCFA : fmtEuro;
      const what = [r.devise, r.operation, r.montant != null && r.devise ? fmt(r.montant) : '', r.personne ? '· ' + r.personne : '']
        .filter(Boolean).join(' ');
      return `<div class="log-item">
        <div class="log-time">${new Date(r.ts).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</div>
        <div class="log-who">${esc(r.who)}</div>
        <div><b>${esc(r.action)}</b> ${esc(what)}${r.detail ? `<div style="color:var(--text3);font-size:.72rem;margin-top:2px;">${esc(r.detail)}</div>` : ''}</div>
      </div>`;
    }).join('') : '<div class="snap-empty">Aucune action enregistrée pour l\'instant.</div>';
  } catch (e) { el.innerHTML = '<div class="snap-empty">Impossible de charger le journal.</div>'; }
}
function closeLog() { document.getElementById('logModal').classList.remove('open'); }

// ── Corbeille (30 jours) ──
let trash = [];
function trashPut(type, tx) {
  db.ref('trash/' + tx.id).set({ type, tx, deletedAt: new Date().toISOString() }).catch(() => {});
}
function trashDrop(id) { db.ref('trash/' + id).remove().catch(() => {}); }

function listenTrash() {
  db.ref('trash').on('value', s => {
    const limit = Date.now() - TRASH_DAYS * 864e5;
    trash = [];
    Object.entries(s.val() || {}).forEach(([k, e]) => {
      if (!e || !e.tx) return;
      if (new Date(e.deletedAt).getTime() < limit) { db.ref('trash/' + k).remove().catch(() => {}); return; }
      trash.push(e);
    });
    trash.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    document.getElementById('trashCount').textContent = trash.length ? `(${trash.length})` : '';
    if (document.getElementById('trashModal').classList.contains('open')) renderTrash();
  });
}
function renderTrash() {
  const el = document.getElementById('trashList');
  if (!trash.length) { el.innerHTML = '<div class="snap-empty">La corbeille est vide.</div>'; return; }
  el.innerHTML = trash.map(e => {
    const t = e.tx, fmt = e.type === 'euro' ? fmtEuro : fmtCFA;
    const left = Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - new Date(e.deletedAt).getTime()) / 864e5));
    return `<div class="snap-item">
      <div class="snap-info">
        <div class="snap-date">${t.date} · ${esc(t.personne)} <span class="badge ${e.type==='euro'?'badge-euro':'badge-cfa'}">${e.type==='euro'?'EUR':'CFA'}</span></div>
        <div class="snap-meta">${t.operation} ${fmt(t.entree || t.sortie)} · supprimée le ${new Date(e.deletedAt).toLocaleDateString('fr-FR')} · encore ${left} j</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="snap-restore-btn" onclick="restoreFromTrash('${t.id}')">${svgIc('restore')}Restaurer</button>
        <button class="act-btn act-del" onclick="purgeTrash('${t.id}')" title="Supprimer définitivement">${svgIc('x')}</button>
      </div>
    </div>`;
  }).join('');
}
function openTrash() { document.getElementById('trashModal').classList.add('open'); renderTrash(); }
function closeTrash() { document.getElementById('trashModal').classList.remove('open'); }
function restoreFromTrash(id) {
  const e = trash.find(x => x.tx.id === id);
  if (!e) return;
  requireUnlock(() => {
    mutateTx(e.type, a => a.some(x => x.id === id) ? a : [...a, e.tx]);
    trashDrop(id);
    logAction('Restauration depuis la corbeille', e.type, e.tx);
    toast('Transaction restaurée', 'ok');
  });
}
function purgeTrash(id) {
  const e = trash.find(x => x.tx.id === id);
  if (!e || !confirm('Supprimer définitivement cette transaction ?')) return;
  requireUnlock(() => {
    trashDrop(id);
    logAction('Suppression définitive', e.type, e.tx);
  });
}

// ── Hors ligne (PWA) : copie locale des dernières données connues ──
// Firebase Realtime Database (web) ne garde pas de cache disque : on le fait nous-mêmes.
function saveLocalCache() {
  try { localStorage.setItem('kanga_cache', JSON.stringify({ ts: Date.now(), euroT, cfaT, holdings, notes, suiviAdj })); } catch (e) {}
}
function hydrateFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem('kanga_cache') || 'null');
    if (!c) return;
    euroT = toArr(c.euroT); cfaT = toArr(c.cfaT); holdings = toArr(c.holdings); notes = toArr(c.notes); suiviAdj = toArr(c.suiviAdj);
    document.getElementById('euroLoading').style.display = 'none';
    document.getElementById('cfaLoading').style.display = 'none';
    updateAll(); renderHoldings(); renderNotesList();
  } catch (e) {}
}

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ════════════════════════════════════════════
//  ASSISTANT IA — Google Gemini (offre gratuite)
//  La clé reste sur l'appareil (localStorage), jamais dans le code publié.
//  Conversations et mémoire : Firebase /assistant (partagées entre appareils).
//  À chaque question, KANGA joint un dossier complet : transactions, argent détenu,
//  notes, patrimoine jour par jour et mémoire. L'IA lit et répond, elle ne modifie rien.
// ════════════════════════════════════════════
const AI_API = 'https://generativelanguage.googleapis.com/v1beta';
// utilisés seulement si la liste des modèles n'est pas lisible ; le meilleur « Flash » est choisi automatiquement
const AI_FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const AI_SUGGESTIONS = [
  'Pourquoi le patrimoine total a baissé récemment ?',
  'Trouve l\'entrée CFA qui correspond à ma dernière entrée euro',
  'Fais une synthèse de mes notes',
  'Y a-t-il des anomalies ce mois-ci ?',
  'Fais le point par personne (transactions et argent détenu)'
];
let aiConvs = {}, aiMem = {}, aiCurrent = null, aiBusy = false;

function aiKey() { try { return localStorage.getItem('kanga_gemini_key') || ''; } catch (e) { return ''; } }
function aiSaveKey(e) {
  e.preventDefault();
  const k = document.getElementById('aiKeyInput').value.trim();
  if (!k) return false;
  try { localStorage.setItem('kanga_gemini_key', k); localStorage.removeItem('kanga_gemini_model'); } catch (err) {}
  document.getElementById('aiKeyInput').value = '';
  aiShowSetup(false);
  toast('Clé enregistrée sur cet appareil', 'ok');
  return false;
}
function aiForgetKey() {
  if (!confirm('Supprimer la clé Gemini de cet appareil ?')) return;
  try { localStorage.removeItem('kanga_gemini_key'); localStorage.removeItem('kanga_gemini_model'); } catch (e) {}
  aiRender();
}
function aiShowSetup(show) {
  const has = !!aiKey();
  document.getElementById('aiSetup').style.display = (show || !has) ? '' : 'none';
  document.getElementById('aiForgetBtn').style.display = has ? '' : 'none';
  document.getElementById('aiCloseSetupBtn').style.display = has ? '' : 'none';
  document.getElementById('aiLayout').classList.remove('show-side');
}
function aiToggleSide() { document.getElementById('aiLayout').classList.toggle('show-side'); }
function aiAutosize() {
  const t = document.getElementById('aiInput');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 160) + 'px';
}

function aiInit() {
  db.ref('assistant/conversations').on('value', s => {
    aiConvs = s.val() || {};
    aiRenderConvList();
    if (currentTab === 'assistant' && !aiBusy) aiRenderMessages();
  });
  db.ref('assistant/memory').on('value', s => { aiMem = s.val() || {}; aiRenderMemory(); });
}

// ── Modèles à essayer, dans l'ordre : celui qui a marché la dernière fois, puis les « Flash »
//    stables du plus récent au plus ancien, puis les « Flash-Lite » (plus légers, moins saturés) ──
function aiVersion(name) { const m = name.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; }
let aiModelList = null;
async function aiModels(key) {
  if (!aiModelList) {
    let names = [];
    try {
      const r = await fetch(`${AI_API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
      if (r.ok) {
        const j = await r.json();
        names = (j.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => m.name.replace(/^models\//, ''));
      }
    } catch (e) {}
    const byVersion = (a, b) => aiVersion(b) - aiVersion(a);
    const flash = names.filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort(byVersion);
    const lite  = names.filter(n => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort(byVersion);
    aiModelList = [...flash, ...lite];
    if (!aiModelList.length) aiModelList = AI_FALLBACK_MODELS.slice();
  }
  let saved = '';
  try { saved = localStorage.getItem('kanga_gemini_model') || ''; } catch (e) {}
  const list = saved ? [saved, ...aiModelList.filter(m => m !== saved)] : aiModelList.slice();
  return list.slice(0, 5);
}
const aiWait = ms => new Promise(res => setTimeout(res, ms));

// ── Dossier envoyé à l'IA : tout KANGA sous forme compacte ──
function aiCell(v) { return String(v == null ? '' : v).replace(/[;\r\n]+/g, ' ').trim(); }
function aiDossier() {
  const r2 = n => Math.round(n * 100) / 100;
  const eS = euroT.reduce((a, t) => a + (t.entree || 0) - (t.sortie || 0), 0);
  const cS = cfaT.reduce((a, t) => a + (t.entree || 0) - (t.sortie || 0), 0);
  const hE = holdingsTotalEUR();
  const L = [];
  L.push(`Date du jour : ${new Date().toISOString().slice(0, 10)}`);
  L.push(`Taux de référence : 1 € = ${customRate} CFA (taux officiel : ${OFFICIAL_RATE})`);
  L.push(`Patrimoine actuel : solde Euro ${r2(eS)} € ; solde CFA ${Math.round(cS)} CFA (≈ ${r2(cS / customRate)} €) ; argent détenu par des personnes ≈ ${r2(hE)} € ; TOTAL ≈ ${r2(eS + cS / customRate + hE)} €`);
  const sp = suiviPatrimoine();
  L.push(`Patrimoine avec suivi : ${r2(sp.total)} € = patrimoine ${r2(sp.base)} € + effet des transactions en cours ${r2(sp.suivi)} € + ajustements manuels ${r2(sp.manual)} € (taux du patrimoine avec suivi : 1 € = ${suiviPatRate} CFA)`);

  // patrimoine jour par jour, à partir des transactions (au taux de référence actuel, hors argent détenu)
  const byDay = {};
  euroT.forEach(t => { const d = t.date || '?'; (byDay[d] = byDay[d] || { e: 0, c: 0 }).e += (t.entree || 0) - (t.sortie || 0); });
  cfaT.forEach(t => { const d = t.date || '?'; (byDay[d] = byDay[d] || { e: 0, c: 0 }).c += (t.entree || 0) - (t.sortie || 0); });
  let ce = 0, cc = 0;
  L.push('', '## Patrimoine jour par jour (cumul des transactions, au taux de référence, hors argent détenu)', 'date;solde_eur;solde_cfa;total_eur;variation_eur');
  let prev = 0;
  Object.keys(byDay).sort().forEach(d => {
    ce += byDay[d].e; cc += byDay[d].c;
    const tot = ce + cc / customRate;
    L.push(`${d};${r2(ce)};${Math.round(cc)};${r2(tot)};${r2(tot - prev)}`);
    prev = tot;
  });

  const txLines = (arr, cur) => arr.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(t =>
    [t.id, t.date, t.operation, t.entree || 0, t.sortie || 0, t.personne, t.categorie, t.taux, t.statut, t.contrepartie,
      t.statut === 'en_cours' ? suiviTxRate({ ...t, cur }) : '', t.remarque].map(aiCell).join(';'));
  const txHead = 'id;date;operation;entree;sortie;personne;categorie;taux;statut_suivi;suivi_avec;taux_suivi;remarque';
  L.push('', '## Transactions EURO (montants en €)', txHead, ...txLines(euroT, 'euro'));
  L.push('', '## Transactions CFA (montants en FCFA)', txHead, ...txLines(cfaT, 'cfa'));

  L.push('', '## Ajustements manuels du patrimoine avec suivi (en €)', 'libellé;montant;effet;par;date');
  suiviAdj.forEach(a => L.push([a.label, a.montant, a.op === '-' ? 'à enlever' : 'à ajouter', a.who, (a.at || '').slice(0, 10)].map(aiCell).join(';')));
  if (!suiviAdj.length) L.push('(aucun)');

  L.push('', '## Argent détenu par des personnes (hors transactions)', 'personne;devise;montant;remarque');
  holdings.forEach(h => L.push([h.personne, h.devise, h.montant, h.remarque].map(aiCell).join(';')));

  L.push('', '## Notes');
  notes.forEach(n => L.push(`### ${n.title || 'Sans titre'} (modifiée le ${(n.updatedAt || '').slice(0, 10)})`, String(n.content || '').slice(0, 4000)));

  const mem = Object.values(aiMem || {});
  L.push('', '## Mémoire (faits à retenir donnés par l\'utilisateur)');
  mem.forEach(m => L.push('- ' + m.text));
  if (!mem.length) L.push('(vide)');

  const adamSection = adamDossierSection();
  if (adamSection) L.push(adamSection);
  return L.join('\n');
}

const AI_SYSTEM = `Tu es l'assistant de KANGA, une application de suivi d'échanges Euro ↔ Franc CFA entre Adam, Abbas et Youssouf.
L'utilisateur s'appelle ${'{WHO}'}. Réponds en français, clairement et brièvement, avec des listes courtes et les montants exacts.

Règles :
- Appuie-toi uniquement sur les DONNÉES KANGA ci-dessous. Si une information manque, dis-le au lieu d'inventer.
- Vérifie chaque calcul. Cite la date, la personne et le montant des transactions dont tu parles.
- Patrimoine total = solde Euro + solde CFA ÷ taux de référence + argent détenu par des personnes.
- Patrimoine avec suivi = patrimoine total + effet de chaque transaction « en cours » du suivi + ajustements manuels. Effet d'une transaction en cours (taux = colonne taux_suivi) : sortie EUR + montant × taux ÷ taux du patrimoine avec suivi ; entrée EUR − montant × taux ÷ taux du patrimoine avec suivi ; sortie CFA + montant ÷ taux ; entrée CFA − montant ÷ taux. Une sortie en cours est une créance (on nous doit la contrepartie), une entrée en cours est une dette.
- Si la section « Espace Adam » est présente : Solde après KANGA = Total de mes banques − Solde Euro de KANGA ± autres montants (chaque autre montant est déjà donné avec son effet). Cette section n'apparaît que lorsque Adam a déjà déverrouillé l'Espace Adam sur cet appareil pendant cette session ; si elle est absente et qu'on te parle du « solde après KANGA » ou des soldes bancaires, dis que ces données ne sont pas disponibles tant que l'Espace Adam n'a pas été ouvert.
- Variation du patrimoine : compare les dates dans « Patrimoine jour par jour », repère les jours où il a baissé et liste les transactions de ces jours qui l'expliquent. Rappelle qu'un changement de l'argent détenu ou du taux de référence peut aussi le faire varier (ils ne sont pas dans l'historique).
- Contrepartie entre Euro et CFA : montant CFA ≈ montant € × taux (taux de la transaction, sinon entre 650 et 700). Compare les noms (identiques, proches ou cités dans les remarques), les dates (quelques jours à quelques semaines d'écart) et pense aux paiements en plusieurs fois (somme de 2 ou 3 transactions). Propose les meilleurs candidats avec un niveau de confiance (fort, moyen, faible).
- Anomalies à signaler : doublons, taux inhabituels, sorties sans contrepartie, suivis en cours depuis longtemps, soldes négatifs, montants très inhabituels.
- Tu ne peux rien modifier dans KANGA : propose, l'utilisateur décide.
- Si l'utilisateur te demande de retenir quelque chose, termine ta réponse par une ligne « MEMO: <le fait à retenir> » (une ligne par fait).`;

async function aiAsk(key, messages) {
  const history = messages.filter(m => !m.error && !m.failed).slice(-20)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const system = AI_SYSTEM.replace('{WHO}', getWho() || 'l\'utilisateur') + '\n\n# DONNÉES KANGA\n' + aiDossier();
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: history });

  // Modèle saturé (503/500), quota du modèle atteint (429) ou modèle retiré (404) :
  // on réessaie une fois après une courte pause, puis on passe au modèle suivant.
  const models = await aiModels(key);
  let saturated = false, quota = false, lastMsg = '';
  for (const model of models) {
    for (let retry = 0; retry < 2; retry++) {
      let r;
      try {
        r = await fetch(`${AI_API}/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body
        });
      } catch (e) { throw new Error('Pas de connexion internet : l\'assistant a besoin du réseau.'); }
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const cand = (j.candidates || [])[0] || {};
        const text = ((cand.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
        if (!text) throw new Error('Réponse vide (' + (cand.finishReason || (j.promptFeedback || {}).blockReason || 'raison inconnue') + ').');
        try { localStorage.setItem('kanga_gemini_model', model); } catch (e) {}
        document.getElementById('aiModelInfo').textContent = model;
        return text;
      }
      lastMsg = (j.error && j.error.message) || ('HTTP ' + r.status);
      if (r.status === 400 && /api key/i.test(lastMsg)) throw new Error('Clé invalide. Vérifiez-la dans « Clé Gemini ».');
      if (r.status === 403) throw new Error('Clé refusée par Google : ' + lastMsg);
      if (r.status === 503 || r.status === 500) { saturated = true; if (retry === 0) { await aiWait(1500); continue; } break; }
      if (r.status === 429) { quota = true; break; }
      if (r.status === 404) break;
      throw new Error('Erreur Gemini : ' + lastMsg);
    }
  }
  if (saturated) throw new Error('Les serveurs Gemini gratuits sont saturés en ce moment (tous les modèles essayés). Réessayez dans quelques minutes.');
  if (quota) throw new Error('Quota gratuit atteint pour le moment. Réessayez dans une minute, ou demain si la limite du jour est atteinte.');
  throw new Error('Aucun modèle Gemini disponible avec cette clé (' + lastMsg + ').');
}

async function aiSend(e, preset) {
  if (e && e.preventDefault) e.preventDefault();
  if (aiBusy) return false;
  const key = aiKey();
  if (!key) { aiShowSetup(true); return false; }
  const input = document.getElementById('aiInput');
  const q = String(preset || input.value).trim();
  if (!q) return false;
  if (!getWho()) { toast('Choisissez d\'abord votre nom (« Qui ? »)', 'err'); aiRenderMessages(); return false; }
  input.value = ''; aiAutosize();

  const now = () => new Date().toISOString();
  if (!aiCurrent || !aiVisible(aiConvs[aiCurrent])) {
    aiCurrent = genId();
    aiConvs[aiCurrent] = { title: q.slice(0, 70), owner: getWho(), createdAt: now(), updatedAt: now(), messages: [] };
  }
  const conv = aiConvs[aiCurrent];
  conv.messages = toArr(conv.messages);
  const userMsg = { role: 'user', text: q, ts: now(), who: getWho() || '' };
  conv.messages.push(userMsg);
  aiBusy = true;
  document.getElementById('aiSendBtn').disabled = true;
  aiRenderMessages(true);

  try {
    const answer = await aiAsk(key, conv.messages);
    const memos = [];
    answer.replace(/^\s*MEMO:\s*(.+)$/gim, (all, fact) => { memos.push(fact.trim()); return ''; });
    const clean = answer.replace(/^\s*MEMO:.*$/gim, '').trim();
    memos.forEach(aiSaveMemory);
    conv.messages.push({ role: 'model', text: clean + (memos.length ? '\n\n*Mémorisé : ' + memos.join(' · ') + '*' : ''), ts: now() });
  } catch (err) {
    userMsg.failed = true;
    conv.messages.push({ role: 'model', text: err.message, ts: now(), error: true });
  }
  conv.updatedAt = now();
  aiBusy = false;
  document.getElementById('aiSendBtn').disabled = false;
  db.ref('assistant/conversations/' + aiCurrent).set(conv).catch(() => {});
  aiRenderMessages();
  aiRenderConvList();
  return false;
}

// ── Affichage ──
function aiFormat(t) {
  let h = esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.split('\n').map(l => {
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) return '<li>' + l.replace(/^\s*([-*•]|\d+[.)])\s+/, '') + '</li>';
    if (/^#{1,4}\s+/.test(l)) return '<div class="ai-h">' + l.replace(/^#{1,4}\s+/, '') + '</div>';
    return l;
  }).join('\n');
  h = h.replace(/(?:<li>.*<\/li>\n?)+/g, m => '<ul>' + m.replace(/\n/g, '') + '</ul>');
  return h.replace(/\n/g, '<br>').replace(/<\/ul><br>/g, '</ul>').replace(/<\/div><br>/g, '</div>');
}
function aiRender() {
  aiShowSetup(false);
  aiRenderMessages();
  aiRenderConvList();
  aiRenderMemory();
  let m = ''; try { m = localStorage.getItem('kanga_gemini_model') || ''; } catch (e) {}
  document.getElementById('aiModelInfo').textContent = m;
}
// Conversations privées : chacun voit les siennes (nom choisi dans « Qui ? ») ;
// les anciennes conversations sans propriétaire restent visibles par tous. La mémoire est commune.
function aiVisible(c) { return !!c && (!c.owner || c.owner === getWho()); }

function aiRenderMessages(loading) {
  const box = document.getElementById('aiMessages');
  if (!box) return;
  if (aiCurrent && !aiVisible(aiConvs[aiCurrent])) aiCurrent = null;
  const conv = aiCurrent && aiConvs[aiCurrent];
  if (!getWho() && !loading) {
    document.getElementById('aiChatTitle').textContent = 'Qui êtes-vous ?';
    box.innerHTML = `<div class="ai-welcome">
      <div class="ai-welcome-ic">${svgIc('user')}</div>
      <h3>Qui utilise cet appareil ?</h3>
      <p>Vos conversations avec l'assistant sont privées : choisissez votre nom pour voir les vôtres. La mémoire reste commune à tous.</p>
      <div class="ai-chips">${SUIVI_PERSONS.map(p => `<button class="ai-chip" onclick="setWho('${p}')">${p}</button>`).join('')}</div>
    </div>`;
    return;
  }
  const msgs = conv ? toArr(conv.messages) : [];
  document.getElementById('aiChatTitle').textContent = conv ? (conv.title || 'Conversation') : 'Nouvelle conversation';
  if (!msgs.length && !loading) {
    box.innerHTML = `<div class="ai-welcome">
      <div class="ai-welcome-ic">${svgIc('spark')}</div>
      <h3>Bonjour${getWho() ? ' ' + esc(getWho()) : ''}, que voulez-vous savoir ?</h3>
      <p>L'assistant lit toutes vos transactions, l'argent détenu, vos notes et l'évolution du patrimoine. Il explique et propose, il ne modifie rien.</p>
      <div class="ai-chips">${AI_SUGGESTIONS.map((s, i) => `<button class="ai-chip" onclick="aiSend(null, AI_SUGGESTIONS[${i}])">${esc(s)}</button>`).join('')}</div>
    </div>`;
    return;
  }
  box.innerHTML = msgs.map(m => `<div class="ai-msg ${m.role === 'user' ? 'me' : 'bot'}${m.error ? ' err' : ''}">
      <div class="ai-bubble">${m.role === 'user' ? esc(m.text).replace(/\n/g, '<br>') : aiFormat(m.text)}</div>
    </div>`).join('')
    + (loading ? '<div class="ai-msg bot"><div class="ai-bubble ai-typing"><span></span><span></span><span></span></div></div>' : '');
  box.scrollTop = box.scrollHeight;
}
function aiRenderConvList() {
  const el = document.getElementById('aiConvList');
  if (!el) return;
  const list = Object.entries(aiConvs).map(([id, c]) => ({ id, ...c }))
    .filter(c => getWho() && aiVisible(c))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  el.innerHTML = list.length ? list.map(c => `<div class="ai-conv${c.id === aiCurrent ? ' active' : ''}" onclick="aiOpenConv('${c.id}')">
      <div class="ai-conv-body">
        <div class="ai-conv-t">${esc(c.title || 'Sans titre')}${c.owner ? '' : ' <span class="badge badge-cat">partagée</span>'}</div>
        <div class="ai-conv-d">${new Date(c.updatedAt || c.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })} · ${toArr(c.messages).length} messages</div>
      </div>
      <button class="act-btn act-del" onclick="event.stopPropagation(); aiDeleteConv('${c.id}')" title="Supprimer">${svgIc('trash')}</button>
    </div>`).join('') : '<div class="note-empty">Aucune conversation</div>';
}
function aiRenderMemory() {
  const el = document.getElementById('aiMemList');
  if (!el) return;
  const list = Object.entries(aiMem || {}).map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  el.innerHTML = list.length ? list.map(m => `<div class="ai-mem-item">
      <span>${esc(m.text)}</span>
      <button class="act-btn act-del" onclick="aiDeleteMemory('${m.id}')" title="Oublier">${svgIc('x')}</button>
    </div>`).join('') : '<div class="ai-mem-empty">Rien pour l\'instant. Dites « retiens que… » dans le chat, ou ajoutez un fait ici.</div>';
}
function aiOpenConv(id) { aiCurrent = id; aiRenderMessages(); aiRenderConvList(); document.getElementById('aiLayout').classList.remove('show-side'); }
function aiNewConv() { aiCurrent = null; aiShowSetup(false); aiRenderMessages(); aiRenderConvList(); document.getElementById('aiInput').focus(); }
function aiDeleteConv(id) {
  if (!confirm('Supprimer cette conversation ?')) return;
  db.ref('assistant/conversations/' + id).remove().catch(() => {});
  if (aiCurrent === id) aiCurrent = null;
}
function aiSaveMemory(text) {
  db.ref('assistant/memory/' + genId()).set({ text, createdAt: new Date().toISOString(), who: getWho() || '' }).catch(() => {});
}
function aiAddMemory(e) {
  e.preventDefault();
  const i = document.getElementById('aiMemInput');
  const t = i.value.trim();
  if (t) { aiSaveMemory(t); i.value = ''; }
  return false;
}
function aiDeleteMemory(id) { db.ref('assistant/memory/' + id).remove().catch(() => {}); }

// ════════════════════════════════════════════
//  ESPACE ADAM — soldes bancaires (serveur Cloudflare + Enable Banking)
//  Deux verrous : le code à 4 chiffres (retenu 1 h sur l'appareil) et le mot de passe du serveur
//  (ADAM_TOKEN, saisi une fois par appareil, jamais dans le code). Seul le serveur détient
//  la clé Enable Banking ; les soldes ne passent pas par Firebase ni par l'assistant IA.
// ════════════════════════════════════════════
const ADAM_API = 'https://kanga-banques.adammhtazibert-40c.workers.dev';
const ADAM_PIN_HASH = '44855208';   // empreinte du code, pas le code lui-même
const ADAM_BANKS = [
  { name: 'BNP Paribas',       country: 'FR', color: '#00915a' },
  { name: 'Société Générale',  country: 'FR', color: '#e9041e' },
  { name: 'Boursorama Banque', country: 'FR', color: '#d4007a' },
  { name: 'N26',               country: 'FR', color: '#36a18b' },
  { name: 'Wise',              country: 'BE', color: '#2f6b00' }
];
const ADAM_TYPES = { ITAV: 'disponible', CLAV: 'disponible', OPAV: 'disponible', XPCD: 'prévisionnel', ITBD: 'comptable',
  CLBD: 'comptable', OPBD: 'comptable', PRCD: 'veille', VALU: 'valeur', FWAV: 'à venir', OTHR: 'autre', INFO: 'info' };
const ADAM_UNLOCK_MS = 60 * 60 * 1000;        // déverrouillage retenu 1 h (prolongé à chaque utilisation)
const ADAM_STALE_MS  = 60 * 60 * 1000;        // soldes de plus d'1 h : relus automatiquement à l'ouverture
let adamOpen = false, adamData = null, adamLoadedAt = 0, adamEditing = null, adamPendingTimer = null;

function adamHash(s) { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
function adamStore(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
function adamRead(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function adamToken() { return adamRead('kanga_adam_token'); }
function adamUntil() { return Number(adamRead('kanga_adam_until')) || 0; }
function adamTouch() { adamStore('kanga_adam_until', String(Date.now() + ADAM_UNLOCK_MS)); }
function adamNavUpdate() {
  const show = getWho() === 'Adam';
  document.querySelectorAll('.adam-only').forEach(el => { el.style.display = show ? '' : 'none'; });
  if (!show) { adamLock(true); if (currentTab === 'adam') switchTab('suivi'); }
}

// ── Verrou ──
function adamRender() {
  if (!adamOpen && adamToken() && adamUntil() > Date.now()) adamOpen = true;   // déverrouillé il y a moins d'1 h
  if (adamOpen) adamTouch();
  document.getElementById('adamLock').style.display = adamOpen ? 'none' : '';
  document.getElementById('adamContent').style.display = adamOpen ? '' : 'none';
  document.getElementById('adamTokenRow').style.display = adamToken() ? 'none' : '';
  adamApplyHide();
  if (adamOpen) {
    adamPaint();
    if (!adamData || Date.now() - adamLoadedAt > 5 * 60 * 1000) adamLoad(false);
  } else setTimeout(() => document.getElementById('adamPin').focus(), 80);
}
function adamUnlock(e) {
  e.preventDefault();
  const pinEl = document.getElementById('adamPin');
  const err = document.getElementById('adamLockError');
  if (adamHash('kanga-adam:' + pinEl.value) !== ADAM_PIN_HASH) {
    err.textContent = 'Code incorrect.'; pinEl.value = ''; pinEl.focus(); return false;
  }
  if (!adamToken()) {
    const t = document.getElementById('adamTokenInput').value.trim();
    if (!t) { err.textContent = 'Entrez le mot de passe du serveur bancaire.'; return false; }
    adamStore('kanga_adam_token', t);
    document.getElementById('adamTokenInput').value = '';
  }
  err.textContent = ''; pinEl.value = '';
  adamOpen = true;
  adamTouch();
  adamRender();
  return false;
}
function adamLock(silent) {
  adamOpen = false; adamData = null;
  adamStore('kanga_adam_until', null);
  clearTimeout(adamPendingTimer);
  ['adamBanks', 'adamCalc', 'adamOthers', 'adamDonut', 'adamNotice'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  ['adamTotal', 'adamAfter'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
  if (!silent) adamRender();
}
function adamForgetToken() {
  if (!confirm('Oublier le mot de passe du serveur bancaire sur cet appareil ?')) return;
  adamStore('kanga_adam_token', null);
  adamLock();
}

// ── Masquer les montants (utile en public), retenu sur l'appareil ──
function adamToggleHide() { adamStore('kanga_adam_hide', adamRead('kanga_adam_hide') === '1' ? null : '1'); adamApplyHide(); }
function adamApplyHide() {
  const hidden = adamRead('kanga_adam_hide') === '1';
  document.getElementById('adamContent').classList.toggle('adam-hidden', hidden);
  const btn = document.getElementById('adamHideBtn');
  if (btn) btn.innerHTML = svgIc(hidden ? 'eye-off' : 'eye') + `<span>${hidden ? 'Afficher' : 'Masquer'}</span>`;
}

// ── Échanges avec le serveur ──
async function adamApi(path, body) {
  const opts = { headers: { Authorization: 'Bearer ' + adamToken() } };
  if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(ADAM_API + path, opts);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    adamStore('kanga_adam_token', null);
    adamLock();
    document.getElementById('adamLockError').textContent = 'Mot de passe du serveur incorrect : saisissez-le à nouveau.';
    throw new Error('refusé');
  }
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
// refresh : relire les banques ; auto : relecture automatique (pas de message si elle est ignorée)
async function adamLoad(refresh, auto) {
  if (!adamOpen) return;
  const btn = document.getElementById('adamRefreshBtn');
  btn.disabled = true;
  document.getElementById('adamSub').textContent = refresh ? 'Interrogation des banques…' : 'Chargement…';
  try {
    adamData = await adamApi('/balances' + (refresh ? '?refresh=1' : ''));
    adamLoadedAt = Date.now();
    adamMergeSettings();
    await adamMigrateYoussouf();
    adamPaint();
    const info = adamData.refresh;
    if (refresh && info && !auto) {
      if (info.skipped) toast(`Soldes relus ${adamAgo(adamData.refreshedAt)} : nouvelle actualisation possible dans ${Math.max(1, Math.ceil(info.waitSec / 60))} min`, 'err');
      else if (info.errors) toast(`${info.updated} compte(s) mis à jour, ${info.errors} en erreur (voir les messages sous les comptes)`, 'err');
      else toast(`${info.updated} compte(s) mis à jour`, 'ok');
    } else if (refresh && !info && !auto) {
      toast('Mettez à jour le code du serveur Cloudflare pour voir le résultat de l\'actualisation', 'err');
    }
    // soldes trop anciens (plus d'1 h) : relecture des banques, comme une ouverture d'appli bancaire
    if (!refresh && (!adamData.refreshedAt || Date.now() - Date.parse(adamData.refreshedAt) > ADAM_STALE_MS) && adamData.banks.length) {
      btn.disabled = false;
      return adamLoad(true, true);
    }
  } catch (e) {
    if (e.message !== 'refusé') document.getElementById('adamSub').textContent = 'Serveur bancaire injoignable : ' + e.message;
  } finally { btn.disabled = false; }
}
// L'ancien champ « Montant Youssouf » devient un autre montant comme les autres (une seule fois)
async function adamMigrateYoussouf() {
  if (adamRead('kanga_adam_migrated') === '1') return;   // déjà fait sur cet appareil
  const s = (adamData && adamData.settings) || {};
  const v = Number(s.youssouf) || 0;
  if (!v) { adamStore('kanga_adam_migrated', '1'); return; }
  const others = (s.others || []).slice();
  if (!others.some(o => /youssouf/i.test(o.label))) {
    others.unshift({ id: genId(), label: 'Youssouf' + (s.youssoufNote ? ' (' + s.youssoufNote + ')' : ''), amount: v, op: '-', at: s.youssoufAt || new Date().toISOString() });
  }
  try {
    const updatedAt = new Date().toISOString();
    adamData = await adamApi('/settings', { others, youssouf: 0, youssoufNote: '', updatedAt });
    adamStore('kanga_adam_settings', JSON.stringify({ others: (adamData.settings || {}).others || others, updatedAt }));
    adamStore('kanga_adam_migrated', '1');
  } catch (e) {}
}

// Autres montants : la dernière version enregistrée est aussi gardée sur l'appareil.
// Le stockage du serveur (KV) peut renvoyer une version plus ancienne pendant ~1 minute après
// un enregistrement : c'est toujours la version la plus récente (date updatedAt) qui l'emporte.
function adamLocalSettings() { try { return JSON.parse(adamRead('kanga_adam_settings') || 'null'); } catch (e) { return null; } }
function adamMergeSettings() {
  if (!adamData) return;
  const local = adamLocalSettings();
  const server = adamData.settings || {};
  if (local && local.updatedAt && (!server.updatedAt || local.updatedAt > server.updatedAt)) {
    adamData.settings = { ...server, others: local.others || [], updatedAt: local.updatedAt };
    // toujours pas reçu par le serveur après 2 minutes : on renvoie cette version
    if (Date.now() - Date.parse(local.updatedAt) > 2 * 60 * 1000) {
      adamApi('/settings', { others: local.others || [], updatedAt: local.updatedAt }).catch(() => {});
    }
  } else if (server.updatedAt) {
    adamStore('kanga_adam_settings', JSON.stringify({ others: server.others || [], updatedAt: server.updatedAt }));
  }
}
async function adamRemove(key, name) {
  if (!confirm(`Retirer ${name} de l'Espace Adam ?`)) return;
  try { adamData = await adamApi('/remove?key=' + encodeURIComponent(key)); adamPaint(); toast(name + ' retirée', 'ok'); }
  catch (e) { if (e.message !== 'refusé') toast('Erreur : ' + e.message, 'err'); }
}

// ── Outils d'affichage ──
// € direct, FCFA au taux de référence ; les autres devises ne sont pas converties
function adamToEur(amount, cur) {
  if (cur === 'EUR') return amount;
  if (cur === 'XOF' || cur === 'XAF') return amount / customRate;
  return null;
}
function adamAgo(iso) {
  if (!iso) return 'jamais';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  if (m < 1440) return `il y a ${Math.round(m / 60)} h`;
  return 'le ' + new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function adamMoney(amount, cur) {
  if (cur === 'EUR') return fmtEuro(amount);
  if (cur === 'XOF' || cur === 'XAF') return fmtCFA(amount);
  return amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + cur;
}
function adamHistTotal(h) {
  return Object.entries(h.byCur || {}).reduce((s, [c, v]) => { const e = adamToEur(v, c); return s + (e === null ? 0 : e); }, 0);
}

// ── Affichage complet ──
function adamPaint() {
  const d = adamData;
  if (!d) return;
  let total = 0, nAcc = 0;
  const others = {}, perBank = [];
  const colorOf = name => (ADAM_BANKS.find(b => b.name === name) || {}).color || '#7c3aed';

  document.getElementById('adamBanks').innerHTML = d.banks.length ? d.banks.map(b => {
    let bankEur = 0;
    const rows = b.accounts.map(a => {
      const has = typeof a.amount === 'number';
      if (has) {
        nAcc++;
        const eur = adamToEur(a.amount, a.currency);
        if (eur === null) others[a.currency] = (others[a.currency] || 0) + a.amount;
        else { bankEur += eur; total += eur; }
      }
      return `<div class="adam-acc">
        <div class="adam-acc-main">
          <span class="adam-acc-name">${esc(a.name || 'Compte')}</span>
          <small>${esc(a.iban || a.currency)}${a.type ? ' · ' + (ADAM_TYPES[a.type] || a.type) : ''}${a.at ? ' · ' + adamAgo(a.at) : ''}</small>
          ${a.error ? `<small class="adam-err">${svgIc('alert')}${esc(a.error)}</small>` : ''}
        </div>
        <span class="adam-acc-amt adam-money ${has && a.amount < 0 ? 'val-neg' : ''}">${has ? adamMoney(a.amount, a.currency) : '—'}</span>
      </div>`;
    }).join('');
    perBank.push({ name: b.name, value: bankEur });
    const daysLeft = b.valid_until ? Math.floor((Date.parse(b.valid_until) - Date.now()) / 864e5) : null;
    const consent = daysLeft === null ? '' : daysLeft < 0
      ? `<span class="badge badge-suivi-late">Accès expiré</span>`
      : daysLeft <= 15
        ? `<span class="badge badge-suivi-late">Expire dans ${daysLeft} j</span>`
        : `<span class="adam-valid">Accès jusqu'au ${new Date(b.valid_until).toLocaleDateString('fr-FR')}</span>`;
    return `<div class="adam-bank">
      <div class="adam-bank-head">
        <span class="adam-logo" style="background:${colorOf(b.name)}">${esc(b.name.charAt(0))}</span>
        <div class="adam-bank-title"><b>${esc(b.name)}</b>${consent}</div>
        <span class="adam-bank-total adam-money ${bankEur < 0 ? 'val-neg' : ''}">${fmtEuro(bankEur)}</span>
      </div>
      ${rows || '<div class="a-empty">Aucun compte renvoyé par la banque.</div>'}
      <div class="adam-bank-foot">
        <a class="btn btn-sm" href="${adamStartUrl(b.name, b.country)}" onclick="adamMarkPending('${esc(b.name)}')">${svgIc('restore')}Renouveler l'accès</a>
        <button class="btn btn-sm btn-ghost" onclick="adamRemove('${esc(b.key)}', '${esc(b.name)}')">Retirer</button>
      </div>
    </div>`;
  }).join('') : '<div class="sum-empty">Aucune banque reliée pour l\'instant : utilisez « Relier une banque » ci-dessous.</div>';

  const euroKanga = euroT.reduce((a, t) => a + (t.entree || 0) - (t.sortie || 0), 0);
  const after = adamPaintAfter(total, euroKanga);

  // chiffres du haut
  document.getElementById('adamAfter').textContent = fmtEuro(after);
  document.getElementById('adamAfter').classList.toggle('neg', after < 0);
  document.getElementById('adamTotal').textContent = fmtEuro(total);
  document.getElementById('adamEuroKanga').textContent = fmtEuro(euroKanga);
  document.getElementById('adamEuroCount').textContent = `${euroT.length} transactions Euro`;
  const hist = d.history || [];
  const prev = hist.length >= 2 ? adamHistTotal(hist[hist.length - 2]) : null;
  const delta = prev === null ? null : total - prev;
  document.getElementById('adamDelta').innerHTML = delta === null ? 'évolution visible dès demain'
    : `<span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲ +' : '▼ '}${fmtEuro(delta)}</span> depuis le ${new Date(hist[hist.length - 2].d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}`;
  const otherTxt = Object.entries(others).map(([c, v]) => adamMoney(v, c)).join(' + ');
  document.getElementById('adamSub').textContent =
    `${d.banks.length} banque${d.banks.length > 1 ? 's' : ''} · ${nAcc} compte${nAcc > 1 ? 's' : ''} · relevé ${adamAgo(d.refreshedAt)}` +
    (otherTxt ? ` · en plus : ${otherTxt} (non converti)` : '');

  // répartition par banque (soldes positifs)
  const pos = perBank.filter(p => p.value > 0);
  document.getElementById('adamDonut').innerHTML = pos.length ? donutSVG(
    pos.map(p => ({ label: p.name, value: p.value, color: colorOf(p.name), text: fmtEuro(p.value) })),
    fmtEuro(pos.reduce((s, p) => s + p.value, 0)).replace(' €', '€'), 'soldes positifs')
    + (perBank.some(p => p.value < 0) ? `<div class="adam-neg-note">Comptes à découvert non inclus : ${perBank.filter(p => p.value < 0).map(p => esc(p.name) + ' ' + fmtEuro(p.value)).join(', ')}</div>` : '')
    : '<div class="a-empty">Aucun solde positif à répartir.</div>';

  // courbe : un point par jour, total converti en €
  const pts = hist.map(h => ({ d: h.d, v: adamHistTotal(h) }));
  const chart = document.getElementById('adamChart');
  if (pts.length >= 2) aChartBalance(chart, pts, fmtEuro);
  else chart.innerHTML = '<div class="a-empty">La courbe se remplira jour après jour, à chaque relevé automatique.</div>';

  adamPaintNotice();
  adamPaintLinks();
}

// Solde après KANGA = total de mes banques − solde Euro de KANGA ± autres montants
function adamPaintAfter(banksTotal, euroKanga) {
  const settings = (adamData && adamData.settings) || {};
  const others = Array.isArray(settings.others) ? settings.others : [];
  const sign = o => (o.op === '+' ? 1 : -1) * (Number(o.amount) || 0);
  const after = banksTotal - euroKanga + others.reduce((s, o) => s + sign(o), 0);
  const line = (label, value, sub) => `<div class="adam-calc-row">
      <span>${label}${sub ? `<small>${sub}</small>` : ''}</span>
      <b class="adam-money ${value < 0 ? 'val-neg' : ''}">${value < 0 ? '− ' : '+ '}${fmtEuro(Math.abs(value))}</b>
    </div>`;
  document.getElementById('adamCalc').innerHTML =
    line('Total de mes banques', banksTotal, '') +
    line('Solde Euro de KANGA', -euroKanga, `${euroT.length} transactions Euro`) +
    others.map(o => line(esc(o.label), sign(o), 'autre montant · ' + adamAgo(o.at))).join('') +
    `<div class="adam-calc-row total"><span>Solde après KANGA</span><b class="adam-money ${after < 0 ? 'val-neg' : 'val-pos'}">${fmtEuro(after)}</b></div>`;

  document.getElementById('adamOthers').innerHTML = others.length ? others.map(o => `<div class="adam-other${adamEditing === o.id ? ' editing' : ''}">
      <span class="badge ${o.op === '+' ? 'badge-in' : 'badge-out'}">${o.op === '+' ? 'À ajouter' : 'À retirer'}</span>
      <span class="adam-other-label">${esc(o.label)}</span>
      <b class="adam-money">${fmtEuro(Number(o.amount) || 0)}</b>
      <button class="act-btn" onclick="adamEditOther('${esc(o.id)}')" title="Modifier">${svgIc('edit')}</button>
      <button class="act-btn act-del" onclick="adamDeleteOther('${esc(o.id)}')" title="Supprimer">${svgIc('trash')}</button>
    </div>`).join('') : '<div class="ai-mem-empty">Aucun autre montant. Ajoutez-en un ci-dessous : Youssouf, liquide, argent chez quelqu\'un, dette…</div>';
  return after;
}

// Section ajoutée au dossier envoyé à l'assistant IA : uniquement si Adam a déjà déverrouillé
// l'Espace Adam sur cet appareil pendant cette session (jamais chargée automatiquement en son nom).
function adamDossierSection() {
  if (getWho() !== 'Adam' || !adamOpen || !adamData) return '';
  const d = adamData;
  let total = 0;
  const L = ['', '## Espace Adam — soldes bancaires (visible uniquement parce que l\'Espace Adam est déverrouillé sur cet appareil)',
    'banque;compte;devise;solde;relevé_le'];
  d.banks.forEach(b => b.accounts.forEach(a => {
    if (typeof a.amount !== 'number') return;
    const eur = adamToEur(a.amount, a.currency);
    if (eur !== null) total += eur;
    L.push([b.name, a.name, a.currency, a.amount, (a.at || '').slice(0, 16)].map(aiCell).join(';'));
  }));
  const euroKanga = euroT.reduce((s, t) => s + (t.entree || 0) - (t.sortie || 0), 0);
  const settings = d.settings || {};
  const others = Array.isArray(settings.others) ? settings.others : [];
  const sign = o => (o.op === '+' ? 1 : -1) * (Number(o.amount) || 0);
  const after = total - euroKanga + others.reduce((s, o) => s + sign(o), 0);
  L.push('', `Total de mes banques (converti en €) : ${total.toFixed(2)} €`, `Solde Euro de KANGA : ${euroKanga.toFixed(2)} €`);
  L.push('', '## Autres montants de l\'Espace Adam', 'libellé;montant;effet;date');
  others.forEach(o => L.push([o.label, o.amount, o.op === '+' ? 'à ajouter' : 'à retirer', (o.at || '').slice(0, 10)].map(aiCell).join(';')));
  if (!others.length) L.push('(aucun)');
  L.push('', `Solde après KANGA (total des banques − solde Euro KANGA ± autres montants) : ${after.toFixed(2)} €`);
  const hist = d.history || [];
  if (hist.length) {
    L.push('', '## Historique du total de mes banques (jour par jour, en €)', 'date;total_banques_eur');
    hist.forEach(h => L.push(`${h.d};${adamHistTotal(h).toFixed(2)}`));
  }
  return L.join('\n');
}

// ── Autres montants : ajout, modification, suppression (liste renvoyée au serveur à chaque fois) ──
async function adamSaveOthers(list, okMsg, btn) {
  if (btn) btn.disabled = true;
  try {
    const updatedAt = new Date().toISOString();
    const res = await adamApi('/settings', { others: list, updatedAt });
    if (!res.banks) { toast('Mettez à jour le code du serveur Cloudflare pour enregistrer ces montants', 'err'); return false; }
    adamStore('kanga_adam_settings', JSON.stringify({ others: (res.settings || {}).others || list, updatedAt }));
    adamData = res;
    adamMergeSettings();
    adamPaint();
    toast(okMsg, 'ok');
    return true;
  } catch (err) { if (err.message !== 'refusé') toast('Erreur : ' + err.message, 'err'); return false; }
  finally { if (btn) btn.disabled = false; }
}
async function adamAddOther(e) {
  e.preventDefault();
  const label = document.getElementById('adamOtherLabel').value.trim();
  const amount = parseFloat(document.getElementById('adamOtherAmt').value);
  const op = document.getElementById('adamOtherOp').value;
  if (!label) { toast('Donnez un libellé', 'err'); return false; }
  if (!isFinite(amount)) { toast('Montant invalide', 'err'); return false; }
  let list = (((adamData || {}).settings || {}).others || []).slice();
  const editing = adamEditing && list.some(o => o.id === adamEditing);
  if (editing) list = list.map(o => o.id === adamEditing ? { ...o, label, amount, op, at: new Date().toISOString() } : o);
  else list.push({ id: genId(), label, amount, op, at: new Date().toISOString() });
  if (await adamSaveOthers(list, editing ? `« ${label} » mis à jour` : `« ${label} » ajouté`, document.getElementById('adamOtherBtn'))) adamCancelEdit();
  return false;
}
function adamEditOther(id) {
  const o = ((((adamData || {}).settings || {}).others) || []).find(x => x.id === id);
  if (!o) return;
  adamEditing = id;
  document.getElementById('adamOtherLabel').value = o.label;
  document.getElementById('adamOtherAmt').value = o.amount;
  document.getElementById('adamOtherOp').value = o.op === '+' ? '+' : '-';
  document.querySelector('#adamOtherBtn span').textContent = 'Mettre à jour';
  document.getElementById('adamOtherCancel').style.display = '';
  adamPaint();
  document.getElementById('adamOtherAmt').focus();
}
function adamCancelEdit() {
  adamEditing = null;
  document.getElementById('adamOtherLabel').value = '';
  document.getElementById('adamOtherAmt').value = '';
  document.getElementById('adamOtherOp').value = '-';
  document.querySelector('#adamOtherBtn span').textContent = 'Ajouter';
  document.getElementById('adamOtherCancel').style.display = 'none';
  if (adamData) adamPaint();
}
function adamDeleteOther(id) {
  const list = ((((adamData || {}).settings || {}).others) || []);
  const item = list.find(o => o.id === id);
  if (!item || !confirm(`Supprimer « ${item.label} » ?`)) return;
  if (adamEditing === id) adamCancelEdit();
  adamSaveOthers(list.filter(o => o.id !== id), `« ${item.label} » supprimé`);
}

// ── Messages : liaison en cours d'enregistrement, accès bientôt expirés ──
function adamMarkPending(name) { try { sessionStorage.setItem('kanga_adam_pending', JSON.stringify({ name, at: Date.now() })); } catch (e) {} }
function adamPaintNotice() {
  const d = adamData, msgs = [];
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('kanga_adam_pending') || 'null'); } catch (e) {}
  clearTimeout(adamPendingTimer);
  if (pending) {
    const linkedAfter = d.banks.some(b => b.name === pending.name && Date.parse(b.linkedAt) >= pending.at - 60000);
    if (linkedAfter || Date.now() - pending.at > 3 * 60 * 1000) { try { sessionStorage.removeItem('kanga_adam_pending'); } catch (e) {} }
    else {
      msgs.push(`<div class="adam-notice info">${svgIc('restore')}<span>Liaison de <b>${esc(pending.name)}</b> en cours d'enregistrement : elle apparaît en général en moins d'une minute. Actualisation automatique…</span></div>`);
      adamPendingTimer = setTimeout(() => adamLoad(false), 20000);
    }
  }
  const expiring = d.banks.filter(b => b.valid_until && Date.parse(b.valid_until) - Date.now() < 15 * 864e5);
  if (expiring.length) msgs.push(`<div class="adam-notice warn">${svgIc('alert')}<span>Accès à renouveler bientôt : ${expiring.map(b => `<b>${esc(b.name)}</b> (${new Date(b.valid_until).toLocaleDateString('fr-FR')})`).join(', ')}. Cliquez sur « Renouveler l'accès » sur la carte de la banque.</span></div>`);
  document.getElementById('adamNotice').innerHTML = msgs.join('');
}
function adamPaintLinks() {
  const d = adamData;
  const ll = d.lastLink;
  document.getElementById('adamLinkInfo').innerHTML = ll && !ll.ok && Date.now() - Date.parse(ll.at) < 2 * 864e5
    ? `<div class="adam-linkinfo ko"><b>Dernière liaison — ${esc(ll.aspsp)} · ${adamAgo(ll.at)}</b>
        <span>Échec (étape : ${esc(ll.step || '?')}) : ${esc(ll.error || 'erreur inconnue')}</span></div>`
    : '';
  document.getElementById('adamLinks').innerHTML = ADAM_BANKS.map(bk => {
    const linked = d.banks.some(b => b.name === bk.name);
    return `<a class="adam-link ${linked ? 'done' : ''}" href="${adamStartUrl(bk.name, bk.country)}" onclick="adamMarkPending('${esc(bk.name)}')">
      <span class="adam-logo sm" style="background:${bk.color}">${esc(bk.name.charAt(0))}</span>
      <span class="adam-link-name">${esc(bk.name)}</span>
      <small>${linked ? 'Reliée · renouveler' : 'Relier'}</small>
    </a>`;
  }).join('');
}
function adamStartUrl(name, country) {
  return `${ADAM_API}/start?aspsp=${encodeURIComponent(name)}&country=${country}&token=${encodeURIComponent(adamToken())}`;
}

// Retour depuis le site d'une banque : adresse « #espace-adam?bank=ok&msg=… »
function adamHandleReturn() {
  if (!location.hash.startsWith('#espace-adam')) return;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  history.replaceState(null, '', location.pathname + location.search);
  if (getWho() !== 'Adam') setWho('Adam');
  if (params.get('bank') === 'ok') {
    adamMarkPending(params.get('msg') || '');
    toast((params.get('msg') || 'Banque') + ' reliée', 'ok');
  } else toast('Liaison impossible : ' + (params.get('msg') || 'erreur inconnue'), 'err');
  switchTab('adam');
}

// Analyses : redessiner les graphiques à la nouvelle largeur (rotation du téléphone, fenêtre redimensionnée)
let aResizeTimer = null, aLastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === aLastWidth) return;   // sur téléphone, la barre d'adresse change seulement la hauteur
  aLastWidth = window.innerWidth;
  clearTimeout(aResizeTimer);
  aResizeTimer = setTimeout(() => { if (currentTab === 'analytics') renderAnalytics(); }, 250);
});

// Fenêtres : clic sur le fond ou touche Échap pour fermer (sauf la demande de code)
document.addEventListener('click', e => {
  const o = e.target;
  if (o.classList && o.classList.contains('modal-overlay') && o.id !== 'pinModal') o.classList.remove('open');
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay.open, .sheet-overlay.open').forEach(o => { if (o.id !== 'pinModal') o.classList.remove('open'); });
  document.getElementById('gsResults').classList.remove('show');
});

// Clic sur un nom de personne (délégation : évite d'injecter des noms dans des attributs onclick)
document.addEventListener('click', e => {
  const link = e.target.closest('.person-link');
  if (link) openPersonProfile(link.dataset.name);
});
