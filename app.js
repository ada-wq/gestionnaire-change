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
    euroTransactions: euroT, cfaTransactions: cfaT, notes: notes, holdings: holdings
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
  notes:     ['Notes', 'Notes partagées']
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
  const total = eS + cS / customRate + holdingsTotalEUR();

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
  updatePageHeader();
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

function updateMonthSelector() {
  const all = [...euroT,...cfaT].map(t=>t.date.slice(0,7));
  const months = [...new Set(all)].sort().reverse();
  const sel = document.getElementById('aMonth');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tous</option>';
  months.forEach(m => {
    const [y,mo] = m.split('-');
    sel.innerHTML += `<option value="${m}" ${m===cur?'selected':''}>${new Date(y,mo-1,1).toLocaleDateString('fr-FR',{month:'long',year:'numeric'})}</option>`;
  });
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
function renderAnalytics() {
  const type  = document.getElementById('aType').value;
  const month = document.getElementById('aMonth').value;
  const arr   = type==='euro' ? euroT : cfaT;
  const isE   = type==='euro';
  const fmt   = n => isE ? fmtEuro(n) : fmtCFA(n);
  const data  = month ? arr.filter(t=>t.date.startsWith(month)) : arr;

  const totIn  = data.reduce((s,t)=>s+t.entree,0);
  const totOut = data.reduce((s,t)=>s+t.sortie,0);
  const net    = totIn - totOut;
  const txIn   = data.filter(t=>t.entree>0).length;
  const txOut  = data.filter(t=>t.sortie>0).length;
  const avg    = data.length ? (totIn+totOut)/data.length : 0;

  // Delta vs mois précédent (si un mois est sélectionné)
  let deltaHTML = '';
  if (month) {
    const [y,m] = month.split('-').map(Number);
    const prev = new Date(y, m-2, 1);
    const prevKey = prev.getFullYear() + '-' + String(prev.getMonth()+1).padStart(2,'0');
    const pData = arr.filter(t=>t.date.startsWith(prevKey));
    const pNet = pData.reduce((s,t)=>s+t.entree-t.sortie,0);
    if (pData.length) {
      const diff = net - pNet;
      deltaHTML = `<span class="${diff>=0?'delta-up':'delta-down'}">${diff>=0?'▲':'▼'} ${fmt(Math.abs(diff))}</span> vs mois précédent`;
    }
  }

  document.getElementById('aKpis').innerHTML = `
    <div class="kpi kpi-green" style="padding:16px 18px;">
      <div class="kpi-label">Total Entrées</div>
      <div class="kpi-value" style="font-size:1.25rem;">${fmt(totIn)}</div>
      <div class="kpi-sub">${txIn} transactions</div>
    </div>
    <div class="kpi kpi-red" style="padding:16px 18px;">
      <div class="kpi-label">Total Sorties</div>
      <div class="kpi-value" style="font-size:1.25rem;">${fmt(totOut)}</div>
      <div class="kpi-sub">${txOut} transactions</div>
    </div>
    <div class="kpi ${net>=0?'kpi-green':'kpi-red'}" style="padding:16px 18px;">
      <div class="kpi-label">Variation nette</div>
      <div class="kpi-value" style="font-size:1.25rem;">${net>=0?'+':''}${fmt(net)}</div>
      <div class="kpi-sub">${deltaHTML || data.length + ' transactions'}</div>
    </div>
    <div class="kpi kpi-gold" style="padding:16px 18px;">
      <div class="kpi-label">Moyenne / transaction</div>
      <div class="kpi-value" style="font-size:1.25rem;">${fmt(avg)}</div>
      <div class="kpi-sub">${[...new Set(data.map(t=>t.personne))].length} personnes</div>
    </div>`;

  // Donut entrées / sorties
  document.getElementById('aDonut').innerHTML = donutSVG([
    {label:'Entrées', value:totIn, color:'var(--green)', text:fmt(totIn)},
    {label:'Sorties', value:totOut, color:'var(--red)', text:fmt(totOut)}
  ], data.length + ' tx', month ? 'sur le mois' : 'toute période');

  // Répartition par catégorie (montants totaux)
  const byCat = {};
  data.forEach(t => { const c = t.categorie || 'Sans catégorie'; byCat[c] = (byCat[c]||0) + t.entree + t.sortie; });
  const cats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxCat = cats[0]?.[1] || 1;
  document.getElementById('chartCat').innerHTML = cats.length ? cats.map(([n,v]) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(n)}">${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v/maxCat*100).toFixed(1)}%;background:var(--gold);"></div></div>
      <div class="bar-val" style="color:var(--gold);">${fmt(v)}</div>
    </div>`).join('')
    : '<div style="color:var(--text3);font-size:.8rem;padding:12px;">Aucune donnée</div>';

  // Top personnes — entrées
  const byPIn = {};
  data.forEach(t => { if (t.entree>0) byPIn[t.personne] = (byPIn[t.personne]||0) + t.entree; });
  const topIn = Object.entries(byPIn).sort((a,b)=>b[1]-a[1]).slice(0,7);
  const maxIn = topIn[0]?.[1] || 1;
  document.getElementById('chartPersonIn').innerHTML = topIn.length ? topIn.map(([n,v]) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(n)}">${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v/maxIn*100).toFixed(1)}%;background:var(--green);"></div></div>
      <div class="bar-val" style="color:var(--green);">${fmt(v)}</div>
    </div>`).join('')
    : '<div style="color:var(--text3);font-size:.8rem;padding:12px;">Aucune donnée</div>';

  // Top personnes — sorties
  const byPOut = {};
  data.forEach(t => { if (t.sortie>0) byPOut[t.personne] = (byPOut[t.personne]||0) + t.sortie; });
  const topOut = Object.entries(byPOut).sort((a,b)=>b[1]-a[1]).slice(0,7);
  const maxOut = topOut[0]?.[1] || 1;
  document.getElementById('chartPersonOut').innerHTML = topOut.length ? topOut.map(([n,v]) => `
    <div class="bar-row">
      <div class="bar-label" title="${esc(n)}">${esc(n)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v/maxOut*100).toFixed(1)}%;background:var(--red);"></div></div>
      <div class="bar-val" style="color:var(--red);">${fmt(v)}</div>
    </div>`).join('')
    : '<div style="color:var(--text3);font-size:.8rem;padding:12px;">Aucune donnée</div>';

  // Tendance mensuelle SVG
  const byMonth = {};
  arr.forEach(t => {
    const m = t.date.slice(0,7);
    if (!byMonth[m]) byMonth[m]={in:0,out:0};
    byMonth[m].in += t.entree; byMonth[m].out += t.sortie;
  });
  const monthKeys = Object.keys(byMonth).sort();
  if (monthKeys.length > 1) {
    const W=700, H=190, PAD=42;
    const allV = monthKeys.flatMap(k=>[byMonth[k].in, byMonth[k].out]);
    const vMax = Math.max(...allV,1);
    const x = i => PAD + i*(W-PAD*2)/(monthKeys.length-1);
    const y = v => H - PAD - (v/vMax)*(H-PAD*2);
    const path = (key,col) => {
      const d = monthKeys.map((m,i)=>(i?'L':'M')+x(i)+' '+y(byMonth[m][key])).join(' ');
      return `<path d="${d}" stroke="${col}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    };
    const area = (key,col) => {
      const d = monthKeys.map((m,i)=>(i?'L':'M')+x(i)+' '+y(byMonth[m][key])).join(' ')
        + ` L ${x(monthKeys.length-1)} ${H-PAD} L ${x(0)} ${H-PAD} Z`;
      return `<path d="${d}" fill="${col}" opacity="0.08"/>`;
    };
    const dots = (key,col) => monthKeys.map((m,i)=>
      `<circle cx="${x(i)}" cy="${y(byMonth[m][key])}" r="4" fill="${col}" stroke="var(--surface-solid)" stroke-width="2">
        <title>${m}: ${fmt(byMonth[m][key])}</title></circle>`).join('');
    const labels = monthKeys.map((m,i)=>{
      const [yr,mo]=m.split('-');
      const short = new Date(yr,mo-1,1).toLocaleDateString('fr-FR',{month:'short'});
      return `<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--text3)">${short}</text>`;
    }).join('');
    document.getElementById('trendChart').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg">
        ${area('in','var(--green)')} ${area('out','var(--red)')}
        ${path('in','var(--green)')} ${path('out','var(--red)')}
        ${dots('in','var(--green)')} ${dots('out','var(--red)')}
        ${labels}
        <text x="8" y="20" font-size="10" fill="var(--green)" font-weight="600">▬ Entrées</text>
        <text x="80" y="20" font-size="10" fill="var(--red)" font-weight="600">▬ Sorties</text>
      </svg>`;
  } else {
    document.getElementById('trendChart').innerHTML = '<div style="color:var(--text3);font-size:.8rem;padding:12px 0;">Pas assez de données pour afficher la tendance (au moins 2 mois requis).</div>';
  }

  // Tableau mensuel avec évolution
  const mb = document.getElementById('monthBody');
  mb.innerHTML = '';
  const sortedM = Object.keys(byMonth).sort();
  sortedM.slice().reverse().forEach(m => {
    const d = byMonth[m]; const net2 = d.in - d.out;
    const [y2,mo2] = m.split('-');
    const label = new Date(y2,mo2-1,1).toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
    const idx = sortedM.indexOf(m);
    let evo = '—';
    if (idx > 0) {
      const p = byMonth[sortedM[idx-1]];
      const pNet = p.in - p.out;
      const diff = net2 - pNet;
      evo = `<span class="${diff>=0?'val-pos':'val-neg'}">${diff>=0?'▲ +':'▼ '}${fmt(diff)}</span>`;
    }
    const txM = arr.filter(t=>t.date.startsWith(m)).length;
    mb.innerHTML += `<tr>
      <td>${label}</td><td class="num">${txM}</td>
      <td class="val-in">${fmt(d.in)}</td>
      <td class="val-out">${fmt(d.out)}</td>
      <td class="${net2>=0?'val-pos':'val-neg'}">${net2>=0?'+':''}${fmt(net2)}</td>
      <td>${evo}</td>
    </tr>`;
  });

  // Tableau personnes
  const bp = {};
  data.forEach(t => {
    if (!bp[t.personne]) bp[t.personne]={in:0,out:0,count:0};
    bp[t.personne].in += t.entree; bp[t.personne].out += t.sortie; bp[t.personne].count++;
  });
  const totAll = totIn + totOut || 1;
  const pb = document.getElementById('personBody');
  pb.innerHTML = '';
  Object.entries(bp).sort((a,b)=>b[1].count-a[1].count).forEach(([name,d]) => {
    const net3 = d.in - d.out;
    const pct = (((d.in+d.out)/totAll)*100).toFixed(1);
    pb.innerHTML += `<tr>
      <td>${esc(name)}</td><td class="num">${d.count}</td>
      <td class="val-in">${fmt(d.in)}</td>
      <td class="val-out">${fmt(d.out)}</td>
      <td class="${net3>=0?'val-pos':'val-neg'}">${net3>=0?'+':''}${fmt(net3)}</td>
      <td style="color:var(--text2);" class="num">${pct}%</td>
    </tr>`;
  });
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
  const blob = new Blob([JSON.stringify({euroTransactions:euroT,cfaTransactions:cfaT,notes,holdings,exportDate:new Date().toISOString()},null,2)],{type:'application/json'});
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

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('eDate').value = today;
  document.getElementById('cDate').value = today;

  listen();
  listenTrash();

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
  return `<tr>${chk}
    <td class="c-date">${t.date}${late ? ` <span class="badge badge-suivi-late" title="En cours depuis ${age} jours">${svgIc('alert')}${age} j</span>` : ''}</td>
    <td class="c-cur"><span class="badge ${t.cur==='euro'?'badge-euro':'badge-cfa'}">${t.cur==='euro'?'EUR':'CFA'}</span></td>
    <td class="c-op"><span class="badge ${t.operation==='Entrée'?'badge-in':'badge-out'}">${t.operation}</span></td>
    <td class="c-amt ${t.entree>0?'val-in':'val-out'}">${t.entree>0?'+':'−'}${fmt(amt)}</td>
    <td class="c-person"><span class="person-link" data-name="${esc(t.personne)}">${esc(t.personne)}</span></td>
    <td class="c-who${t.contrepartie ? '' : ' is-empty'}">${t.contrepartie ? `<span class="badge badge-cat">${svgIc('user')}${esc(t.contrepartie)}</span>` : '—'}</td>
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
    : '<tr><td colspan="9" class="empty">Aucune transaction en cours</td></tr>';
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

// ── Qui utilise l'appareil + journal des modifications ──
function getWho() { try { return localStorage.getItem('kanga_who') || ''; } catch (e) { return ''; } }
function setWho(v) {
  try { localStorage.setItem('kanga_who', v); } catch (e) {}
  ['whoAmI', 'whoAmI2'].forEach(id => { const s = document.getElementById(id); if (s) s.value = v; });
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
  try { localStorage.setItem('kanga_cache', JSON.stringify({ ts: Date.now(), euroT, cfaT, holdings, notes })); } catch (e) {}
}
function hydrateFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem('kanga_cache') || 'null');
    if (!c) return;
    euroT = toArr(c.euroT); cfaT = toArr(c.cfaT); holdings = toArr(c.holdings); notes = toArr(c.notes);
    document.getElementById('euroLoading').style.display = 'none';
    document.getElementById('cfaLoading').style.display = 'none';
    updateAll(); renderHoldings(); renderNotesList();
  } catch (e) {}
}

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

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
