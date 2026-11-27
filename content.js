// content.js — détecte et remplace les snippets, avec temporisation et mise en forme

// Deux sources coexistent : le Clausier Commun (snippets du Google Sheets, en lecture seule) et
// le Clausier Personnel (snippets locaux, propres à ce navigateur). ACTIVE_SNIPPETS est la
// fusion utilisée par l'expansion au clavier, où le snippet local l'emporte à déclencheur égal.
let SNIPPETS = [];
let LOCAL_SNIPPETS = [];
let ACTIVE_SNIPPETS = [];
let IMPORTED_ARTICLES = [];
let MAX_TRIGGER_LEN = 1;
let EXPANSION_DELAY_MS = 1000;
// Liens SGO / SharePoint / Explorateur posés sur les affaires dans Aviso, un réglage par lien
// (Paramètres avancés). Actifs par défaut : un réglage absent vaut "activé".
let LIENS_AFFAIRE = { sgo: true, sharepoint: true, explorateur: true };
// Menus d'avis et de conformité d'Aviso (Paramètres avancés > Boutons d'avis) : remplacés par des
// boutons, le menu étant alors masqué (par défaut), ou laissés d'origine, sans bouton. Deux choix
// exclusifs : un menu n'est jamais masqué sans boutons pour le remplacer.
let BOUTONS_AVIS = true;
// Sources réglementaires (Paramètres avancés) : pour chaque trame, sitesecurite.com et Légifrance
// se règlent séparément, tous actifs par défaut (HAND : Légifrance seul). Clés source<Trame><Source> (sourceErpLegifrance…),
// lues par sourcesReglementaires() — même lecture dans options.js.
// HAND n'a que Légifrance (l'arrêté du 20 avril 2017 n'est pas sur sitesecurite), de même que
// l'accessibilité des logements neufs (HandHab) et des lieux de travail (HandTravail).
const SOURCES_PAR_TRAME = {
  Erp: ['Sitesecurite', 'Legifrance'],
  Hab: ['Sitesecurite', 'Legifrance'],
  BupIncendie: ['Sitesecurite', 'Legifrance'],
  BupAcces: ['Sitesecurite', 'Legifrance'],
  Hand: ['Legifrance'],
  HandHab: ['Legifrance'],
  HandTravail: ['Legifrance'],
};
let SOURCES_REGLEMENTAIRES = sourcesReglementaires({});
let pendingTimeoutId = null;

// Déclarés avant loadSnippets() car référencés depuis son callback : chrome.storage est
// documenté comme toujours asynchrone, mais ces déclarations restent en TDZ tant que le script
// ne les a pas atteintes — les placer ici évite toute fragilité d'ordre d'exécution.
const AVISO_HOSTNAME = 'aviso2.bureauveritas.com';
const AVISO_ICON_CLASS = 'snippet-expander-aviso-icon';
// Liens réglementaires : deux icônes, une par source, côte à côte.
const AVISO_SITESECURITE_CLASS = 'snippet-expander-aviso-sitesecurite';
const AVISO_LEGIFRANCE_CLASS = 'snippet-expander-aviso-legifrance';
const AVISO_IMPORT_CLASS = 'snippet-expander-aviso-import';
const AVISO_ADD_CLASS = 'snippet-expander-aviso-add';
const AVISO_LOCAL_CLASS = 'snippet-expander-aviso-local';
const AVISO_EDIT_CLASS = 'snippet-expander-aviso-edit';
// Hors de AVISO_ORDER : la corbeille flotte au bord droit de la cellule, à l'écart de la rangée.
const AVISO_CLEAR_CLASS = 'snippet-expander-aviso-clear';
// Groupe de liens SGO / SharePoint / Explorateur d'une affaire (liste Plans Affaires, barre bleue).
const AVISO_LIENS_CLASS = 'snippet-expander-liens-affaire';
// Rangée de boutons d'avis, au-dessus du menu déroulant d'avis (hors de AVISO_ORDER).
const AVISO_AVIS_CLASS = 'snippet-expander-aviso-avis';

// Ordre d'affichage des icônes, de gauche à droite. Le "+" et l'icône jaune occupent la même
// place et ne coexistent jamais : le "+" n'apparaît que sur une ligne sans snippet local.
const AVISO_ORDER = [
  AVISO_ADD_CLASS, AVISO_LOCAL_CLASS, AVISO_EDIT_CLASS,
  AVISO_ICON_CLASS, AVISO_SITESECURITE_CLASS, AVISO_LEGIFRANCE_CLASS, AVISO_IMPORT_CLASS
];

function isAvisoSite() {
  return location.hostname === AVISO_HOSTNAME;
}

// Le snippet local masque, pour l'expansion au clavier, le snippet du Google Sheets de même
// déclencheur. Sans ce filtre, findMatch départagerait deux déclencheurs identiques à la
// longueur, donc arbitrairement.
function rebuildActiveSnippets() {
  const locaux = new Set(LOCAL_SNIPPETS.map(s => s.trigger));
  ACTIVE_SNIPPETS = LOCAL_SNIPPETS.concat(SNIPPETS.filter(s => !locaux.has(s.trigger)));
  MAX_TRIGGER_LEN = ACTIVE_SNIPPETS.reduce((m, s) => Math.max(m, s.trigger.length), 1);
}

function loadSnippets() {
  chrome.storage.local.get(['snippets', 'localSnippets', 'importedArticles'], (res) => {
    SNIPPETS = res.snippets || [];
    LOCAL_SNIPPETS = res.localSnippets || [];
    IMPORTED_ARTICLES = res.importedArticles || [];
    rebuildActiveSnippets();
    if (isAvisoSite()) scheduleAvisoScan();
    // Les icônes des champs retenus n'affichent que des snippets personnels existants : le premier
    // scan a pu passer avant cette lecture.
    scheduleScanChamps();
  });
}
// Applique les réglages ; renvoie les classes des éléments Aviso dont le réglage a changé, pour
// que l'appelant retire ceux déjà affichés (le scan suivant repose ce qui reste activé).
function appliquerReglages(s) {
  EXPANSION_DELAY_MS = Number.isFinite(s.expansionDelayMs) ? s.expansionDelayMs : 1000;
  const aRetirer = [];
  const avant = JSON.stringify(LIENS_AFFAIRE);
  LIENS_AFFAIRE = {
    sgo: s.lienSgo !== false,
    sharepoint: s.lienSharepoint !== false,
    explorateur: s.lienExplorateur !== false
  };
  if (JSON.stringify(LIENS_AFFAIRE) !== avant) aRetirer.push(AVISO_LIENS_CLASS);
  const avantSources = JSON.stringify(SOURCES_REGLEMENTAIRES);
  SOURCES_REGLEMENTAIRES = sourcesReglementaires(s);
  if (JSON.stringify(SOURCES_REGLEMENTAIRES) !== avantSources) {
    aRetirer.push(AVISO_SITESECURITE_CLASS, AVISO_LEGIFRANCE_CLASS);
  }
  const boutonsAvis = modeAvis(s) === 'boutons';
  if (boutonsAvis !== BOUTONS_AVIS) aRetirer.push(AVISO_AVIS_CLASS);
  BOUTONS_AVIS = boutonsAvis;
  return aRetirer;
}

// 'boutons' (par défaut) ou 'menu'. Avant la v2.32.0, deux cases : qui avait décoché « Afficher
// les boutons d'avis » (boutonsAvis: false) retrouve le menu d'origine. Même règle dans options.js.
function modeAvis(s) {
  if (s.modeAvis === 'boutons' || s.modeAvis === 'menu') return s.modeAvis;
  return s.boutonsAvis === false ? 'menu' : 'boutons';
}

// { ErpSitesecurite: true, ErpLegifrance: true, … } : un réglage absent vaut "activé".
function sourcesReglementaires(s) {
  const sources = {};
  for (const [trame, noms] of Object.entries(SOURCES_PAR_TRAME)) {
    for (const source of noms) {
      sources[trame + source] = s['source' + trame + source] !== false;
    }
  }
  return sources;
}

function reglagesModifies(s) {
  const aRetirer = appliquerReglages(s || {});
  if (!aRetirer.length || !isAvisoSite()) return;
  // Les menus masqués réapparaissent d'abord ; le scan qui suit remasque ceux qui doivent l'être.
  if (aRetirer.includes(AVISO_AVIS_CLASS)) {
    reafficherMenusAvis();
  }
  retirerIconesAviso(aRetirer);
}

function loadSettings() {
  chrome.storage.sync.get(['syncSettings'], (res) => reglagesModifies(res.syncSettings));
}
loadSnippets();
loadSettings();

// Les icônes Aviso capturent leur snippet au moment de leur pose : quand une source change, les
// icônes qui en dépendent sont retirées, puis le scan les repose d'après les nouvelles données.
function retirerIconesAviso(classes) {
  document.querySelectorAll(classes.map(c => '.' + c).join(', ')).forEach(el => el.remove());
  scheduleAvisoScan();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.snippets) {
    SNIPPETS = changes.snippets.newValue || [];
    rebuildActiveSnippets();
    if (isAvisoSite()) retirerIconesAviso([AVISO_ICON_CLASS]);
  }
  // Un snippet local créé, modifié ou supprimé (fenêtre d'édition, page Paramètres) : le "+",
  // l'icône jaune et le crayon dépendent tous trois de son existence.
  if (area === 'local' && changes.localSnippets) {
    LOCAL_SNIPPETS = changes.localSnippets.newValue || [];
    rebuildActiveSnippets();
    if (isAvisoSite()) retirerIconesAviso([AVISO_ADD_CLASS, AVISO_LOCAL_CLASS, AVISO_EDIT_CLASS]);
  }
  // Un import depuis le popup doit se voir tout de suite sur l'onglet Aviso déjà ouvert.
  if (area === 'local' && changes.importedArticles) {
    IMPORTED_ARTICLES = changes.importedArticles.newValue || [];
    if (isAvisoSite()) retirerIconesAviso([AVISO_IMPORT_CLASS]);
  }
  if (area === 'sync' && changes.syncSettings) {
    reglagesModifies(changes.syncSettings.newValue);
  }
});

// Statistiques d'utilisation : signale au service worker qu'une fonction a servi. Seule la nature
// de l'usage part (voir STATS_CLES dans background.js), jamais le texte, la page ni le snippet.
// Après une mise à jour de l'extension, l'ancien script de contenu n'a plus de service worker à
// qui parler : l'appel échoue, on l'ignore.
function compterUsage(cle) {
  try {
    chrome.runtime.sendMessage({ type: 'STAT', cle }, () => void chrome.runtime.lastError);
  } catch { /* contexte de l'extension invalidé */ }
}

function compterExpansion(match) {
  compterUsage(LOCAL_SNIPPETS.includes(match) ? 'clavier_perso' : 'clavier_commun');
  if (!isAvisoSite()) compterUsage('clavier_hors_aviso');
}

function resolveContent(text) {
  const now = new Date();
  return text
    .replace(/\{date\}/gi, now.toLocaleDateString())
    .replace(/\{time\}/gi, now.toLocaleTimeString())
    .replace(/\{cursor\}/gi, '');
}

function findCursorOffset(rawText) {
  return rawText.search(/\{cursor\}/i);
}

function findMatch(before) {
  return ACTIVE_SNIPPETS
    .slice()
    .sort((a, b) => b.trigger.length - a.trigger.length)
    .find(s => before.endsWith(s.trigger));
}

function setNativeValue(element, value) {
  const proto = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(element, value);
  else element.value = value;
}

// ---------- INPUT / TEXTAREA ----------

function doExpandInInput(el, match) {
  const start = el.selectionStart;
  if (start == null) return;
  const value = el.value;
  const before = value.substring(Math.max(0, start - MAX_TRIGGER_LEN), start);
  if (!before.endsWith(match.trigger)) return; // le contexte a changé entre-temps, on annule

  const cursorMarker = findCursorOffset(match.content);
  const replacement = resolveContent(match.content); // \n est préservé nativement dans <textarea>
  const triggerStart = start - match.trigger.length;
  const newValue = value.substring(0, triggerStart) + replacement + value.substring(start);

  setNativeValue(el, newValue);

  let newPos;
  if (cursorMarker >= 0) {
    const beforeCursor = resolveContent(match.content.substring(0, cursorMarker));
    newPos = triggerStart + beforeCursor.length;
  } else {
    newPos = triggerStart + replacement.length;
  }
  el.setSelectionRange(newPos, newPos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  compterExpansion(match);
}

function tryExpandInInput(el) {
  const start = el.selectionStart;
  if (start == null || start === 0) return;
  const value = el.value;
  const windowStart = Math.max(0, start - MAX_TRIGGER_LEN);
  const before = value.substring(windowStart, start);
  const match = findMatch(before);
  if (!match) return;
  scheduleExpansion(() => doExpandInInput(el, match));
}

// ---------- CONTENTEDITABLE (respecte les sauts de ligne avec <br>) ----------

// doc : le document du champ. Celui de la page, ou celui de l'iframe d'un éditeur riche
// (TinyMCE sur Aviso), dans laquelle ce script ne tourne pas (voir lierEditeursRiches).
function doExpandInContentEditable(match, doc = document) {
  const sel = doc.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;

  const offset = range.startOffset;
  const text = node.textContent;
  const windowStart = Math.max(0, offset - MAX_TRIGGER_LEN);
  const before = text.substring(windowStart, offset);
  if (!before.endsWith(match.trigger)) return; // contexte changé, on annule

  const cursorMarker = findCursorOffset(match.content);
  const replacement = resolveContent(match.content);
  const triggerStart = offset - match.trigger.length;

  const afterText = text.substring(offset);
  const beforeText = text.substring(0, triggerStart);

  const frag = doc.createDocumentFragment();
  const lines = replacement.split('\n');
  let cursorNode = null, cursorOffsetInNode = 0;
  let consumed = 0;
  lines.forEach((line, idx) => {
    const textNode = doc.createTextNode(line);
    frag.appendChild(textNode);
    if (cursorMarker >= 0 && cursorNode === null) {
      const lineEndInResolved = consumed + line.length;
      if (cursorMarker <= lineEndInResolved + idx) {
        cursorNode = textNode;
        cursorOffsetInNode = Math.max(0, Math.min(line.length, cursorMarker - consumed - idx));
      }
    }
    consumed += line.length;
    if (idx < lines.length - 1) {
      frag.appendChild(doc.createElement('br'));
    }
  });

  node.textContent = beforeText;
  const afterNode = doc.createTextNode(afterText);
  const parent = node.parentNode;
  const nextSibling = node.nextSibling;
  parent.insertBefore(frag, nextSibling);
  parent.insertBefore(afterNode, nextSibling);

  const newRange = doc.createRange();
  if (cursorNode) {
    newRange.setStart(cursorNode, cursorOffsetInNode);
  } else {
    newRange.setStartBefore(afterNode);
  }
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
  // Prévient l'éditeur (TinyMCE, etc.) que le contenu a changé, comme pour un champ texte.
  const racine = parent.nodeType === Node.ELEMENT_NODE ? parent.closest('[contenteditable]') || parent : null;
  if (racine) racine.dispatchEvent(new Event('input', { bubbles: true }));
  compterExpansion(match);
}

function tryExpandInContentEditable(doc = document) {
  const sel = doc.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;

  const offset = range.startOffset;
  const text = node.textContent;
  const windowStart = Math.max(0, offset - MAX_TRIGGER_LEN);
  const before = text.substring(windowStart, offset);
  const match = findMatch(before);
  if (!match) return;
  scheduleExpansion(() => doExpandInContentEditable(match, doc));
}

// ---------- Temporisation ----------
// Attend que l'utilisateur arrête de taper pendant EXPANSION_DELAY_MS avant de déclencher
// l'expansion. Si la frappe continue et invalide le match entre-temps, l'expansion est
// automatiquement annulée (doExpand* revérifie le contexte juste avant d'agir).

function scheduleExpansion(fn) {
  if (pendingTimeoutId) clearTimeout(pendingTimeoutId);
  if (EXPANSION_DELAY_MS <= 0) {
    fn();
    return;
  }
  pendingTimeoutId = setTimeout(() => {
    pendingTimeoutId = null;
    fn();
  }, EXPANSION_DELAY_MS);
}

function surSaisie(e, doc) {
  if (!ACTIVE_SNIPPETS.length) return;
  const el = e.target;

  if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url)$/i.test(el.type)))) {
    tryExpandInInput(el);
  } else if (el && el.isContentEditable) {
    tryExpandInContentEditable(doc);
  }
}

document.addEventListener('input', (e) => surSaisie(e, document), true);

// ---------- Éditeurs riches dans une iframe vide (TinyMCE) ----------
// Le champ « Remarque » d'Aviso est un éditeur TinyMCE : un <body contenteditable> dans une
// iframe sans src (about:blank). Chrome n'y injecte pas ce script (pas de match_about_blank),
// la frappe n'y atteint donc pas le listener ci-dessus. La page parente, de même origine, peut
// en revanche écouter ce document : on y branche le même listener.
//
// Plutôt que match_about_blank : TinyMCE remplit son iframe par document.write, qui efface les
// listeners du document : on retient le <body> vu au branchement (une réécriture le remplace) et
// le branchement est refait à chaque occasion : scan Aviso, survol de l'iframe, focus qui y entre.
// L'ancien listener est retiré avant d'en poser un nouveau, pour ne jamais en avoir deux.
// Les iframes à src, où ce script tourne déjà (all_frames), sont ignorées : sinon double expansion.
// (srcdoc non plus n'est pas injecté : l'attribut src est alors absent, l'iframe est donc liée.)
const editeursLies = new WeakMap(); // document de l'iframe -> { body, ecouteur }

function lierEditeurRiche(iframe) {
  // Sans src (ou about:, javascript:), Chrome n'injecte pas ce script dans l'iframe. On teste
  // l'attribut et non l'URL du document : après document.write, celle-ci devient celle de la
  // page parente.
  const src = (iframe.getAttribute('src') || '').trim();
  if (src && !/^(about|javascript):/i.test(src)) return;
  let doc;
  try {
    doc = iframe.contentDocument; // null si l'iframe est d'une autre origine
  } catch {
    return;
  }
  if (!doc || !doc.body) return;
  const lie = editeursLies.get(doc);
  if (lie && lie.body === doc.body) return;
  if (lie) doc.removeEventListener('input', lie.ecouteur, true);
  const ecouteur = (e) => surSaisie(e, doc);
  doc.addEventListener('input', ecouteur, true);
  editeursLies.set(doc, { body: doc.body, ecouteur });
}

function lierEditeursRiches(racine = document) {
  racine.querySelectorAll('iframe').forEach(lierEditeurRiche);
}

if (isAvisoSite()) {
  document.addEventListener('mouseover', (e) => {
    if (e.target && e.target.tagName === 'IFRAME') lierEditeurRiche(e.target);
  }, true);
  // Le focus qui passe dans une iframe fait perdre le focus à la fenêtre parente ; l'iframe est
  // alors l'élément actif (navigation au clavier, focus posé par Aviso à l'ouverture).
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const actif = document.activeElement;
      if (actif && actif.tagName === 'IFRAME') lierEditeurRiche(actif);
    }, 0);
  });
}

// ---------- Intégration Aviso ----------
// Sur les tableaux de saisie de rapport (colonnes "Référentiel" / "Dispositions réalisées"),
// affiche une icône à côté de "Dispositions réalisées" quand le code du Référentiel (la partie
// avant le premier " - ", ex: "GN 4" dans "GN 4 - Procédure d'adaptation...") correspond au
// déclencheur d'un snippet. Un clic AJOUTE le contenu du snippet à la suite du texte déjà
// présent (jamais d'écrasement). Limité à ce site : aucun effet sur les autres pages visitées.
// (AVISO_HOSTNAME, AVISO_ICON_CLASS et isAvisoSite() sont déclarés en haut du fichier.)

function normalizeRefCode(str) {
  return String(str || '').replace(/\s+/g, '').toUpperCase();
}

// Un code d'article : une à quatre lettres, un numéro, éventuellement un suffixe ("CO 24",
// "CH 12-1"). Ce qui n'y ressemble pas est un libellé de rubrique, pas un code.
const REF_CODE_RE = /^[A-Za-z]{1,4}\s*\d+(?:-\d+)?$/;

// "GN 4 - Procédure d'adaptation..." -> "GN4"
// "Dallage - Exigences d'utilisation et conception" -> le libellé entier : les référentiels
// solidité n'ont pas de code, et deux rubriques d'un même groupe ("Dallage - données relatives
// au sol support") se confondraient si l'on coupait au premier " - ".
function extractRefCode(referentielText) {
  const text = String(referentielText || '').trim();
  const sepIndex = text.indexOf(' - ');
  if (sepIndex < 0) return normalizeRefCode(text);
  const prefixe = text.slice(0, sepIndex).trim();
  return normalizeRefCode(REF_CODE_RE.test(prefixe) ? prefixe : text);
}

// "/GN4" -> "GN4" (retire un préfixe usuel de déclencheur avant comparaison)
function triggerToRefCode(trigger) {
  return normalizeRefCode(String(trigger || '').replace(/^[/;:!]+/, ''));
}

function escapeHtmlAviso(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function appendAvisoSnippet(dispoCell, snippet) {
  appendAvisoText(dispoCell, resolveContent(snippet.content));
}

// Ajout à la suite du contenu existant, jamais d'écrasement. Partagé par le bouton snippet et
// par celui des données DatAviso : c'est la même écriture dans la cellule Aviso.
function appendAvisoText(dispoCell, addition) {
  const textarea = dispoCell.querySelector('textarea.verification');
  if (!textarea || !addition) return;

  const hasExisting = textarea.value.trim().length > 0;
  const separator = hasExisting && !textarea.value.endsWith('\n') ? '\n' : '';
  ecrireAvisoValeur(dispoCell, textarea.value + separator + addition);
}

// Seule écriture dans une cellule Aviso, partagée par l'ajout ci-dessus et par la corbeille
// (effacement puis annulation de l'effacement).
function ecrireAvisoValeur(dispoCell, valeur) {
  const textarea = dispoCell.querySelector('textarea.verification');
  const displayDiv = dispoCell.querySelector('div.verification');
  if (!textarea) return;

  setNativeValue(textarea, valeur);
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  // Le <div> d'affichage et le <textarea> partagent le même id/name (bascule "lecture" <->
  // "édition" au clic) : on recopie la valeur complète du textarea, plutôt que d'y ajouter le
  // snippet. Aviso resynchronise déjà ce <div> depuis le textarea sur l'évènement 'change'
  // ci-dessus (dispatchEvent est synchrone, son handler a donc fini de s'exécuter ici) : un
  // ajout de notre côté afficherait le snippet en double. Recopier reste correct dans tous les
  // cas, y compris si Aviso ne resynchronise rien.
  if (displayDiv) {
    displayDiv.innerHTML = escapeHtmlAviso(textarea.value).replace(/\n/g, '<br>');
  }

  ajusterHauteurAviso(textarea);
  ajusterHauteurAviso(displayDiv);
}

// Un long snippet inséré dans un champ de quelques lignes resterait caché derrière une barre de
// défilement : le champ s'agrandit pour tout montrer, jusqu'à 60 % de la hauteur de la fenêtre
// (au-delà, il défile, pour ne pas repousser les lignes suivantes hors de la vue). Il ne
// rapetisse jamais sous la taille que lui donne Aviso.
const AVISO_HAUTEUR_MAX = 0.6;

function ajusterHauteurAviso(el) {
  // Masqué (le <div> de lecture et le <textarea> d'édition alternent) : rien à mesurer. Le
  // <textarea> est réajusté quand il reprend le focus, voir insertAvisoClearButton.
  if (!el || !el.offsetParent) return;
  if (el.scrollHeight <= el.clientHeight) return;
  // Plancher de 200 px : une fenêtre très basse (ou un cadre encore en cours de mise en page)
  // donnerait sinon un plafond dérisoire.
  const max = Math.max(200, Math.round(window.innerHeight * AVISO_HAUTEUR_MAX));
  const style = getComputedStyle(el);
  // scrollHeight compte le padding mais pas la bordure : la hauteur à poser en dépend.
  const bordureEtPadding = style.boxSizing === 'border-box'
    ? el.offsetHeight - el.clientHeight
    : -(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
  const actuelle = parseFloat(style.height) || 0;
  el.style.height = Math.max(actuelle, Math.min(el.scrollHeight + bordureEtPadding, max)) + 'px';
  el.style.maxHeight = Math.max(actuelle, max) + 'px';
  el.style.overflowY = 'auto';
}

const AVISO_BTN_STYLE = 'all:unset;cursor:pointer;display:inline-flex;vertical-align:middle;margin:0 6px 4px 0;';
const AVISO_IMG_STYLE = 'width:16px;height:16px;display:block;';

// Longueur maximale de l'infobulle de prévisualisation. Les infobulles natives ne défilent pas :
// au-delà, le texte déborderait de l'écran et deviendrait illisible. Le contenu inséré, lui,
// n'est jamais tronqué. Partagée par les icônes snippet et DatAviso.
const AVISO_TOOLTIP_MAX = 700;

function tronquerPourInfobulle(texte) {
  return texte.length > AVISO_TOOLTIP_MAX
    ? texte.slice(0, AVISO_TOOLTIP_MAX).trimEnd() + '…'
    : texte;
}

// Place une icône à son rang dans AVISO_ORDER : juste après la plus proche des icônes qui la
// précèdent et sont déjà posées, sinon en tête du conteneur. Jamais de position absolue — les
// données arrivent dans un ordre quelconque (synchro, import, scan suivant), l'ordre affiché
// doit pourtant rester le même.
function placerIcone(container, el) {
  const rang = AVISO_ORDER.indexOf(el.className);
  for (let i = rang - 1; i >= 0; i--) {
    const precedente = container.querySelector('.' + AVISO_ORDER[i]);
    if (precedente) {
      precedente.insertAdjacentElement('afterend', el);
      return;
    }
  }
  container.insertBefore(el, container.firstChild);
}

function creerBoutonAviso(className, iconPath, alt) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.style.cssText = AVISO_BTN_STYLE;
  const img = document.createElement('img');
  img.src = chrome.runtime.getURL(iconPath);
  img.alt = alt;
  img.style.cssText = AVISO_IMG_STYLE;
  btn.appendChild(img);
  return btn;
}

// Bouton d'insertion d'un snippet, commun au bleu (Clausier Commun) et au jaune (Clausier
// Personnel) : seuls l'icône et le libellé de l'infobulle changent.
function insertAvisoSnippetButton(container, dispoCell, snippet, className, iconPath, libelle) {
  if (container.querySelector('.' + className)) return;

  const btn = creerBoutonAviso(className, iconPath, libelle);

  // L'infobulle montre le texte qui sera réellement inséré, pour pouvoir le relire avant de
  // cliquer. Recalculé au survol et non une fois pour toutes : le contenu peut porter des
  // {date}/{time}, que resolveContent remplace par l'instant présent.
  const majTitre = () => {
    const texte = resolveContent(snippet.content);
    btn.title = `${libelle} "${snippet.trigger}" :\n${tronquerPourInfobulle(texte)}`;
  };
  majTitre();
  btn.addEventListener('mouseenter', majTitre);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    appendAvisoSnippet(dispoCell, snippet);
    compterUsage(className === AVISO_LOCAL_CLASS ? 'aviso_perso' : 'aviso_commun');
  });

  placerIcone(container, btn);
}

function insertAvisoIcon(container, dispoCell, snippet) {
  insertAvisoSnippetButton(container, dispoCell, snippet, AVISO_ICON_CLASS, 'icons/icon16.png',
    'Ajouter le contenu du snippet du Clausier Commun');
}

function insertAvisoLocalIcon(container, dispoCell, snippet) {
  insertAvisoSnippetButton(container, dispoCell, snippet, AVISO_LOCAL_CLASS, 'icons/local16.svg',
    'Ajouter le contenu du snippet du Clausier Personnel');
}

// Crayon jaune, à droite de l'icône jaune : modifie le snippet local sans quitter Aviso.
function insertAvisoEditIcon(container, snippet) {
  if (container.querySelector('.' + AVISO_EDIT_CLASS)) return;

  const btn = creerBoutonAviso(AVISO_EDIT_CLASS, 'icons/edit16.svg', `Modifier ${snippet.trigger}`);
  btn.title = `Modifier le snippet "${snippet.trigger}" du Clausier Personnel`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ouvrirEditeurLocal(snippet.trigger, snippet.content, true);
    compterUsage('aviso_crayon');
  });

  placerIcone(container, btn);
}

// Lien vers un texte réglementaire, ouvert dans un nouvel onglet : sitesecurite.com ou
// Légifrance, une icône par source (AVISO_SITESECURITE_CLASS, AVISO_LEGIFRANCE_CLASS), côte à
// côte. Indépendant du bouton d'insertion : il ne dépend que de la ligne, et s'affiche donc aussi
// sur les lignes sans snippet (consulter l'article reste utile même quand il n'y a rien à
// insérer). Un vrai <a> (plutôt qu'un window.open au clic) pour conserver les usages du
// navigateur : clic milieu, Ctrl+clic, "ouvrir dans un nouvel onglet".
// lien = { classe, url, titre, icone, statistique }
function insertAvisoLawLink(container, lien) {
  if (container.querySelector('.' + lien.classe)) return;

  const link = document.createElement('a');
  link.className = lien.classe;
  link.href = lien.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = lien.titre;
  link.style.cssText = AVISO_BTN_STYLE;

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL(lien.icone);
  img.alt = lien.titre;
  img.style.cssText = AVISO_IMG_STYLE;
  link.appendChild(img);

  // Seulement stopPropagation : sans preventDefault, la navigation par défaut du lien a bien
  // lieu — on empêche juste Aviso de réagir au clic (bascule lecture/édition de la cellule).
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    compterUsage(lien.statistique);
  });

  placerIcone(container, link);
}

const SOURCE_SITESECURITE = {
  classe: AVISO_SITESECURITE_CLASS, site: 'sitesecurite.com',
  icone: 'icons/sitesecurite32.png', statistique: 'aviso_sitesecurite'
};
const SOURCE_LEGIFRANCE = {
  classe: AVISO_LEGIFRANCE_CLASS, site: 'Légifrance',
  icone: 'icons/legifrance32.png', statistique: 'aviso_legifrance'
};

// Liens réglementaires d'une ligne, selon sa trame et les sources activées pour elle (issue #106).
// Renvoie [{ classe, url, titre, icone, statistique }], vide si la ligne ne désigne aucun article.
//   - BUP (code du travail) : reconnu au numéro lui-même, « R.4216-24 », « R.4227-6 », quelle que
//     soit la trame. R4214-26 à 28 relèvent de l'accessibilité, R4216 et R4227 de l'incendie.
//     Seul le premier article de la ligne compte (« R.4216-6 et R.4227-4 » -> R4216-6), et une
//     ligne qui cite aussi l'arrêté du 5 août 1992 renvoie à l'article R. du code.
//   - ERP : code d'article du règlement de sécurité (GN4, CO24…).
//   - Habitation : numéro « Art. N » relevé par articlesHabParLigne (trames SH-…).
function liensReglementairesLigne(refText, refCode, articleHab) {
  let trame = null, libelle = '', urlSitesecurite = null, urlLegifrance = null;

  // « R.4727-33 », « R.4727-37 » : coquilles du référentiel Aviso pour R4227 (le code du travail
  // n'a pas d'article R4727-3x), corrigées ici plutôt que de laisser ces lignes sans lien.
  const cdt = /^\s*R\s*\.?\s*(4214|4216|4227|4727)\s*-\s*(\d+(?:-\d+)?)/.exec(refText);
  const erp = /^([A-Z]+)(\d+(?:-\d+)?)$/.exec(refCode);
  if (cdt) {
    const chapitre = cdt[1] === '4727' ? '4227' : cdt[1];
    const numero = cdt[2];
    if (chapitre === '4214') {
      const n = parseInt(numero, 10);
      if (n < 26 || n > 28) return [];
      trame = 'BupAcces';
    } else {
      trame = 'BupIncendie';
    }
    libelle = `l'article R. ${chapitre}-${numero} du code du travail`;
    urlSitesecurite = sitesecuriteUrlForArticleCdt(chapitre, numero);
    urlLegifrance = legifranceUrlForArticleCdt(chapitre, numero);
  } else if (articleHab) {
    trame = 'Hab';
    const affiche = articleHab.replace(/b$/, ' bis');
    libelle = `l'article ${affiche} de l'arrêté du 31 janvier 1986 (habitation)`;
    urlSitesecurite = sitesecuriteUrlForArticleHab(articleHab);
    urlLegifrance = legifranceUrlForArticleHab(articleHab);
  } else if (erp) {
    trame = 'Erp';
    libelle = `l'article ${erp[1]} ${erp[2]} du règlement de sécurité ERP`;
    urlSitesecurite = sitesecuriteUrlForCode(refCode);
    urlLegifrance = legifranceUrlForCodeErp(refCode);
  } else {
    return [];
  }

  const liens = [];
  if (urlSitesecurite && SOURCES_REGLEMENTAIRES[trame + 'Sitesecurite']) {
    liens.push({ ...SOURCE_SITESECURITE, url: urlSitesecurite, titre: `Consulter ${libelle} sur sitesecurite.com` });
  }
  if (urlLegifrance && SOURCES_REGLEMENTAIRES[trame + 'Legifrance']) {
    liens.push({ ...SOURCE_LEGIFRANCE, url: urlLegifrance, titre: `Consulter ${libelle} sur Légifrance` });
  }
  return liens;
}

// Trames Habitation (RICT b - SH-IN, SH-EL, SH-TB…) : leurs lignes « Art. N » reprennent les
// articles de l'arrêté du 31 janvier 1986. Renvoie une Map ligne -> clé d'article ("27", "29b",
// "78-1"), vide hors de ces trames. « Art. 12 A » -> 12, « Art. 44-45 » et « Art. 89.2 » -> 44 et
// 89 (pas d'article 44-45 ni 89-2), « Art. 78-1 » -> 78-1.
// Les deux dernières parties de SH-IN (« TRAVAUX EXECUTES DANS LES BATIMENTS D'HABITATION
// EXISTANTS », « TRAVAUX DE MODIFICATION - RENOVATION DES FACADES… ») relèvent d'autres textes :
// leur « Art 2 » n'est pas l'article 2 de l'arrêté. Plus aucun lien après un titre « TRAVAUX ».
function articlesHabParLigne() {
  const parLigne = new Map();
  const titreTrame = [...document.querySelectorAll('fieldset')].some(f => /\bSH-[A-Z]+\b/.test(f.textContent));
  if (!titreTrame) return parLigne;

  for (const cellule of document.querySelectorAll('td.referentiel.content')) {
    const texte = cellule.textContent.trim();
    if (/^TRAVAUX\b/.test(texte)) break;
    const m = /^Art\.?\s*(\d+)(?:\s*(bis)\b|\s*-\s*(\d+))?/i.exec(texte);
    const tr = cellule.closest('tr');
    if (!m || !tr) continue;
    let cle = m[1];
    if (m[2]) cle = m[1] + 'b';
    else if (m[3] && LEGIFRANCE_ARTICLES_HAB[`${m[1]}-${m[3]}`]) cle = `${m[1]}-${m[3]}`;
    parLigne.set(tr, cle);
  }
  return parLigne;
}

// Trame HAND (RICT b, accessibilité des personnes handicapées) : elle réunit plusieurs textes,
// une partie par texte, chacune ouverte par une ligne de titre de niveau 1 (data-level="1") :
// ERP neufs (arrêté du 20 avril 2017), logements neufs (arrêté du 24 décembre 2015), logements à
// occupation temporaire ou saisonnière (arrêté du 14 mars 2014), lieux de travail (arrêté du
// 27 juin 1994, partie « CODE DU TRAVAIL »). Une ligne
// désigne sa partie par data-level1 (l'id de la ligne de titre). Seules les lignes « Art. N »
// portent un lien, vers l'article N du texte de LEUR partie : jusqu'à la v2.33.1, tout « Art. N »
// de la trame renvoyait à l'arrêté de 2017, y compris dans les parties logements et code du
// travail (« Art. 11. CARACTERISTIQUES DE BASE POUR TOUS LES LOGEMENTS » ouvrait l'article 11 des
// ERP). Une partie non reconnue (titre inconnu, partie ajoutée plus tard) n'a aucun lien.
// Renvoie une Map ligne -> { partie, numero }, vide hors de la trame HAND.
const PARTIES_HAND = [
  { partie: 'Erp', titre: /\bERP\b.*\bNEUFS?\b/ },
  { partie: 'Logements', titre: /HABITATION COLLECTIFS/ },
  { partie: 'Saisonniers', titre: /OCCUPATION TEMPORAIRE/ },
  { partie: 'Travail', titre: /CODE DU TRAVAIL/ },
];
function articlesHandParLigne() {
  const parLigne = new Map();
  // Le titre du référentiel (« RICT b - HAND - Accessibilité... ») est dans un fieldset.
  const titreTrame = [...document.querySelectorAll('fieldset')].some(f => /\bHAND\b/.test(f.textContent));
  if (!titreTrame) return parLigne;

  const partieDe = new Map(); // id de la ligne de titre -> partie (ou null)
  document.querySelectorAll('#report_builder tbody tr[data-ref-id][data-level="1"]').forEach(tr => {
    const libelle = tr.querySelector('td.referentiel.content');
    const texte = libelle ? libelle.textContent.toUpperCase() : '';
    const trouvee = PARTIES_HAND.find(p => p.titre.test(texte));
    partieDe.set(tr.dataset.refId, trouvee ? trouvee.partie : null);
  });

  document.querySelectorAll('#report_builder tbody tr[data-ref-id]').forEach(tr => {
    const partie = partieDe.get(tr.dataset.level === '1' ? tr.dataset.refId : tr.dataset.level1);
    if (!partie) return;
    const libelle = tr.querySelector('td.referentiel.content');
    const m = libelle && /^\s*Art\.\s*(\d+)(?:\.(\d))?/.exec(libelle.textContent);
    if (!m) return;
    // ERP : « Art. 7.1 » -> article 7-1, « Art.7.2.II » -> 7-2. Logements : « Art. 6.1 Escaliers »
    // et « Art. 5.2 » sont des parties des articles 6 et 5, qui n'ont pas d'article 6-1 ni 5-2.
    const numero = partie === 'Erp' && m[2] ? `${m[1]}-${m[2]}` : m[1];
    parLigne.set(tr, { partie, numero });
  });
  return parLigne;
}

// Lien Légifrance d'une ligne de la trame HAND, ou null. Une case par source dans les Paramètres :
// sourceHandLegifrance (ERP neufs), sourceHandHabLegifrance (les deux parties logements),
// sourceHandTravailLegifrance (lieux de travail).
function lienLegifranceHand(article) {
  if (!article) return null;
  const { partie, numero } = article;
  let url = null, texte = null, actif = false;
  if (partie === 'Erp') {
    url = legifranceUrlForArticlePmr(numero);
    texte = LEGIFRANCE_ARRETE_PMR_TITRE;
    actif = SOURCES_REGLEMENTAIRES.HandLegifrance;
  } else if (partie === 'Logements') {
    url = legifranceUrlForArticleLogements(numero);
    texte = LEGIFRANCE_ARRETE_LOGEMENTS_TITRE;
    actif = SOURCES_REGLEMENTAIRES.HandHabLegifrance;
  } else if (partie === 'Saisonniers') {
    url = legifranceUrlForArticleSaisonniers(numero);
    texte = LEGIFRANCE_ARRETE_SAISONNIERS_TITRE;
    actif = SOURCES_REGLEMENTAIRES.HandHabLegifrance;
  } else if (partie === 'Travail') {
    url = legifranceUrlForArticleTravail(numero);
    texte = LEGIFRANCE_ARRETE_TRAVAIL_TITRE;
    actif = SOURCES_REGLEMENTAIRES.HandTravailLegifrance;
  }
  if (!url || !actif) return null;
  return { ...SOURCE_LEGIFRANCE, url, titre: `Consulter l'article ${numero} de l'${texte} sur Légifrance` };
}

// Icône verte : ajoute les données DatAviso de cet article (tous ses champs, sans la ligne de
// titre). Même comportement d'ajout que le bouton snippet — rien n'est écrasé. Dernière icône
// de la rangée (voir AVISO_ORDER).
function insertAvisoImportIcon(container, dispoCell, article) {
  if (container.querySelector('.' + AVISO_IMPORT_CLASS)) return;

  const texte = importedArticleToText(article);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = AVISO_IMPORT_CLASS;
  // L'infobulle montre le texte qui sera réellement inséré, pour pouvoir le relire avant de
  // cliquer plutôt que de découvrir le contenu une fois dans la cellule. Calculé une fois : les
  // données DatAviso sont figées entre deux imports, contrairement au contenu d'un snippet.
  btn.title = tronquerPourInfobulle(texte);
  btn.style.cssText = AVISO_BTN_STYLE;

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icons/imported16.svg');
  img.alt = `Données DatAviso ${article.code}`;
  img.style.cssText = AVISO_IMG_STYLE;
  btn.appendChild(img);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    appendAvisoText(dispoCell, texte);
    compterUsage('aviso_dataviso');
  });

  placerIcone(container, btn);
}

// Bouton "+" : crée dans le Clausier Personnel un snippet dont le déclencheur reprend le
// Référentiel et dont le contenu reprend le texte déjà saisi dans "Dispositions réalisées" —
// c'est le cas courant : on rédige une fois la disposition, puis on la capitalise en snippet.
// Ouvre la fenêtre d'édition pour relire avant d'enregistrer. N'apparaît que sur les lignes sans
// snippet local : deux snippets locaux au même déclencheur rendraient l'expansion imprévisible.
// Aucune écriture dans le Google Sheets depuis Aviso : l'ajout public de ligne a été retiré du
// script (API v6), il permettait à n'importe qui d'injecter un snippet chez tous.
function insertAvisoAddIcon(container, dispoCell, refCode) {
  if (container.querySelector('.' + AVISO_ADD_CLASS)) return;

  const trigger = '/' + refCode;

  // Contenu déjà saisi dans "Dispositions réalisées" : il sert de contenu au snippet créé. Lu au
  // clic et non à la pose de l'icône — la cellule est éditable, sa valeur au moment du scan
  // n'est pas celle que l'utilisateur a sous les yeux quand il clique.
  const lireDispositions = () => {
    const textarea = dispoCell.querySelector('textarea.verification');
    return textarea ? textarea.value.trim() : '';
  };

  const btn = creerBoutonAviso(AVISO_ADD_CLASS, 'icons/add16.svg', `Créer le snippet ${trigger}`);
  // Le libellé dépend de ce que contient la cellule : il est recalculé au survol, la saisie
  // pouvant avoir changé depuis la pose de l'icône.
  const majTitre = () => {
    btn.title = lireDispositions()
      ? `Créer le snippet "${trigger}" dans le Clausier Personnel, à partir du texte saisi dans cette cellule`
      : `Créer le snippet "${trigger}" dans le Clausier Personnel`;
  };
  majTitre();
  btn.addEventListener('mouseenter', majTitre);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ouvrirEditeurLocal(trigger, lireDispositions(), false, dispoCell);
    compterUsage('aviso_plus');
  });

  placerIcone(container, btn);
}

// ---------- Clausier Personnel : écriture ----------
// Les snippets locaux vivent dans chrome.storage.local (clé localSnippets), accessible
// directement depuis le script de contenu. Lecture puis réécriture de la liste entière : les
// modifications concurrentes (deux onglets Aviso) sont assez improbables pour ne pas justifier
// de verrou, et chrome.storage.onChanged resynchronise ensuite tous les onglets.

async function enregistrerSnippetLocal(trigger, content) {
  const { localSnippets } = await chrome.storage.local.get(['localSnippets']);
  const liste = (localSnippets || []).slice();
  const i = liste.findIndex(s => s.trigger === trigger);
  if (i >= 0) liste[i] = { ...liste[i], content };
  else liste.push({ trigger, content });
  await chrome.storage.local.set({ localSnippets: liste });
}

async function supprimerSnippetLocal(trigger) {
  const { localSnippets } = await chrome.storage.local.get(['localSnippets']);
  const liste = (localSnippets || []).filter(s => s.trigger !== trigger);
  await chrome.storage.local.set({ localSnippets: liste });
}

// ---------- Clausier Personnel : fenêtre d'édition dans Aviso ----------
// Superposée à la page, sans la quitter. Montée dans un Shadow DOM : les styles d'Aviso ne
// l'atteignent pas, et les siens ne débordent pas sur le rapport.

const AVISO_EDITOR_ID = 'snippet-expander-editeur-local';

const AVISO_EDITOR_CSS = `
  .fond { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15, 20, 35, 0.45);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
  .fenetre { background: #ffffff; color: #16213d; width: min(680px, 92vw); max-height: 90vh;
    display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; border-radius: 12px;
    border-top: 5px solid #f2b705; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3); box-sizing: border-box; }
  h2 { margin: 0; font-size: 15px; font-weight: 700; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: #fdf3d0;
    padding: 1px 6px; border-radius: 4px; }
  .aide { margin: 0; color: #5b6a8f; font-size: 12px; line-height: 1.5; }
  textarea { width: 100%; min-height: 260px; box-sizing: border-box; padding: 10px 12px; resize: vertical;
    border: 1px solid #c3cdea; border-radius: 8px; font-family: inherit; font-size: 13.5px;
    line-height: 1.5; color: inherit; }
  textarea:focus { outline: none; border-color: #c99700; box-shadow: 0 0 0 3px #fdf3d0; }
  .erreur { margin: 0; color: #b3261e; font-size: 12.5px; }
  .erreur[hidden] { display: none; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .espace { flex: 1; }
  button { border: none; border-radius: 8px; padding: 8px 14px; font-family: inherit;
    font-size: 13px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .enregistrer { background: #f2b705; color: #3d2e00; }
  .enregistrer:hover { background: #dba500; }
  .annuler { background: #e6ebfa; color: #1f3d8f; }
  .supprimer { background: none; color: #b3261e; border: 1px solid #eccbc8; }
  .supprimer:hover { background: #fbeceb; }
  .supprimer[hidden] { display: none; }
`;

// Après la création d'un snippet par le "+", reporte dans la cellule ce qu'elle ne contient pas
// encore. La fenêtre s'ouvre préremplie avec le texte de la cellule : l'ajouter tel quel le
// doublerait. Cellule vide : tout le snippet. Snippet qui prolonge le texte de la cellule : la
// seule suite. Texte réécrit : rien, la cellule n'étant jamais remplacée (rien n'est écrasé).
function reporterCreationDansAviso(dispoCell, texteCellule, contenu) {
  const debut = texteCellule.trim();
  let ajout = '';
  if (!debut) ajout = contenu;
  else if (contenu.startsWith(debut)) ajout = contenu.slice(debut.length).replace(/^\s+/, '');
  if (ajout.trim()) appendAvisoText(dispoCell, resolveContent(ajout));
}

// dispoCell n'est fourni que pour une création depuis le "+" : c'est le seul cas où le snippet
// enregistré est aussi ajouté à la cellule Aviso. Le crayon corrige le snippet pour les fois
// suivantes, sans toucher au rapport.
function ouvrirEditeurLocal(trigger, contenuInitial, existant, dispoCell) {
  if (document.getElementById(AVISO_EDITOR_ID)) return; // une seule fenêtre à la fois

  const host = document.createElement('div');
  host.id = AVISO_EDITOR_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${AVISO_EDITOR_CSS}</style>
    <div class="fond">
      <div class="fenetre" role="dialog" aria-modal="true" aria-labelledby="titre">
        <h2 id="titre"></h2>
        <p class="aide">Clausier Personnel : ce snippet est enregistré dans ce navigateur uniquement.
          Il s'insère avec l'icône jaune et, au clavier, l'emporte sur un snippet du Clausier Commun
          de même déclencheur. Ctrl+Entrée pour enregistrer, Échap pour annuler.</p>
        <textarea spellcheck="true"></textarea>
        <p class="erreur" hidden></p>
        <div class="actions">
          <button type="button" class="supprimer">🗑️ Supprimer</button>
          <span class="espace"></span>
          <button type="button" class="annuler">Annuler</button>
          <button type="button" class="enregistrer">Enregistrer</button>
        </div>
      </div>
    </div>`;

  const titre = root.getElementById('titre');
  titre.append(existant ? 'Modifier le snippet ' : 'Créer le snippet ');
  const code = document.createElement('code');
  code.textContent = trigger;
  titre.appendChild(code);

  const textarea = root.querySelector('textarea');
  const erreurEl = root.querySelector('.erreur');
  const btnEnregistrer = root.querySelector('.enregistrer');
  const btnSupprimer = root.querySelector('.supprimer');
  textarea.value = contenuInitial || '';
  btnSupprimer.hidden = !existant;

  // Les évènements de la fenêtre ne doivent pas atteindre Aviso : ses raccourcis clavier et sa
  // bascule lecture/édition des cellules réagiraient à une frappe ou un clic destinés ici.
  ['keydown', 'keyup', 'keypress', 'input', 'click', 'mousedown', 'mouseup'].forEach(type => {
    host.addEventListener(type, (e) => e.stopPropagation());
  });

  const fermer = () => host.remove();
  const afficherErreur = (message) => {
    erreurEl.textContent = message;
    erreurEl.hidden = false;
  };
  // Après un rechargement de l'extension, l'ancien script de contenu reste dans la page mais
  // perd l'accès à chrome.storage : seul un rechargement de la page Aviso le rétablit.
  const messageErreur = (err) => /context invalidated/i.test(err && err.message)
    ? "L'extension a été mise à jour : rechargez la page Aviso, puis recommencez."
    : `Enregistrement impossible : ${err && err.message}`;

  const annuler = () => {
    if (textarea.value !== (contenuInitial || '') &&
        !confirm('Abandonner les modifications de ce snippet ?')) return;
    fermer();
  };

  const enregistrer = () => {
    if (!textarea.value.trim()) {
      afficherErreur(existant
        ? 'Le contenu est vide. Pour retirer ce snippet, utilisez « Supprimer ».'
        : 'Le contenu est vide : saisissez le texte du snippet.');
      return;
    }
    btnEnregistrer.disabled = true;
    const contenu = textarea.value;
    enregistrerSnippetLocal(trigger, contenu)
      .then(() => {
        fermer();
        if (!existant && dispoCell) reporterCreationDansAviso(dispoCell, contenuInitial || '', contenu);
      })
      .catch((err) => {
        btnEnregistrer.disabled = false;
        afficherErreur(messageErreur(err));
      });
  };

  btnEnregistrer.addEventListener('click', enregistrer);
  root.querySelector('.annuler').addEventListener('click', annuler);
  btnSupprimer.addEventListener('click', () => {
    if (!confirm(`Supprimer le snippet "${trigger}" du Clausier Personnel ?`)) return;
    supprimerSnippetLocal(trigger).then(fermer).catch((err) => afficherErreur(messageErreur(err)));
  });
  root.querySelector('.fenetre').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); annuler(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enregistrer(); }
  });

  document.body.appendChild(host);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

// ---------- Corbeille : vider la cellule d'un clic, et pouvoir revenir en arrière ----------
// Seul effacement de texte dans Aviso, et uniquement sur ce clic explicite. Pas de demande de
// confirmation : la corbeille se change aussitôt en bouton "Annuler l'effacement", qui remet le
// texte effacé. L'annulation reste offerte tant que la cellule est vide ; dès qu'on y écrit à
// nouveau, elle disparaît (restaurer écraserait alors la nouvelle saisie) et la corbeille revient.

const AVISO_SVG_CORBEILLE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.75 7v4.5M9.25 7v4.5"/></svg>';
const AVISO_SVG_ANNULER = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/></svg>';

const AVISO_COULEUR_CORBEILLE = '#5b6a8f';
const AVISO_COULEUR_CORBEILLE_SURVOL = '#b3261e';
const AVISO_COULEUR_ANNULER = '#1f3d8f';

function insertAvisoClearButton(container, dispoCell) {
  if (container.querySelector('.' + AVISO_CLEAR_CLASS)) return;
  const textarea = dispoCell.querySelector('textarea.verification');
  if (!textarea) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = AVISO_CLEAR_CLASS;
  // Flottant à droite : collé au bord droit de la cellule, sur la ligne des icônes.
  btn.style.cssText = AVISO_BTN_STYLE + 'float:right;margin:0 0 4px 6px;';

  // Texte effacé, en attente d'une éventuelle annulation ; null hors de ce mode.
  let texteEfface = null;

  const majAffichage = () => {
    const enAnnulation = texteEfface !== null;
    btn.innerHTML = enAnnulation ? AVISO_SVG_ANNULER : AVISO_SVG_CORBEILLE;
    btn.style.color = enAnnulation ? AVISO_COULEUR_ANNULER : AVISO_COULEUR_CORBEILLE;
    btn.title = enAnnulation ? "Annuler l'effacement : remettre le texte effacé" : 'Effacer le contenu de ce champ';
    btn.style.display = enAnnulation || textarea.value.trim() ? 'inline-flex' : 'none';
  };

  btn.addEventListener('mouseenter', () => {
    if (texteEfface === null) btn.style.color = AVISO_COULEUR_CORBEILLE_SURVOL;
  });
  btn.addEventListener('mouseleave', majAffichage);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (texteEfface === null) {
      texteEfface = textarea.value;
      ecrireAvisoValeur(dispoCell, '');
      compterUsage('aviso_corbeille');
    } else {
      const aRemettre = texteEfface;
      texteEfface = null; // avant l'écriture : son évènement 'change' ne doit plus voir le mode annulation
      ecrireAvisoValeur(dispoCell, aRemettre);
      compterUsage('aviso_annuler');
    }
    majAffichage();
  });

  // La corbeille suit la saisie : visible dès qu'il y a du texte (frappe, insertion d'un
  // snippet), masquée sinon. Une nouvelle saisie après effacement abandonne l'annulation.
  const surModification = () => {
    if (texteEfface !== null && textarea.value.trim()) texteEfface = null;
    majAffichage();
  };
  textarea.addEventListener('input', surModification);
  textarea.addEventListener('change', surModification);
  // Le <textarea> était masqué quand un snippet a été inséré en mode lecture : il prend la bonne
  // hauteur au moment où on le rouvre pour l'éditer.
  textarea.addEventListener('focus', () => ajusterHauteurAviso(textarea));

  majAffichage();
  container.insertBefore(btn, container.firstChild);
}

// ---------- Boutons d'avis et de conformité : Favorable, Observation, Conforme… ----------
// Au-dessus du menu déroulant d'avis d'Aviso, une rangée de boutons colorés : un clic choisit
// l'avis, au lieu d'ouvrir le menu puis de viser la bonne ligne (#94). Le menu reste en place et
// fait foi : les boutons ne font que le piloter, et suivent son état.
// Le menu est reconnu à son nom (`verification[<id>][avis_id]`, relevé sur Aviso), ou à défaut au
// texte de ses options, comparé souplement (cleAvis) : Aviso écrit « Observations » au pluriel
// et « [Aucun] » entre crochets. La v2.28.0 attendait « Observation » à l'identique et ne
// reconnaissait aucun menu.
const AVIS_NOM_RE = /\[avis_id\]$/;
// Deux familles de menus portent des boutons, reconnues chacune à deux options qui lui sont
// propres : l'avis (Favorable, Observations…) et la conformité (Conforme, Non conforme…). Chacune
// a son compteur, pour savoir laquelle sert.
const MENUS_AVIS = [
  { requis: ['favorable', 'observation'], statistique: 'aviso_avis' },
  { requis: ['conforme', 'non conforme'], statistique: 'aviso_conformite' }
];
// Couleur et libellé abrégé par avis (texte d'option normalisé par cleAvis). Les deux vont par
// paire, dans une seule table : séparés, ajouter un avis demandait de penser aux deux, et en
// oublier un passait inaperçu. Un avis absent d'ici s'affiche en gris avec le libellé d'Aviso —
// une option ajoutée par Aviso apparaît donc quand même, sans couleur trompeuse.
//
// Abrégés parce que la colonne Remarques est étroite : les six libellés entiers y tenaient sur
// trois lignes, abrégés ils tiennent sur une seule. Le libellé entier reste dans l'infobulle.
const AVIS_GRIS = '#6b6b6b';
const AVIS_STYLES = {
  'aucun':        { couleur: AVIS_GRIS,  abrege: 'Aucun' },
  'favorable':    { couleur: '#2e7d32', abrege: 'Fav.' },
  'observation':  { couleur: '#e67e22', abrege: 'Obs.' },
  'conforme':     { couleur: '#2e7d32', abrege: 'Conf.' },
  'non conforme': { couleur: '#e67e22', abrege: 'Non conf.' },
  'a preciser':   { couleur: '#1f6fb2', abrege: 'À préc.' },
  'sans objet':   { couleur: AVIS_GRIS,  abrege: 'S.O.' },
  'hors mission': { couleur: AVIS_GRIS,  abrege: 'H.M.' }
};
// Les rangées déjà posées, pour les remettre à jour au scan : Aviso peut changer l'avis sans
// émettre d'évènement (rechargement AJAX de la valeur), que l'écoute de 'change' ne verrait pas.
const rangeesAvis = new WeakMap();
// Les menus déjà écoutés. Un menu survit à sa rangée — reconstruite à chaque changement de
// réglage (`retirerIconesAviso` retire les rangées, pas les menus) ou d'options — donc un
// écouteur posé par rangée s'accumulerait sur le menu : après dix bascules du réglage, dix
// écouteurs, dont neuf repeignant des boutons retirés de la page et les maintenant en mémoire.
// L'écouteur unique retrouve la rangée en cours au moment de l'évènement.
const menusEcoutes = new WeakSet();

function ecouterMenuAvis(select) {
  if (menusEcoutes.has(select)) return;
  menusEcoutes.add(select);
  select.addEventListener('change', () => {
    const rangee = rangeesAvis.get(select);
    if (rangee && rangee.isConnected) rangee.majAvis();
  });
}

// "[Aucun]" -> "aucun", "Observations" -> "observation", "A préciser" -> "a preciser" : sans
// accents, ponctuation ni pluriel final, pour comparer quelle que soit l'écriture d'Aviso.
function cleAvis(texte) {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/s$/, '');
}

// Libellé du bouton : celui d'Aviso, sans les crochets de « [Aucun] ».
function libelleAvis(texte) {
  return texte.trim().replace(/^\[(.*)\]$/, '$1').trim();
}

// Ce que les boutons reflètent : la valeur et le libellé de chaque option. Sert de clé à la
// famille retenue comme à la rangée posée — ni l'une ni l'autre ne valent pour un autre jeu
// d'options. Aviso remplit parfois ces menus par AJAX après le premier scan, ou en remplace les
// options sans remplacer le menu.
function signatureOptions(select) {
  return [...select.options].map(o => `${o.value}\u0000${o.textContent}`).join('\u0001');
}

// Famille du menu (MENUS_AVIS), ou null s'il n'en est pas un. Un menu nommé `[avis_id]` dont les
// options ne disent pas la famille est un menu d'avis.
function classerMenuAvis(select) {
  const cles = [...select.options].map(o => cleAvis(o.textContent));
  const famille = MENUS_AVIS.find(m => m.requis.every(r => cles.includes(r)));
  if (famille) return famille;
  return AVIS_NOM_RE.test(select.name || '') ? MENUS_AVIS[0] : null;
}

// La famille ne change pas tant que les options ne changent pas : elle est retenue par menu,
// pour ne pas normaliser par cleAvis toutes les options de tous les `<select>` de la page à
// chaque scan — et le scan se relance à chaque modification du DOM comme à chaque
// redimensionnement. La clé est la signature et non le menu seul : sinon un menu encore vide
// resterait classé « pas un menu d'avis » pour toujours.
const famillesMenus = new WeakMap();

function familleMenuAvis(select, signature) {
  const retenu = famillesMenus.get(select);
  if (retenu && retenu.signature === signature) return retenu.famille;
  const famille = classerMenuAvis(select);
  famillesMenus.set(select, { signature, famille });
  return famille;
}

// Choisit l'avis comme le ferait l'utilisateur dans le menu : 'input' puis 'change', qui
// remontent jusqu'aux écouteurs d'Aviso (jQuery compris) pour l'enregistrement.
//
// L'option est retrouvée par sa valeur au moment du clic, et non retenue à la pose des boutons :
// Aviso peut remplacer les options d'un menu sans remplacer le menu lui-même, et une référence
// gardée pointerait alors sur une option détachée — le bouton se colorait, Aviso conservait
// l'avis précédent. Valeur inconnue : on ne touche à rien, plutôt que de vider le menu.
function choisirAvis(select, valeur) {
  const option = [...select.options].find(o => o.value === valeur);
  if (!option || option.selected) return false;
  option.selected = true;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Un menu masqué par l'extension porte cet attribut : c'est ce qui permet de le réafficher, et de
// ne jamais toucher à un menu qu'Aviso aurait masqué lui-même. Le menu reste dans la page, avec
// sa valeur : les boutons continuent de le piloter, et Aviso de l'enregistrer.
const AVIS_MENU_MASQUE_ATTR = 'data-dataviso-menu-masque';

// Le conteneur du menu (`#show_avis` dans la cellule Remarques) ne fait que 50 % de la cellule, à
// côté des liens « Choix du Plan d'affaire » et « Clausier » (`#rmq_buttons_tpl`, 28 %). Une
// rangée de boutons plus large que ces 50 % en débordait et passait sous les liens (#94, #115).
// Le conteneur s'élargit donc à la rangée (`min-width: max-content`, jamais en dessous des 50 %
// d'Aviso) : les liens, en ligne comme lui, se placent à sa suite s'il reste la place, ou passent
// d'eux-mêmes à la ligne du dessous. C'est la mise en page qui les écarte, sans mesure ni
// déplacement : rien à rattraper quand Aviso les affiche après le scan (simple changement de
// style, que le MutationObserver ne voit pas) ni quand la ligne n'a pas de « Descendre l'avis ».
// Le bloc des liens perd en même temps sa largeur fixe de 28 % pour ne prendre que celle de ses
// deux liens : sur un grand écran, ils tiennent ainsi à droite des boutons au lieu de descendre.
// L'élargissement suit le masquage du menu : l'un ne va jamais sans l'autre. L'attribut marque ce
// que l'extension a modifié, seul critère pour le rendre à Aviso.
const AVIS_CONTENEUR_ELARGI_ATTR = 'data-dataviso-avis-elargi';

function elargirConteneurAvis(conteneur, elargir) {
  if (!conteneur) return;
  // Bloc des liens : frère du conteneur dans la cellule (ids répétés à chaque ligne).
  const liens = conteneur.parentElement && conteneur.parentElement.querySelector(':scope > #rmq_buttons_tpl');
  [[conteneur, 'minWidth', 'max-content'], [liens, 'width', 'auto']].forEach(([el, prop, valeur]) => {
    if (!el || el.hasAttribute(AVIS_CONTENEUR_ELARGI_ATTR) === elargir) return;
    el.toggleAttribute(AVIS_CONTENEUR_ELARGI_ATTR, elargir);
    el.style[prop] = elargir ? valeur : '';
  });
}

function masquerMenuAvis(select) {
  if (select.hasAttribute(AVIS_MENU_MASQUE_ATTR)) return;
  select.setAttribute(AVIS_MENU_MASQUE_ATTR, '');
  select.style.display = 'none';
  elargirConteneurAvis(select.parentElement, true);
}

function demasquerMenuAvis(select) {
  if (!select.hasAttribute(AVIS_MENU_MASQUE_ATTR)) return;
  select.removeAttribute(AVIS_MENU_MASQUE_ATTR);
  select.style.display = '';
  elargirConteneurAvis(select.parentElement, false);
}

function reafficherMenusAvis() {
  document.querySelectorAll(`select[${AVIS_MENU_MASQUE_ATTR}]`).forEach(demasquerMenuAvis);
}

function insertAvisoBoutonsAvis(select, famille, signature) {
  const existante = rangeesAvis.get(select);
  // La rangée en place ne vaut que pour les options sur lesquelles elle a été construite : sinon
  // on retombe plus bas sur une reconstruction complète.
  if (existante && existante.isConnected && existante.signatureAvis === signature) {
    existante.majAvis();
    masquerMenuAvis(select);
    return;
  }

  const rangee = document.createElement('div');
  rangee.className = AVISO_AVIS_CLASS;
  rangee.setAttribute('role', 'group');
  rangee.setAttribute('aria-label', "Choisir l'avis");
  rangee.style.cssText = 'display:flex;flex-wrap:nowrap;gap:3px;margin:0 0 4px 0;';

  const boutons = [];
  [...select.options].forEach(option => {
    const libelle = libelleAvis(option.textContent);
    // Ligne vide ou de remplissage du menu (« -- », « --- ») : rien à choisir.
    if (!/\p{L}/u.test(libelle) || option.disabled) return;
    const style = AVIS_STYLES[cleAvis(libelle)] || {};
    const couleur = style.couleur || AVIS_GRIS;
    const valeur = option.value;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = style.abrege || libelle;
    btn.title = `Avis : ${libelle}`;
    btn.style.cssText = 'all:unset;cursor:pointer;box-sizing:border-box;padding:1px 5px;flex:none;'
      + 'border-radius:10px;font:600 11px/16px Arial,sans-serif;white-space:nowrap;'
      + `border:1px solid ${couleur};`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (select.disabled) return;
      if (choisirAvis(select, valeur)) compterUsage(famille.statistique);
      majAvis();
    });
    boutons.push({ btn, valeur, couleur });
    rangee.appendChild(btn);
  });

  // Aucune option utilisable : le menu n'est pas encore rempli (Aviso les charge parfois par AJAX
  // après le premier scan), ou il vient d'être vidé. Le masquer priverait la ligne de tout moyen
  // de choisir l'avis, et une rangée vide, étant connectée, ne serait jamais reconstruite. On
  // laisse donc le menu d'origine, et le scan suivant reconstruit dès que les options arrivent.
  if (!boutons.length) {
    if (existante) {
      existante.remove();
      rangeesAvis.delete(select);
    }
    demasquerMenuAvis(select);
    return;
  }

  // Le bouton de l'avis en cours est plein, les autres au trait : l'état se lit d'un coup d'œil.
  function majAvis() {
    const courant = select.value;
    boutons.forEach(({ btn, valeur, couleur }) => {
      const actif = valeur === courant;
      btn.style.background = actif ? couleur : '#fff';
      btn.style.color = actif ? '#fff' : couleur;
      btn.style.opacity = select.disabled ? '0.5' : '1';
      btn.style.cursor = select.disabled ? 'default' : 'pointer';
      btn.setAttribute('aria-pressed', String(actif));
    });
  }
  rangee.majAvis = majAvis;
  rangee.signatureAvis = signature;
  ecouterMenuAvis(select);
  majAvis();

  // Un menu remplacé par Aviso (rechargement AJAX) peut laisser derrière lui la rangée de
  // l'ancien : on la retire, sinon la ligne porterait deux rangées.
  const orpheline = select.previousElementSibling;
  if (orpheline && orpheline.classList.contains(AVISO_AVIS_CLASS)) orpheline.remove();
  select.insertAdjacentElement('beforebegin', rangee);
  rangeesAvis.set(select, rangee);
  masquerMenuAvis(select);
}

// Pages où aucun menu n'est remplacé par des boutons, quel que soit le réglage (#110). La
// validation de plan (/verifications/edit/…) porte des menus que `familleMenuAvis` reconnaît,
// mais qui n'y sont pas des avis de ligne de rapport : les remplacer y gênait la saisie. Préfixes
// de chemin comparés sans casse ; l'hôte est déjà celui d'Aviso (isAvisoSite).
const PAGES_SANS_BOUTONS_AVIS = ['/verifications/edit/'];

function pageSansBoutonsAvis() {
  const chemin = location.pathname.toLowerCase();
  return PAGES_SANS_BOUTONS_AVIS.some(prefixe => chemin.startsWith(prefixe));
}

function scanSelecteursAvis() {
  if (!BOUTONS_AVIS) return;
  if (pageSansBoutonsAvis()) {
    // Arrivé ici sans rechargement (navigation AJAX) : rien ne doit rester des boutons posés
    // avant, ni menu masqué sans bouton.
    if (document.querySelector('.' + AVISO_AVIS_CLASS) || document.querySelector(`select[${AVIS_MENU_MASQUE_ATTR}]`)) {
      reafficherMenusAvis();
      document.querySelectorAll('.' + AVISO_AVIS_CLASS).forEach(el => el.remove());
    }
    return;
  }
  document.querySelectorAll('select').forEach(select => {
    const signature = signatureOptions(select);
    const famille = familleMenuAvis(select, signature);
    if (famille) insertAvisoBoutonsAvis(select, famille, signature);
  });
}

// ---------- Liens d'affaire : SGO, SharePoint, Explorateur Windows ----------
// À partir du numéro d'affaire (8 chiffres en général, parfois 7 : utilisé tel quel), trois
// liens discrets, monochromes, chacun désactivable dans Paramètres avancés :
// - sur la liste Plans Affaires, à côté de la loupe "Consulter" de chaque ligne ;
// - dans la barre bleue d'une affaire ouverte, à gauche du sélecteur de métier "BTS".
// De simples liens dans la page : aucune permission supplémentaire n'est nécessaire.

const SGO_URL = 'https://sgo.bureauveritas.com/SGO-Client/servlet/com.bv.sgo.modele.affaire.j2ee.AramisSGOCtrl';
const SHAREPOINT_RECHERCHE_URL = 'https://bureauveritas.sharepoint.com/_layouts/15/sharepoint.aspx/search';
// Un navigateur ne peut pas lancer l'Explorateur lui-même : le protocole search-ms:, propre à
// Windows, ouvre une recherche dans l'Explorateur (Chrome demande d'abord l'autorisation
// d'ouvrir l'application). Sans objet ailleurs : le lien n'est posé que sous Windows.
// Recherche dans C:\Users\ : les profils Windows, donc le dossier "Bureau Veritas" de
// l'utilisateur, sans parcourir tout le disque. Viser directement ce dossier a été essayé
// (v2.20.1) et abandonné : l'Explorateur ne développe pas %USERPROFILE% dans un lien search-ms:
// (rien ne s'ouvre), et une page web ne peut pas connaître l'identifiant Windows.
const EXPLORATEUR_DOSSIER = 'C:\\Users\\';
const EXPLORATEUR_LIBELLE = 'C:\\Users';
const EST_WINDOWS = /Windows/i.test(navigator.userAgent);

// "29462057 / 1" (liste) ou "33846357 / 1 - CTC - PROJET…" (barre bleue) -> "29462057"
const NUMERO_AFFAIRE_RE = /^\s*(\d{5,})\s*\//;

function numeroAffaire(texte) {
  const m = NUMERO_AFFAIRE_RE.exec(String(texte || ''));
  return m ? m[1] : null;
}

const SVG_ATTRS = 'height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
const LIENS_AFFAIRE_DEFS = [
  {
    cle: 'sgo',
    libelle: 'SGO',
    titre: (n) => `Ouvrir l'affaire ${n} dans SGO`,
    url: (n) => `${SGO_URL}?identifiant=${encodeURIComponent(n)}&action=accesDirect`,
    svg: `<svg viewBox="0 0 22 16" width="22" ${SVG_ATTRS}><rect x="0.75" y="2.75" width="20.5" height="10.5" rx="2.5"/>` +
      '<text x="11" y="10.9" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial, sans-serif" font-size="7.4" font-weight="700" letter-spacing="0.3">SGO</text></svg>'
  },
  {
    cle: 'sharepoint',
    libelle: 'ShP',
    titre: (n) => `Rechercher l'affaire ${n} dans SharePoint`,
    url: (n) => `${SHAREPOINT_RECHERCHE_URL}?q=${encodeURIComponent(n)}`,
    // Même cadre que SGO : trois lettres aussi.
    svg: `<svg viewBox="0 0 22 16" width="22" ${SVG_ATTRS}><rect x="0.75" y="2.75" width="20.5" height="10.5" rx="2.5"/>` +
      '<text x="11" y="10.9" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial, sans-serif" font-size="7.4" font-weight="700" letter-spacing="0.3">ShP</text></svg>'
  },
  {
    cle: 'explorateur',
    libelle: 'C:\\',
    windowsSeulement: true,
    titre: (n) => `Rechercher "${n}" dans l'Explorateur Windows (${EXPLORATEUR_LIBELLE})`,
    url: (n) => `search-ms:displayname=${encodeURIComponent('Affaire ' + n)}` +
      `&crumb=location:${encodeURIComponent(EXPLORATEUR_DOSSIER)}&query=${encodeURIComponent(n)}`,
    // « C:\ » plutôt qu'un dossier : dit à la fois l'outil (l'Explorateur) et où il cherche.
    svg: `<svg viewBox="0 0 20 16" width="20" ${SVG_ATTRS}><rect x="0.75" y="2.75" width="18.5" height="10.5" rx="2.5"/>` +
      '<text x="10" y="10.9" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial, sans-serif" font-size="7.4" font-weight="700" letter-spacing="0.3">C:\\</text></svg>'
  }
];

// Bande verticale qui contient toutes les icônes, trait de 1,4 compris (voir LIENS_AFFAIRE_DEFS).
const ICONE_RECADRAGE = { y: 2.0, hauteur: 12.5 };

// Boutons de la liste Plans Affaires : libellé en vrai texte (plus lisible qu'un dessin de 7 px),
// hauteur au plus juste pour que les trois tiennent empilés dans une ligne de deux lignes de texte.
const BOUTON_TEXTE = 11;   // px
const BOUTON_HAUTEUR = 13; // px, bordure comprise

// couleur : celle de l'environnement (blanc sur la barre bleue, gris sur la liste) ;
// survol : plus contrasté, sans changer de teinte, pour rester discret.
// taille : hauteur des icônes en px (les SVG sont dessinés sur une hauteur de 16).
// empile : icônes les unes sous les autres, pour tenir dans une colonne étroite.
// classeBouton : classes d'un bouton d'Aviso à reprendre telles quelles (couleurs, bordure,
// survol) ; couleur, couleurSurvol et opacite sont alors sans effet.
function creerLiensAffaire(numero, { couleur, couleurSurvol, espacement, taille = 16, opacite = 0.75, empile = false, classeBouton = null }) {
  const defs = LIENS_AFFAIRE_DEFS.filter(d => LIENS_AFFAIRE[d.cle] && (!d.windowsSeulement || EST_WINDOWS));
  if (!defs.length) return null;

  const groupe = document.createElement('span');
  groupe.className = AVISO_LIENS_CLASS;
  // En boutons empilés, tous prennent la largeur du plus large, comme une colonne de boutons.
  groupe.style.cssText = `display:inline-flex;flex-direction:${empile ? 'column' : 'row'};` +
    `align-items:${classeBouton && empile ? 'stretch' : 'center'};` +
    `gap:${espacement}px;vertical-align:middle;`;
  defs.forEach(d => {
    const a = document.createElement('a');
    a.href = d.url(numero);
    // search-ms: n'ouvre pas d'onglet mais l'Explorateur : target="_blank" laisserait un onglet vide.
    if (!d.url(numero).startsWith('search-ms:')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.title = d.titre(numero);
    a.setAttribute('aria-label', d.titre(numero));
    if (classeBouton) {
      a.className = classeBouton;
      // Gabarit resserré : le bouton d'Aviso, avec sa hauteur de ligne de texte, ferait plus du
      // double de la hauteur du libellé.
      a.style.cssText = `display:flex;align-items:center;justify-content:center;box-sizing:border-box;` +
        `height:${BOUTON_HAUTEUR}px;padding:0 2px;margin:0;font-family:Arial,sans-serif;` +
        `font-size:${BOUTON_TEXTE}px;font-weight:700;line-height:1;letter-spacing:0.2px;`;
    } else {
      a.style.cssText = `all:unset;cursor:pointer;display:inline-flex;color:${couleur};opacity:${opacite};transition:opacity .15s;`;
    }
    if (classeBouton && d.libelle) {
      // Sur un bouton, le fond bleu délimite déjà l'icône : SGO et ShP s'écrivent en texte, sans
      // le cadre de leur dessin, utile seulement sur un fond nu.
      a.textContent = d.libelle;
    } else {
      a.innerHTML = d.svg;
      const svg = a.firstElementChild;
      const vb = svg.viewBox.baseVal;
      // Empilées, les marges haute et basse du dessin (le cadre SGO/SP va de 2,75 à 13,25 sur 16,
      // le dossier de 3,25 à 13,75) s'additionneraient d'une icône à l'autre : on recadre au plus
      // près, trait compris.
      if (empile || classeBouton) svg.setAttribute('viewBox', `${vb.x} ${ICONE_RECADRAGE.y} ${vb.width} ${ICONE_RECADRAGE.hauteur}`);
      // Sur un bouton, le dessin prend la hauteur du texte des boutons voisins.
      const hauteur = classeBouton ? BOUTON_TEXTE
        : (empile ? ICONE_RECADRAGE.hauteur : 16) * taille / 16;
      const hauteurVue = (empile || classeBouton) ? ICONE_RECADRAGE.hauteur : 16;
      svg.setAttribute('height', hauteur);
      svg.setAttribute('width', vb.width * hauteur / hauteurVue);
    }
    if (!classeBouton) {
      a.addEventListener('mouseenter', () => { a.style.opacity = '1'; a.style.color = couleurSurvol; });
      a.addEventListener('mouseleave', () => { a.style.opacity = String(opacite); a.style.color = couleur; });
    }
    // Ni la ligne du tableau ni la barre ne doivent réagir au clic (ouverture de l'affaire, menu).
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      compterUsage('lien_' + d.cle);
    });
    groupe.appendChild(a);
  });
  return groupe;
}

// La ligne d'affaire ne doit pas grandir à cause des liens : ils sont posés hors du flux
// (position absolue), à droite de la loupe, et la cellule ne leur réserve que la largeur.
// Empilés si la hauteur de la ligne le permet, sinon côte à côte (ligne d'une seule ligne de
// texte). Recalculé au redimensionnement de la fenêtre, qui change le nombre de lignes du libellé.
function disposerLiensListe(actions, liens) {
  if (!actions.dataset.snippetExpanderPadding) {
    actions.dataset.snippetExpanderPadding = getComputedStyle(actions).paddingRight;
  }
  const paddingDroit = parseFloat(actions.dataset.snippetExpanderPadding) || 0;
  const cs = getComputedStyle(actions);
  actions.style.position = 'relative';
  liens.style.position = 'absolute';
  liens.style.top = cs.paddingTop;
  liens.style.right = paddingDroit + 'px';

  // Hauteur disponible : celle de la ligne telle qu'Aviso la dessine, les liens étant hors du flux.
  const disponible = actions.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const nb = liens.children.length;
  const empile = nb * BOUTON_HAUTEUR <= disponible;
  liens.style.flexDirection = empile ? 'column' : 'row';
  liens.style.gap = empile ? '0px' : '2px';
  actions.style.paddingRight = (paddingDroit + liens.offsetWidth + 2) + 'px';
}

let liensListeResizeId = null;
window.addEventListener('resize', () => {
  if (!isAvisoSite()) return;
  clearTimeout(liensListeResizeId);
  liensListeResizeId = setTimeout(() => {
    document.querySelectorAll('td.std_links > .' + AVISO_LIENS_CLASS)
      .forEach(liens => disposerLiensListe(liens.parentNode, liens));
  }, 200);
});

// Le titre de l'affaire n'est pas sélectionnable à la souris, alors que c'est le texte le plus
// souvent recopié de la page — numéro et intitulé partent dans un courriel, une recherche ou un
// nom de fichier. Deux causes possibles, traitées toutes les deux ici : un `user-select: none`
// hérité de la barre, qu'Aviso dessine comme un menu, et le glisser-déposer d'un lien. Si la
// sélection résiste encore, chercher un handler `selectstart` annulé côté Aviso.
// Le même titre copie aussi le numéro d'affaire au clic (#87).
function preparerTitreAffaire(titre) {
  if (titre.dataset.seSelectionnable) return;
  titre.dataset.seSelectionnable = '1';

  // `user-select` s'hérite, mais un descendant peut imposer sa propre valeur : le reste de la
  // barre reste insélectionnable, seul le titre change. `!important` parce que la règle d'Aviso
  // en porte un, qui l'emporterait sinon sur un style en ligne.
  titre.style.setProperty('user-select', 'text', 'important');
  titre.style.setProperty('-webkit-user-select', 'text', 'important');

  // Un lien se glisse au lieu de se sélectionner : sans cela, un cliqué-glissé sur le titre
  // démarre un glisser-déposer du lien et aucune sélection n'a lieu.
  const liens = (titre.matches('a') ? [titre] : []).concat([...titre.querySelectorAll('a')]);
  liens.forEach(a => { a.draggable = false; });

  // Curseur de texte seulement si rien n'est cliquable : sur un lien, il masquerait l'affordance.
  if (!liens.length) titre.style.setProperty('cursor', 'copy');

  // Un clic sur le titre copie le numéro d'affaire (#87). Pas pendant une sélection : un
  // double-clic sur le numéro reste une sélection, et ne doit pas remplacer le presse-papiers
  // par le seul numéro sans que l'utilisateur l'ait demandé.
  titre.addEventListener('click', (e) => {
    // Le titre est lui-même un <a> dans Aviso : seul un lien contenu dans le titre laisse le clic
    // passer. Un `closest('a')` seul renverrait le titre et bloquerait la copie.
    const lien = e.target.closest('a');
    if (lien && lien !== titre) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const numero = numeroAffaire(titre.textContent);
    if (!numero) return;
    e.preventDefault();
    navigator.clipboard.writeText(numero).then(
      () => afficherConfirmationCopie(`Numéro d'affaire ${numero} copié`, titre),
      () => afficherConfirmationCopie('Copie impossible', titre)
    );
  });
}

// Message discret posé sous le titre, qui disparaît seul. Un seul à la fois : le suivant
// remplace celui qui reste.
function afficherConfirmationCopie(message, ancre) {
  document.getElementById('snippet-expander-copie')?.remove();
  const toast = document.createElement('div');
  toast.id = 'snippet-expander-copie';
  toast.textContent = message;
  const rect = ancre.getBoundingClientRect();
  Object.assign(toast.style, {
    position: 'fixed',
    top: `${rect.bottom + 6}px`,
    left: `${rect.left}px`,
    zIndex: '2147483647',
    padding: '4px 8px',
    borderRadius: '4px',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    font: '12px system-ui, sans-serif',
    pointerEvents: 'none',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

function scanLiensAffaire() {
  // Liste Plans Affaires : une affaire par ligne, numéro dans la colonne "N° plan affaire".
  document.querySelectorAll('td[headers="plans_affaires_n_degrees_plan_affaire_th"]').forEach(td => {
    const tr = td.closest('tr');
    const actions = tr && tr.querySelector('td.std_links');
    if (!actions || actions.querySelector('.' + AVISO_LIENS_CLASS)) return;
    const numero = numeroAffaire(td.textContent);
    if (!numero) return;
    // Mêmes classes que la loupe voisine (btn btn-primary) : blanc sur fond bleu, survol
    // compris, identiques par construction. Empilées sans espace, comme un groupe de boutons.
    const liens = creerLiensAffaire(numero, { espacement: 0, empile: true, classeBouton: 'btn btn-primary' });
    if (!liens) return;
    actions.style.whiteSpace = 'nowrap';
    actions.appendChild(liens);
    disposerLiensListe(actions, liens);
  });

  // Barre bleue : le titre de l'affaire ouverte, vide sur les pages sans affaire (la liste).
  const titre = document.getElementById('cur_plan_aff');
  const bar = document.getElementById('main_bar');
  // Hors du bloc des liens, qui n'opère qu'à partir d'un numéro d'affaire : le titre se
  // sélectionne même quand ce numéro est illisible.
  if (titre) preparerTitreAffaire(titre);
  if (titre && bar) {
    const numero = numeroAffaire(titre.textContent);
    const existant = bar.querySelector('.' + AVISO_LIENS_CLASS);
    // Une autre affaire ouverte sans rechargement complet : les liens suivent le nouveau numéro.
    if (existant && existant.dataset.numero !== numero) existant.remove();
    else if (existant) return;
    if (!numero) return;
    // Plus grandes et plus opaques que sur la liste : elles doivent se voir sur le fond bleu, à
    // côté de textes de menu en 14 px.
    const liens = creerLiensAffaire(numero, { couleur: '#ffffff', couleurSurvol: '#ffffff', espacement: 12, taille: 22, opacite: 0.9 });
    if (!liens) return;
    liens.dataset.numero = numero;
    const metier = document.getElementById('metier_header_selector');
    if (metier) {
      // En-tête actuel d'Aviso : à gauche du sélecteur de métier "BTS". Les menus de cette zone
      // sont rangés en flex "row-reverse" (l'ordre affiché est l'inverse de celui de la page) :
      // le côté d'insertion suit le sens réel d'affichage, pour rester à gauche dans les deux cas.
      liens.style.margin = '0 6px 0 14px';
      liens.style.alignSelf = 'center';
      const inverse = getComputedStyle(metier.parentNode).flexDirection === 'row-reverse';
      metier.insertAdjacentElement(inverse ? 'afterend' : 'beforebegin', liens);
    } else {
      // Repli, pour un en-tête sans sélecteur de métier (pages d'avant son apparition) : juste
      // après le titre de l'affaire, qui flotte à gauche dans la barre.
      liens.style.float = 'left';
      liens.style.height = titre.offsetHeight + 'px';
      liens.style.marginLeft = '-1em';
      titre.insertAdjacentElement('afterend', liens);
    }
  }
}

function scanAvisoTable() {
  lierEditeursRiches();
  scanSelecteursAvis();
  const articlesHand = articlesHandParLigne();
  const articlesHab = articlesHabParLigne();
  document.querySelectorAll('td.referentiel.content').forEach(refCell => {
    const tr = refCell.closest('tr');
    const dispoCell = tr && tr.querySelector('td.dispositions');
    if (!dispoCell || !dispoCell.querySelector('textarea.verification')) return;

    const container = dispoCell.querySelector('.dispositions.verif');
    if (!container) return;

    // Sur toutes les lignes, y compris celles dont le Référentiel n'a pas de code.
    insertAvisoClearButton(container, dispoCell);

    const refCode = extractRefCode(refCell.textContent);
    if (!refCode) return;

    const local = LOCAL_SNIPPETS.find(s => triggerToRefCode(s.trigger) === refCode);
    if (local) {
      insertAvisoLocalIcon(container, dispoCell, local);
      insertAvisoEditIcon(container, local);
    } else {
      insertAvisoAddIcon(container, dispoCell, refCode);
    }

    const match = SNIPPETS.find(s => triggerToRefCode(s.trigger) === refCode);
    if (match) insertAvisoIcon(container, dispoCell, match);

    liensReglementairesLigne(refCell.textContent, refCode, articlesHab.get(tr))
      .forEach(lien => insertAvisoLawLink(container, lien));
    // Trame HAND : l'arrêté de la partie de la ligne, sur Légifrance seulement.
    const lienHand = lienLegifranceHand(articlesHand.get(tr));
    if (lienHand) insertAvisoLawLink(container, lienHand);

    const article = IMPORTED_ARTICLES.find(a => a.code === refCode);
    if (article) insertAvisoImportIcon(container, dispoCell, article);
  });

  scanLiensAffaire();
}

let avisoScanTimeoutId = null;
function scheduleAvisoScan() {
  if (avisoScanTimeoutId) clearTimeout(avisoScanTimeoutId);
  avisoScanTimeoutId = setTimeout(scanAvisoTable, 150);
}

// L'intégration est toujours active sur Aviso (le réglage "Intégration Aviso" a été retiré en
// v2.18.0) et reste sans effet sur tout autre site.
if (isAvisoSite()) {
  // Les lignes se chargent/déplient dynamiquement (boutons d'expansion, AJAX) : on réagit à
  // toute modification du DOM plutôt qu'à un seul passage au chargement de la page.
  new MutationObserver(scheduleAvisoScan).observe(document.body, { childList: true, subtree: true });
  // La place des liens de la cellule Remarques dépend de la largeur de la fenêtre.
  window.addEventListener('resize', scheduleAvisoScan);
  scheduleAvisoScan();
}

// ---------- Mode administrateur : clic droit sur un champ de saisie (#119) ----------
// Le menu contextuel n'existe qu'en mode administrateur (background.js, majMenusAdmin). Sur
// n'importe quel site, il ouvre une fenêtre de création : snippet du Clausier Personnel, ou
// proposition au Clausier Commun. Une proposition ne va jamais directement dans le Clausier
// Commun : elle arrive dans la revue du tableau, marquée « proposé par le garant », et n'est
// appliquée que par « Appliquer les décisions » (invariant 1).
//
// Contenu proposé : le texte sélectionné, sinon ce que contient le champ cliqué. Rien n'est
// écrit dans le champ : la fenêtre ne fait que lire la page.

let champClicDroit = null;
document.addEventListener('contextmenu', (e) => {
  const cible = e.target instanceof Element ? e.target : null;
  champClicDroit = cible && cible.closest('textarea, input, [contenteditable]:not([contenteditable="false"])');
}, true);

function texteDuChamp(champ) {
  if (!champ) return '';
  if (champ.matches('textarea, input')) return champ.value || '';
  return champ.innerText || '';
}

function ouvrirCreationClicDroit(mode, selection, jeton, triggerInitial = '') {
  if (document.getElementById(AVISO_EDITOR_ID)) return;
  const commun = mode === 'commun';
  const contenuInitial = (selection || '').trim() ? selection : texteDuChamp(champClicDroit);

  const host = document.createElement('div');
  host.id = AVISO_EDITOR_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${AVISO_EDITOR_CSS}
    .fenetre.commun { border-top-color: #2d51b2; }
    .commun .enregistrer { background: #2d51b2; color: #ffffff; }
    .commun .enregistrer:hover { background: #1f3d8f; }
    label { font-size: 12.5px; font-weight: 600; }
    input[type="text"] { width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #c3cdea;
      border-radius: 8px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13.5px; }
    .case { display: flex; align-items: center; gap: 6px; font-weight: 400; }
    .case[hidden] { display: none; }
    </style>
    <div class="fond">
      <div class="fenetre${commun ? ' commun' : ''}" role="dialog" aria-modal="true" aria-labelledby="titre">
        <h2 id="titre">${commun ? 'Proposer au Clausier Commun' : 'Créer un snippet personnel'}</h2>
        <p class="aide">${commun
          ? 'La proposition arrive dans la revue du tableau, en tête et marquée « proposé par le garant ». Elle n\'entre dans le Clausier Commun qu\'avec « Appliquer les décisions ».'
          : 'Clausier Personnel : ce snippet est enregistré dans ce navigateur uniquement, et se déclenche au clavier sur toute page.'}
          Ctrl+Entrée pour enregistrer, Échap pour annuler.</p>
        <label for="declencheur">Déclencheur</label>
        <input type="text" id="declencheur" placeholder="/exemple" spellcheck="false" autocomplete="off" />
        <label for="contenu">Texte</label>
        <textarea id="contenu" spellcheck="true"></textarea>
        <label class="case" ${commun ? '' : 'hidden'}><input type="checkbox" id="aussi-perso" checked /> L'ajouter aussi à mon Clausier Personnel, pour m'en servir dès maintenant</label>
        <p class="erreur" hidden></p>
        <div class="actions">
          <span class="espace"></span>
          <button type="button" class="annuler">Annuler</button>
          <button type="button" class="enregistrer">${commun ? 'Proposer' : 'Enregistrer'}</button>
        </div>
      </div>
    </div>`;

  const champTrigger = root.getElementById('declencheur');
  const textarea = root.getElementById('contenu');
  const aussiPerso = root.getElementById('aussi-perso');
  const erreurEl = root.querySelector('.erreur');
  const btnEnregistrer = root.querySelector('.enregistrer');
  textarea.value = contenuInitial || '';
  champTrigger.value = triggerInitial;

  ['keydown', 'keyup', 'keypress', 'input', 'click', 'mousedown', 'mouseup'].forEach(type => {
    host.addEventListener(type, (e) => e.stopPropagation());
  });

  const fermer = () => host.remove();
  const afficherErreur = (message) => { erreurEl.textContent = message; erreurEl.hidden = false; };
  const annuler = () => {
    if ((textarea.value !== (contenuInitial || '') || champTrigger.value.trim() !== triggerInitial) &&
        !confirm('Abandonner ce snippet ?')) return;
    fermer();
  };

  const enregistrer = async () => {
    const trigger = champTrigger.value.trim();
    const contenu = textarea.value;
    if (!trigger) { afficherErreur('Saisissez un déclencheur, par exemple /gn4.'); champTrigger.focus(); return; }
    if (/\s/.test(trigger)) { afficherErreur('Le déclencheur ne doit pas contenir d\'espace.'); champTrigger.focus(); return; }
    if (!contenu.trim()) { afficherErreur('Le texte est vide.'); textarea.focus(); return; }
    btnEnregistrer.disabled = true;
    try {
      if (!commun || aussiPerso.checked) {
        // Un snippet personnel existant n'est jamais remplacé sans accord.
        const existant = LOCAL_SNIPPETS.find(s => s.trigger === trigger);
        if (existant && existant.content !== contenu &&
            !confirm(`Le snippet "${trigger}" existe déjà dans votre Clausier Personnel. Le remplacer ?`)) {
          btnEnregistrer.disabled = false;
          return;
        }
      }
      if (commun) {
        const rep = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'ADMIN', demande: 'proposer', jeton, trigger, content: contenu },
            (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r));
        });
        if (!rep || !rep.ok) throw new Error((rep && rep.error) || 'pas de réponse');
      }
      if (!commun || aussiPerso.checked) await enregistrerSnippetLocal(trigger, contenu);
      // Le champ cliqué est retenu : à chaque retour sur cette page, il portera les icônes du
      // déclencheur (voir « Champs retenus » plus bas), le « + » tant qu'il n'y a pas de snippet
      // personnel, et l'icône bleue dès que la proposition est adoptée dans le Clausier Commun.
      if (champClicDroit) await retenirChamp(champClicDroit, trigger).catch(() => {});
      fermer();
    } catch (err) {
      btnEnregistrer.disabled = false;
      afficherErreur(/context invalidated/i.test(err && err.message)
        ? "L'extension a été mise à jour : rechargez la page, puis recommencez."
        : `${commun ? 'Proposition' : 'Enregistrement'} impossible : ${err && err.message}`);
    }
  };

  btnEnregistrer.addEventListener('click', enregistrer);
  root.querySelector('.annuler').addEventListener('click', annuler);
  root.querySelector('.fenetre').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); annuler(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enregistrer(); }
  });

  document.body.appendChild(host);
  if (triggerInitial) textarea.focus();
  else champTrigger.focus();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'DATAVISO_CLIC_DROIT' || sender.id !== chrome.runtime.id) return;
  ouvrirCreationClicDroit(msg.mode, msg.selection, msg.jeton);
  sendResponse({ ok: true });
});


// ---------- Mode administrateur : champs retenus (#119) ----------
// Un champ où le garant a créé un snippet au clic droit est retenu (storage.local, clé
// champsRetenus : page, sélecteur du champ, déclencheurs). À chaque retour sur la page, une
// petite rangée flotte au coin haut droit du champ, avec les icônes d'Aviso pour chaque
// déclencheur : « + » gris ou jaune (Clausier Personnel), puis bleue (Clausier Commun). Un clic
// AJOUTE le snippet à la fin du champ, sans rien remplacer (même règle que dans Aviso). Le ✕,
// au survol, oublie le champ. Rien ne s'affiche hors du mode administrateur.
//
// La rangée vit dans un Shadow DOM posé sur <body>, en position absolue, et non dans la page à
// côté du champ : insérée dans la mise en page d'un site inconnu, elle la décalerait ou serait
// rognée par un conteneur. Elle suit le champ (défilement, redimensionnement, contrôle régulier)
// et disparaît quand il n'est plus visible.

const CHAMPS_RETENUS_MAX = 200;
const CHAMP_HOTE_ATTR = 'data-dataviso-champ-retenu';
let CHAMPS_RETENUS = [];
let MODE_ADMIN = false;
const hotesChamps = new Map(); // champ -> { hote, triggers }

function cleDePage() {
  return location.origin + location.pathname;
}

function echapperCss(v) {
  return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
}

// Sélecteur stable du champ : son id, sinon son name, sinon un chemin de :nth-of-type depuis le
// plus proche ancêtre à id (ou <body>). Retenu seulement s'il désigne ce champ et lui seul.
function selecteurDuChamp(champ) {
  const unique = (sel) => {
    try { const r = document.querySelectorAll(sel); return r.length === 1 && r[0] === champ; } catch { return false; }
  };
  if (champ.id && unique('#' + echapperCss(champ.id))) return '#' + echapperCss(champ.id);
  const nom = champ.getAttribute('name');
  const tag = champ.tagName.toLowerCase();
  if (nom && unique(`${tag}[name="${echapperCss(nom)}"]`)) return `${tag}[name="${echapperCss(nom)}"]`;
  const etapes = [];
  let el = champ;
  while (el && el !== document.body && el.nodeType === 1) {
    if (el !== champ && el.id) { etapes.unshift('#' + echapperCss(el.id)); break; }
    const t = el.tagName.toLowerCase();
    const freres = el.parentElement ? [...el.parentElement.children].filter(x => x.tagName === el.tagName) : [];
    etapes.unshift(freres.length > 1 ? `${t}:nth-of-type(${freres.indexOf(el) + 1})` : t);
    el = el.parentElement;
  }
  if (!etapes[0] || !etapes[0].startsWith('#')) etapes.unshift('body');
  const sel = etapes.join(' > ');
  return unique(sel) ? sel : null;
}

async function retenirChamp(champ, trigger) {
  // Une cellule « Dispositions réalisées » d'Aviso a déjà ses icônes.
  if (isAvisoSite() && champ.matches('textarea.verification')) return;
  const selecteur = selecteurDuChamp(champ);
  if (!selecteur) return;
  const page = cleDePage();
  const { champsRetenus } = await chrome.storage.local.get(['champsRetenus']);
  const liste = (champsRetenus || []).slice();
  let entree = liste.find(c => c.page === page && c.selecteur === selecteur);
  if (!entree) {
    entree = { page, selecteur, triggers: [] };
    liste.push(entree);
  }
  if (!entree.triggers.includes(trigger)) entree.triggers.push(trigger);
  entree.vu = new Date().toISOString();
  // Les plus anciens partent d'abord : la liste ne grossit pas sans fin.
  liste.sort((x, y) => String(y.vu).localeCompare(String(x.vu)));
  await chrome.storage.local.set({ champsRetenus: liste.slice(0, CHAMPS_RETENUS_MAX) });
}

async function oublierChamp(selecteur) {
  const page = cleDePage();
  const { champsRetenus } = await chrome.storage.local.get(['champsRetenus']);
  await chrome.storage.local.set({
    champsRetenus: (champsRetenus || []).filter(c => !(c.page === page && c.selecteur === selecteur))
  });
}

// Ajoute le texte à la fin du champ, séparé de l'existant par un saut de ligne (une espace dans
// un <input>), puis signale la saisie comme une frappe pour que le site l'enregistre.
function ajouterAuChamp(champ, texte) {
  if (champ.matches('textarea, input')) {
    const avant = champ.value || '';
    const sep = !avant ? '' : champ.tagName === 'INPUT' ? (/\s$/.test(avant) ? '' : ' ') : (avant.endsWith('\n') ? '' : '\n');
    const ajout = champ.tagName === 'INPUT' ? texte.replace(/\s*\n\s*/g, ' ') : texte;
    setNativeValue(champ, avant + sep + ajout);
    champ.dispatchEvent(new Event('input', { bubbles: true }));
    champ.dispatchEvent(new Event('change', { bubbles: true }));
    champ.focus();
    const fin = champ.value.length;
    try { champ.setSelectionRange(fin, fin); } catch { /* type sans sélection */ }
  } else {
    champ.focus();
    const sel = window.getSelection();
    const plage = document.createRange();
    plage.selectNodeContents(champ);
    plage.collapse(false);
    sel.removeAllRanges();
    sel.addRange(plage);
    const avant = champ.innerText || '';
    const texteFinal = (avant.trim() && !avant.endsWith('\n') ? '\n' : '') + texte;
    // insertText garde l'historique d'annulation et prévient les éditeurs riches ; repli DOM sinon.
    if (!document.execCommand('insertText', false, texteFinal)) {
      champ.appendChild(document.createTextNode(texteFinal));
      champ.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

// Mêmes icônes que dans Aviso (icons/add16.svg, icons/local16.svg, et le logo bleu de
// icons/icon16.png redessiné en SVG), écrites ici plutôt que chargées : un fichier de l'extension
// ne s'affiche sur un site que s'il est déclaré « web accessible » pour ce site, et l'ouvrir à
// tous les sites laisserait n'importe quelle page détecter l'extension. Tout changement d'une
// icône se reporte ici.
const ICONE_CHAMP_PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="7" fill="#ffffff" stroke="#5b6a8f" stroke-width="1.5"/>' +
  '<path d="M8 4.75v6.5M4.75 8h6.5" stroke="#5b6a8f" stroke-width="1.5" stroke-linecap="round"/></svg>';
const iconeChampLogo = (fond, trait) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  `<rect x="0.5" y="0.5" width="15" height="15" rx="2.5" fill="${fond}"/>` +
  `<path d="M4.5 5v6M1.75 8h5.5" stroke="${trait}" stroke-width="1.6" stroke-linecap="round"/>` +
  `<path d="M9.25 8h4.5M11.75 5.75 13.9 8l-2.15 2.25" fill="none" stroke="${trait}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICONE_CHAMP_PERSO = iconeChampLogo('#f2b705', '#3d2e00');
const ICONE_CHAMP_COMMUN = iconeChampLogo('#2d51b2', '#ffffff');

const CHAMP_CSS = `
  :host { all: initial; }
  .rangee { position: absolute; display: flex; gap: 4px; align-items: center; z-index: 2147483646;
    padding: 2px 3px; background: rgba(255, 255, 255, 0.92); border-radius: 5px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); }
  .groupe { display: flex; gap: 3px; }
  .groupe + .groupe { padding-left: 4px; border-left: 1px solid #dde3f3; }
  button { all: unset; cursor: pointer; display: inline-flex; }
  button svg { display: block; }
  .oublier { color: #5b6a8f; font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    line-height: 16px; padding: 0 2px; display: none; }
  .rangee:hover .oublier { display: inline-flex; }
  .oublier:hover { color: #b3261e; }
`;

// Rapprochement des déclencheurs commun et personnel : comme cleDeclencheur_ dans Code.gs, sans
// tenir compte de la casse, des espaces ni du préfixe (« /gn4 » = « GN4 »).
function cleTrigger(t) {
  return String(t || '').replace(/^[\/;:!]+/, '').replace(/\s+/g, '').toUpperCase();
}

function construireRangee(champ, entree) {
  // Pour chaque déclencheur, comme dans Aviso : le « + » gris OU l'icône jaune (jamais les deux),
  // puis l'icône bleue s'il existe un snippet commun de même déclencheur.
  const groupes = entree.triggers.map(trigger => ({
    trigger,
    perso: LOCAL_SNIPPETS.find(x => x.trigger === trigger),
    commun: SNIPPETS.find(x => cleTrigger(x.trigger) === cleTrigger(trigger))
  }));
  const signature = groupes.map(g => `${g.trigger}:${g.perso ? 1 : 0}${g.commun ? 1 : 0}`).join('|');
  const existant = hotesChamps.get(champ);
  if (existant && existant.signature === signature) return;
  if (existant) existant.hote.remove();
  hotesChamps.delete(champ);
  if (!groupes.length) return;

  const hote = document.createElement('div');
  hote.setAttribute(CHAMP_HOTE_ATTR, '');
  const root = hote.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CHAMP_CSS}</style><div class="rangee"></div>`;
  const rangee = root.querySelector('.rangee');

  const bouton = (svg, titre, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = svg;
    b.addEventListener('mouseenter', () => { b.title = titre(); });
    b.addEventListener('mousedown', (e) => e.preventDefault()); // garde le focus du champ
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); action(); });
    return b;
  };
  // Le snippet est relu au clic (et l'infobulle au survol) : il a pu changer depuis la pose.
  const inserer = (trouver, cle) => () => {
    const snippet = trouver();
    if (!snippet) return;
    ajouterAuChamp(champ, resolveContent(snippet.content));
    compterUsage(cle);
  };
  const apercu = (libelle, trouver, trigger) => () => {
    const snippet = trouver();
    return snippet ? `${libelle} "${trigger}" :\n${tronquerPourInfobulle(resolveContent(snippet.content))}` : '';
  };

  groupes.forEach(g => {
    const groupe = document.createElement('span');
    groupe.className = 'groupe';
    const trouverPerso = () => LOCAL_SNIPPETS.find(x => x.trigger === g.trigger);
    const trouverCommun = () => SNIPPETS.find(x => cleTrigger(x.trigger) === cleTrigger(g.trigger));
    if (g.perso) {
      groupe.appendChild(bouton(ICONE_CHAMP_PERSO,
        apercu('Ajouter le contenu du snippet du Clausier Personnel', trouverPerso, g.trigger),
        inserer(trouverPerso, 'admin_champ_perso')));
    } else {
      groupe.appendChild(bouton(ICONE_CHAMP_PLUS,
        () => `Créer le snippet "${g.trigger}" dans le Clausier Personnel, à partir du texte de ce champ`,
        () => {
          champClicDroit = champ;
          ouvrirCreationClicDroit('perso', '', null, g.trigger);
          compterUsage('admin_champ_plus');
        }));
    }
    if (g.commun) {
      groupe.appendChild(bouton(ICONE_CHAMP_COMMUN,
        apercu('Ajouter le contenu du snippet du Clausier Commun', trouverCommun, g.trigger),
        inserer(trouverCommun, 'admin_champ_commun')));
    }
    rangee.appendChild(groupe);
  });

  const oublier = document.createElement('button');
  oublier.type = 'button';
  oublier.className = 'oublier';
  oublier.textContent = '✕';
  oublier.title = 'Ne plus proposer de snippet sur ce champ (les snippets restent dans les clausiers)';
  oublier.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    oublierChamp(entree.selecteur).catch(() => {});
    compterUsage('admin_champ_oubli');
  });
  rangee.appendChild(oublier);
  ['keydown', 'keyup', 'keypress', 'input', 'click', 'mousedown', 'mouseup'].forEach(type => {
    hote.addEventListener(type, (e) => e.stopPropagation());
  });
  document.body.appendChild(hote);
  hotesChamps.set(champ, { hote, rangee, signature });
  placerRangee(champ);
}

function placerRangee(champ) {
  const h = hotesChamps.get(champ);
  if (!h) return;
  const r = champ.getBoundingClientRect();
  const visible = champ.isConnected && r.width > 0 && r.height > 0 && getComputedStyle(champ).visibility !== 'hidden';
  h.rangee.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  const largeur = h.rangee.offsetWidth;
  // Au-dessus du coin haut droit du champ, sans sortir de la fenêtre.
  const x = Math.max(window.scrollX + 2, window.scrollX + r.right - largeur);
  const y = Math.max(window.scrollY + 2, window.scrollY + r.top - 20);
  h.rangee.style.left = `${x}px`;
  h.rangee.style.top = `${y}px`;
}

function placerRangees() {
  hotesChamps.forEach((h, champ) => {
    if (!champ.isConnected) { h.hote.remove(); hotesChamps.delete(champ); return; }
    placerRangee(champ);
  });
}

function scanChampsRetenus() {
  const page = cleDePage();
  const entrees = MODE_ADMIN ? CHAMPS_RETENUS.filter(c => c.page === page) : [];
  const vus = new Set();
  entrees.forEach(entree => {
    let champ = null;
    try { champ = document.querySelector(entree.selecteur); } catch { /* sélecteur devenu invalide */ }
    if (!champ) return;
    vus.add(champ);
    construireRangee(champ, entree);
  });
  hotesChamps.forEach((h, champ) => {
    if (!vus.has(champ)) { h.hote.remove(); hotesChamps.delete(champ); }
  });
  placerRangees();
}

let champsObservateur = null;
let champsMinuterie = null;
let champsAttente = null;
function scheduleScanChamps() {
  clearTimeout(champsAttente);
  champsAttente = setTimeout(scanChampsRetenus, 300);
}

// N'observe la page (MutationObserver, contrôle régulier de la position) que si elle a des champs
// retenus et que le mode administrateur est actif : sur toute autre page, rien ne tourne.
function majSuiviChamps() {
  const actif = MODE_ADMIN && CHAMPS_RETENUS.some(c => c.page === cleDePage());
  if (actif && !champsObservateur) {
    champsObservateur = new MutationObserver((mutations) => {
      // Nos propres rangées ne relancent pas le scan.
      if (mutations.every(m => [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.hasAttribute && n.hasAttribute(CHAMP_HOTE_ATTR)))) return;
      scheduleScanChamps();
    });
    champsObservateur.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', placerRangees, true);
    window.addEventListener('resize', placerRangees);
    champsMinuterie = setInterval(placerRangees, 1000);
  } else if (!actif && champsObservateur) {
    champsObservateur.disconnect();
    champsObservateur = null;
    window.removeEventListener('scroll', placerRangees, true);
    window.removeEventListener('resize', placerRangees);
    clearInterval(champsMinuterie);
  }
  scanChampsRetenus();
}

function chargerChampsRetenus() {
  chrome.storage.local.get(['champsRetenus', 'adminCode'], (r) => {
    CHAMPS_RETENUS = r.champsRetenus || [];
    MODE_ADMIN = !!r.adminCode;
    majSuiviChamps();
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.champsRetenus || changes.adminCode) chargerChampsRetenus();
  // Les deux clausiers sont relus par le listener du haut : on reconstruit à la passe suivante.
  else if (changes.localSnippets || changes.snippets) scheduleScanChamps();
});
if (document.body) chargerChampsRetenus();
else document.addEventListener('DOMContentLoaded', chargerChampsRetenus);
