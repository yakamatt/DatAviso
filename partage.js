// partage.js — lien d'installation de l'extension, utilisé par le popup.
// On partage la fiche du Chrome Web Store plutôt qu'un fichier : l'installation y est en un clic
// et Chrome applique ensuite les mises à jour automatiquement. Copie dans le presse-papiers
// (autorisée sans permission sur un clic de l'utilisateur), ou message prérempli dans la
// messagerie par défaut.

const STORE_URL = 'https://chromewebstore.google.com/detail/snippet-expander/mabihnnahlkhhkebmoejlnnkjkdbnlkb';

function brancherPartage(boutonCopie, lienMail, statut) {
  boutonCopie.addEventListener('click', () => {
    navigator.clipboard.writeText(STORE_URL)
      .then(() => { statut.textContent = '✅ Lien copié : collez-le dans un message à vos collègues.'; })
      .catch(() => { statut.textContent = `Copie impossible, voici le lien : ${STORE_URL}`; });
  });

  const sujet = 'DatAviso, une extension Chrome pour rédiger plus vite';
  const corps = 'Bonjour,\n\nJe te recommande DatAviso : un raccourci court (par exemple /GN4) se remplace ' +
    'par le texte complet dans n\'importe quel champ, et sur Aviso des icônes insèrent les dispositions types ' +
    'en un clic.\n\nPour l\'installer :\n' + STORE_URL + '\n';
  lienMail.href = `mailto:?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(corps)}`;
}
