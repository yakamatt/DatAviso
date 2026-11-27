// tutoriel.js — tutoriel sur une seule page : démonstration de la frappe et fermeture.
// Ouvert par background.js à l'installation initiale (jamais à une mise à jour),
// ou depuis le lien « Tutoriel » du popup. Les visuels sont des maquettes HTML avec les vraies
// icônes de l'extension : à mettre à jour avec elles quand une icône ou un comportement change.
// Volontairement réduit à l'essentiel (#120) : les clausiers et les améliorations d'Aviso. Le
// bouton d'effacement et les boutons d'avis n'y figurent pas, par choix.

// Fermer l'onglet : window.close() est refusé sur un onglet que l'utilisateur a pu ouvrir
// lui-même ; chrome.tabs.remove sur son propre onglet ne demande aucune permission.
function fermer() {
  chrome.tabs.getCurrent((tab) => {
    if (tab) chrome.tabs.remove(tab.id);
    else window.close();
  });
}
document.getElementById('passer').addEventListener('click', fermer);
document.getElementById('terminer').addEventListener('click', fermer);

// ---------- Démonstration de la frappe ----------
// Tape le déclencheur lettre par lettre, marque la pause, puis le remplace par le texte, en
// boucle. La page étant unique, l'animation ne tourne que lorsque l'exemple est à l'écran.
const DEMO_DECLENCHEUR = '/GN4';
const DEMO_PREFIXE = 'Visite du 12/03 : ';
const DEMO_TEXTE = 'Les dispositions prévues pour l\'adaptation des règles de sécurité ont été vérifiées ' +
  'sur place et sont conformes au dossier.';
const demoZone = document.getElementById('demo-frappe');
const demoTexte = demoZone.querySelector('.demo-texte');
let demoMinuteur = null;
let demoVisible = false;

function lancerDemoFrappe() {
  clearTimeout(demoMinuteur);
  let n = 0;
  demoZone.classList.remove('remplace');
  demoTexte.textContent = DEMO_PREFIXE;

  const taper = () => {
    if (!demoVisible) return;
    if (n < DEMO_DECLENCHEUR.length) {
      demoTexte.textContent = DEMO_PREFIXE;
      const mark = document.createElement('mark');
      mark.textContent = DEMO_DECLENCHEUR.slice(0, ++n);
      demoTexte.appendChild(mark);
      demoMinuteur = setTimeout(taper, 260);
    } else {
      demoMinuteur = setTimeout(() => {
        if (!demoVisible) return;
        demoZone.classList.add('remplace');
        demoTexte.textContent = DEMO_PREFIXE + DEMO_TEXTE;
        demoMinuteur = setTimeout(lancerDemoFrappe, 3200);
      }, 700);
    }
  };
  demoMinuteur = setTimeout(taper, 600);
}

new IntersectionObserver((entrees) => {
  const visible = entrees[entrees.length - 1].isIntersecting;
  if (visible === demoVisible) return;
  demoVisible = visible;
  if (visible) lancerDemoFrappe();
  else clearTimeout(demoMinuteur);
}, { threshold: 0.3 }).observe(demoZone);

// Survoler une action d'un clausier, ou une icône de la maquette, met en évidence les deux à la
// fois.
document.querySelectorAll('[data-ico]').forEach(el => {
  const paire = () => document.querySelectorAll(`[data-ico="${el.dataset.ico}"]`);
  el.addEventListener('mouseenter', () => paire().forEach(x => x.classList.add('actif')));
  el.addEventListener('mouseleave', () => paire().forEach(x => x.classList.remove('actif')));
});

// Statistiques d'utilisation : seule la nature de l'usage part (voir STATS_CLES, background.js).
function compterUsage(cle) {
  chrome.runtime.sendMessage({ type: 'STAT', cle }, () => void chrome.runtime.lastError);
}
compterUsage('tutoriel');
