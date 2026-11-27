// statistiques.js — page de statistiques du mode administrateur (#119)
//
// Les données viennent du script Apps Script (demande « statistiques » du mode administrateur,
// relayée par background.js qui y joint le code) : des totaux par jour et par semaine, jamais les
// lignes d'un utilisateur. Graphiques en SVG écrits à la main : l'extension n'a aucune dépendance.
// Une seule série par graphique, donc une seule couleur (l'accent de l'extension) ; deux mesures
// d'échelles différentes vont dans deux graphiques, jamais sur deux axes.

const SVG_NS = 'http://www.w3.org/2000/svg';
let donnees = null;
let periode = 30;

function compterUsage(cle) {
  chrome.runtime.sendMessage({ type: 'STAT', cle }, () => void chrome.runtime.lastError);
}
compterUsage('admin_statistiques');

const nf = new Intl.NumberFormat('fr-FR');
const fmt = (n) => nf.format(n);

function el(nom, attributs = {}, parent) {
  const e = document.createElementNS(SVG_NS, nom);
  Object.entries(attributs).forEach(([k, v]) => e.setAttribute(k, v));
  if (parent) parent.appendChild(e);
  return e;
}

// Date locale « AAAA-MM-JJ », comme jourLocal() de background.js.
function jourLocal(d) {
  const n = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${n(d.getMonth() + 1)}-${n(d.getDate())}`;
}
function jourCourt(iso) {
  const [, m, j] = iso.split('-');
  return `${j}/${m}`;
}

// Graduation « ronde » : 1, 2 ou 5 × 10^n, pour 4 lignes de grille environ.
function pasGraduation(max) {
  if (max <= 4) return 1;
  const brut = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(brut)));
  return [1, 2, 5, 10].map(k => k * p).find(k => k >= brut);
}

// ---------- Infobulle ----------
const infobulle = document.getElementById('infobulle');
function montrerInfobulle(evt, texte) {
  infobulle.textContent = texte;
  infobulle.hidden = false;
  const marge = 12;
  const largeur = infobulle.offsetWidth, hauteur = infobulle.offsetHeight;
  let x = evt.clientX + marge, y = evt.clientY - hauteur - marge;
  if (x + largeur > window.innerWidth - 8) x = evt.clientX - largeur - marge;
  if (y < 8) y = evt.clientY + marge;
  infobulle.style.left = `${x}px`;
  infobulle.style.top = `${y}px`;
}
function cacherInfobulle() { infobulle.hidden = true; }

// Barres verticales ancrées à zéro, extrémité haute arrondie (4 px), 2 px d'écart entre barres.
// La zone de survol couvre toute la hauteur de la colonne : une barre basse reste facile à viser.
function barresVerticales(conteneur, points, unite) {
  conteneur.textContent = '';
  if (!points.length || points.every(p => !p.valeur)) {
    conteneur.innerHTML = '<div class="vide">Aucune donnée sur la période.</div>';
    return;
  }
  const L = Math.max(conteneur.clientWidth, 280), H = 200;
  const m = { haut: 16, droite: 4, bas: 24, gauche: 36 };
  const l = L - m.gauche - m.droite, h = H - m.haut - m.bas;
  const max = Math.max(...points.map(p => p.valeur), 1);
  const pas = pasGraduation(max);
  const plafond = Math.ceil(max / pas) * pas;
  const svg = el('svg', { viewBox: `0 0 ${L} ${H}`, role: 'img' }, conteneur);
  for (let v = 0; v <= plafond; v += pas) {
    const y = m.haut + h - (v / plafond) * h;
    el('line', { x1: m.gauche, x2: L - m.droite, y1: y, y2: y, class: v ? 'grille' : 'axe' }, svg);
    el('text', { x: m.gauche - 6, y: y + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  const col = l / points.length;
  const ecart = Math.min(2, col * 0.2);
  const largeur = Math.max(col - ecart, 1);
  // Une étiquette d'abscisse sur n, pour qu'elles ne se chevauchent pas (≈ 44 px chacune).
  const tous = Math.max(1, Math.ceil(44 / col));
  points.forEach((p, i) => {
    const x = m.gauche + i * col + ecart / 2;
    const hb = (p.valeur / plafond) * h;
    const g = el('g', {}, svg);
    const cible = el('rect', { x: m.gauche + i * col, y: m.haut, width: col, height: h, class: 'cible' }, g);
    if (hb > 0) {
      const r = Math.min(4, largeur / 2, hb);
      const y0 = m.haut + h, y1 = y0 - hb;
      el('path', {
        class: 'barre',
        d: `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + largeur - r} Q${x + largeur},${y1} ${x + largeur},${y1 + r} V${y0} Z`
      }, g);
    }
    if (i % tous === 0) {
      el('text', { x: m.gauche + i * col + col / 2, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = p.court;
    }
    cible.addEventListener('mousemove', (e) => { g.classList.add('survol'); montrerInfobulle(e, `${p.libelle} : ${fmt(p.valeur)} ${unite}`); });
    cible.addEventListener('mouseleave', () => { g.classList.remove('survol'); cacherInfobulle(); });
  });
  // Le maximum seul est étiqueté sur la barre : le reste se lit au survol.
  const iMax = points.findIndex(p => p.valeur === max);
  if (iMax >= 0) {
    el('text', {
      x: m.gauche + iMax * col + col / 2, y: m.haut + h - (max / plafond) * h - 4,
      'text-anchor': 'middle', class: 'valeur-barre'
    }, svg).textContent = fmt(max);
  }
}

// Barres horizontales triées, libellé à gauche et valeur en bout de barre.
function barresHorizontales(conteneur, items, unite) {
  conteneur.textContent = '';
  const visibles = items.filter(i => i.valeur > 0);
  if (!visibles.length) {
    conteneur.innerHTML = '<div class="vide">Aucune donnée.</div>';
    return;
  }
  const L = Math.max(conteneur.clientWidth, 280);
  const ligne = 26, epaisseur = 14;
  const gauche = Math.min(240, L * 0.45), droite = 48;
  const H = visibles.length * ligne + 4;
  const max = Math.max(...visibles.map(i => i.valeur));
  const svg = el('svg', { viewBox: `0 0 ${L} ${H}`, role: 'img' }, conteneur);
  visibles.forEach((it, k) => {
    const y = k * ligne + (ligne - epaisseur) / 2;
    const w = Math.max((it.valeur / max) * (L - gauche - droite), 2);
    const g = el('g', {}, svg);
    const cible = el('rect', { x: 0, y: k * ligne, width: L, height: ligne, class: 'cible' }, g);
    const r = Math.min(4, w / 2);
    el('path', {
      class: 'barre',
      d: `M${gauche},${y} H${gauche + w - r} Q${gauche + w},${y} ${gauche + w},${y + r} V${y + epaisseur - r} Q${gauche + w},${y + epaisseur} ${gauche + w - r},${y + epaisseur} H${gauche} Z`
    }, g);
    const lib = el('text', { x: gauche - 8, y: y + epaisseur - 3, 'text-anchor': 'end' }, svg);
    // Coupé à la place disponible (≈ 6 px par caractère en 11 px) ; l'infobulle donne le libellé entier.
    const maxCar = Math.max(8, Math.floor((gauche - 10) / 6));
    lib.textContent = it.libelle.length > maxCar ? it.libelle.slice(0, maxCar - 1) + '…' : it.libelle;
    el('text', { x: gauche + w + 6, y: y + epaisseur - 3, class: 'valeur-barre' }, svg).textContent = fmt(it.valeur);
    cible.addEventListener('mousemove', (e) => { g.classList.add('survol'); montrerInfobulle(e, `${it.libelle} : ${fmt(it.valeur)} ${unite}`); });
    cible.addEventListener('mouseleave', () => { g.classList.remove('survol'); cacherInfobulle(); });
  });
}

// ---------- Rendu ----------
function rendre() {
  if (!donnees) return;
  const d = donnees;
  const aujourdhui = d.aujourdhui || jourLocal(new Date());
  const debut = jourLocal(new Date(Date.now() - (periode - 1) * 86400000));
  const jours = (d.jours || []).filter(j => j.date >= debut && j.date <= aujourdhui);
  const totaux = {};
  jours.forEach(j => Object.entries(j.totaux || {}).forEach(([k, n]) => { totaux[k] = (totaux[k] || 0) + n; }));
  const usages = Object.values(totaux).reduce((a, b) => a + b, 0);
  const p = (d.periodes || {})[periode] || { installes: 0, actifs: 0, nouveaux: 0 };

  const tuiles = [
    [p.installes, 'postes en service', 'Extension ouverte au moins un jour de la période'],
    [p.actifs, 'utilisateurs actifs', 'Au moins une fonction utilisée dans la période'],
    [p.nouveaux, 'nouvelles installations', 'Premier envoi de statistiques dans la période'],
    [usages, 'utilisations', 'Total des fonctions comptées']
  ];
  const zone = document.getElementById('tuiles');
  zone.textContent = '';
  tuiles.forEach(([v, libelle, aide]) => {
    const t = document.createElement('div');
    t.className = 'tuile';
    t.title = aide;
    t.innerHTML = '<div class="valeur"></div><div class="libelle"></div>';
    t.querySelector('.valeur').textContent = fmt(v);
    t.querySelector('.libelle').textContent = libelle;
    zone.appendChild(t);
  });

  // Utilisations : par jour jusqu'à 90 jours, par semaine au-delà (365 barres seraient illisibles).
  const parJour = {};
  jours.forEach(j => { parJour[j.date] = Object.values(j.totaux || {}).reduce((a, b) => a + b, 0); });
  let points;
  if (periode <= 90) {
    points = [];
    for (let i = periode - 1; i >= 0; i--) {
      const iso = jourLocal(new Date(Date.now() - i * 86400000));
      const date = new Date(iso + 'T12:00:00');
      points.push({ court: jourCourt(iso), libelle: date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }), valeur: parJour[iso] || 0 });
    }
    document.getElementById('titre-usage').textContent = 'Utilisations par jour';
  } else {
    const semaines = (d.semaines || []).filter(s => s.cle >= jourLocal(new Date(Date.now() - (periode + 6) * 86400000)));
    points = semaines.map(s => {
      const fin = jourLocal(new Date(new Date(s.cle + 'T12:00:00').getTime() + 6 * 86400000));
      const v = Object.keys(parJour).filter(k => k >= s.cle && k <= fin).reduce((t, k) => t + parJour[k], 0);
      return { court: jourCourt(s.cle), libelle: s.libelle, valeur: v };
    });
    document.getElementById('titre-usage').textContent = 'Utilisations par semaine';
  }
  barresVerticales(document.getElementById('graphe-usage'), points, 'utilisations');

  // Semaines : au moins les 8 dernières, pour qu'une tendance se lise même sur 7 ou 30 jours.
  const nbSemaines = Math.max(8, Math.ceil(periode / 7));
  const semaines = (d.semaines || []).slice(-nbSemaines);
  barresVerticales(document.getElementById('graphe-actifs'),
    semaines.map(s => ({ court: jourCourt(s.cle), libelle: s.libelle, valeur: s.actifs })), 'utilisateurs actifs');
  barresVerticales(document.getElementById('graphe-nouveaux'),
    semaines.map(s => ({ court: jourCourt(s.cle), libelle: s.libelle, valeur: s.nouveaux })), 'nouvelles installations');

  // Fonctions principales : les regroupements de la synthèse du tableau (STATS_REGROUPEMENTS).
  const regroupements = (d.regroupements || []).map(([libelle, cles]) => ({
    libelle, valeur: cles.reduce((t, c) => t + (totaux[c] || 0), 0)
  })).sort((a, b) => b.valeur - a.valeur);
  barresHorizontales(document.getElementById('graphe-fonctions'), regroupements, 'utilisations');

  const versions = Object.entries(d.versions || {}).map(([v, n]) => ({ libelle: `v${v}`, valeur: n, v }))
    .sort((a, b) => b.v.localeCompare(a.v, 'fr', { numeric: true }));
  barresHorizontales(document.getElementById('graphe-versions'), versions, 'postes');

  const libelles = d.libelles || {};
  const corps = document.getElementById('detail');
  corps.textContent = '';
  const lignes = Object.entries(totaux).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  if (!lignes.length) {
    corps.innerHTML = '<tr><td colspan="2" class="hint">Aucune utilisation sur la période.</td></tr>';
  }
  lignes.forEach(([cle, n]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td class="nombre"></td>';
    tr.cells[0].textContent = libelles[cle] || cle;
    tr.cells[0].title = cle;
    tr.cells[1].textContent = fmt(n);
    corps.appendChild(tr);
  });
}

function charger() {
  const statut = document.getElementById('statut');
  statut.textContent = '⏳ Lecture du tableau…';
  chrome.runtime.sendMessage({ type: 'ADMIN', demande: 'statistiques' }, (rep) => {
    if (chrome.runtime.lastError || !rep || !rep.ok) {
      statut.textContent = `❌ ${(rep && rep.error) || 'Pas de réponse de l\'extension'}. Le mode administrateur doit être actif (Paramètres avancés).`;
      return;
    }
    donnees = rep;
    const jours = rep.jours || [];
    statut.textContent = jours.length
      ? `Données du ${new Date(jours[0].date + 'T12:00:00').toLocaleDateString('fr-FR')} au ${new Date(jours[jours.length - 1].date + 'T12:00:00').toLocaleDateString('fr-FR')}, conservées ${rep.conservationMois || 24} mois. Lues le ${new Date().toLocaleString('fr-FR')}.`
      : 'Aucune statistique reçue pour l\'instant.';
    rendre();
  });
}

document.querySelectorAll('[data-periode]').forEach(b => b.addEventListener('click', () => {
  periode = Number(b.dataset.periode);
  document.querySelectorAll('[data-periode]').forEach(x => x.classList.toggle('actif', x === b));
  rendre();
}));
document.getElementById('actualiser').addEventListener('click', charger);
let attenteResize;
window.addEventListener('resize', () => { clearTimeout(attenteResize); attenteResize = setTimeout(rendre, 150); });

charger();
