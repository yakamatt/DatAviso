const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1H2rBzMQzZk74Bk2Z_Mo8lXAdYea7Mi7WfzVruBahd_I/edit';

// Statistiques d'utilisation : seule la nature de l'usage part (voir STATS_CLES, background.js).
function compterUsage(cle) {
  chrome.runtime.sendMessage({ type: 'STAT', cle }, () => void chrome.runtime.lastError);
}
compterUsage('popup');

// Clausier Commun : le tableau visé est configurable (Paramètres avancés), le lien suit ce réglage.
chrome.storage.sync.get(['syncSettings'], (res) => {
  const s = res.syncSettings || {};
  document.getElementById('open-sheet-link').href = s.sheetUrl || DEFAULT_SHEET_URL;
  document.getElementById('admin-revue-tableau').href = s.sheetUrl || DEFAULT_SHEET_URL;
});

// ---------- Mode administrateur (#119) ----------
// Section affichée seulement quand le mode est actif sur ce poste. Les compteurs s'affichent
// d'abord tels que la dernière synchro les a laissés, puis sont redemandés au tableau.
function renderAdmin(etat) {
  const e = etat || { installations: 0, revue: 0 };
  const pastille = (id, n, couleur) => {
    const el = document.getElementById(id);
    el.textContent = n;
    el.className = `pastille ${n ? couleur : 'zero'}`;
  };
  pastille('admin-inst-n', e.installations, 'rouge');
  pastille('admin-revue-n', e.revue, 'jaune');
  document.getElementById('admin-inst-libelle').textContent =
    `nouvelle${e.installations > 1 ? 's' : ''} installation${e.installations > 1 ? 's' : ''}`;
  document.getElementById('admin-revue-libelle').textContent =
    `proposition${e.revue > 1 ? 's' : ''} à revoir`;
  document.getElementById('admin-inst-vu').hidden = !e.installations;
  document.getElementById('admin-revue-tableau').hidden = !e.revue;
}

chrome.storage.local.get(['adminCode', 'adminEtat'], (res) => {
  if (!res.adminCode) return;
  document.getElementById('admin').hidden = false;
  renderAdmin(res.adminEtat);
  const statut = document.getElementById('admin-status');
  chrome.runtime.sendMessage({ type: 'ADMIN', demande: 'etat' }, (rep) => {
    if (chrome.runtime.lastError) return;
    if (rep && rep.ok) { renderAdmin(rep.etat); statut.textContent = ''; }
    else statut.textContent = `⚠️ ${(rep && rep.error) || 'Tableau injoignable'}`;
  });
});

document.getElementById('admin-inst-vu').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ADMIN', demande: 'installations-vues' }, () => {
    void chrome.runtime.lastError;
    chrome.storage.local.get(['adminEtat'], (r) => renderAdmin(r.adminEtat));
  });
  compterUsage('admin_installations_vues');
});

document.getElementById('admin-revue-tableau').addEventListener('click', () => {
  compterUsage('admin_revue_tableau');
});

document.getElementById('admin-stats').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('statistiques.html') });
  window.close();
});

// Clausier Personnel : géré dans la page Paramètres, ouverte directement sur sa section.
// chrome.runtime.openOptionsPage() ne transmet pas d'ancre, d'où l'ouverture par URL.
document.getElementById('open-clausier').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#clausier') });
  window.close();
});

// ---------- DatAviso AI : import des données de dossier ----------
// Chaque import REMPLACE entièrement les données précédentes : le fichier importé fait foi, ce
// qui évite de laisser traîner des articles d'un dossier précédent qui réapparaîtraient dans Aviso.

const importStatusEl = document.getElementById('import-status');
const importCountEl = document.getElementById('import-count');

function renderImportCount() {
  chrome.storage.local.get(['importedArticles', 'importedMeta'], (res) => {
    const articles = res.importedArticles || [];
    document.getElementById('import-clear').hidden = !articles.length;
    if (!articles.length) {
      importCountEl.textContent = 'Aucune donnée DatAviso AI pour le moment.';
      return;
    }
    const meta = res.importedMeta || {};
    const quand = meta.importedAt ? new Date(meta.importedAt).toLocaleDateString() : '';
    const source = meta.source ? ` depuis ${meta.source}` : '';
    importCountEl.textContent =
      `${articles.length} article${articles.length > 1 ? 's' : ''} importé${articles.length > 1 ? 's' : ''}` +
      (quand ? ` le ${quand}${source}` : '') + '.';
  });
}

function runImport(text, source) {
  const articles = parseImportedData(text);
  if (!articles.length) {
    importStatusEl.textContent = '❌ Aucun article détecté. Chaque bloc doit commencer par une ligne du type "GN 12 — Titre".';
    return;
  }
  chrome.storage.local.set({
    importedArticles: articles,
    importedMeta: { importedAt: new Date().toISOString(), source, count: articles.length }
  }, () => {
    const codes = articles.slice(0, 3).map(a => a.code).join(', ');
    importStatusEl.textContent =
      `✅ ${articles.length} article${articles.length > 1 ? 's' : ''} importé${articles.length > 1 ? 's' : ''} (${codes}${articles.length > 3 ? '…' : ''}).`;
    renderImportCount();
  });
}

// Effacement complet, confirmé : les données DatAviso AI ne se retrouvent pas d'un clic, il faut
// réimporter le fichier source.
document.getElementById('import-clear').addEventListener('click', () => {
  chrome.storage.local.get(['importedArticles'], (res) => {
    const nb = (res.importedArticles || []).length;
    if (!nb) return;
    if (!confirm(`Effacer les ${nb} article${nb > 1 ? 's' : ''} DatAviso AI ?`)) return;
    chrome.storage.local.set({ importedArticles: [], importedMeta: null }, () => {
      importStatusEl.textContent = '🗑️ Données DatAviso AI effacées.';
      renderImportCount();
    });
  });
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => runImport(String(reader.result), file.name);
  reader.onerror = () => { importStatusEl.textContent = '❌ Lecture du fichier impossible.'; };
  reader.readAsText(file, 'utf-8');
  e.target.value = ''; // permet de réimporter le même fichier après correction
});

renderImportCount();

// ---------- Partage ----------
// Lien de partage : partage.js.
brancherPartage(
  document.getElementById('share-copy'),
  document.getElementById('share-mail'),
  document.getElementById('share-status')
);

document.getElementById('open-tutoriel').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('tutoriel.html') });
  window.close();
});

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});
