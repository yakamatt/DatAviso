// legifrance-articles.js — correspondance "article de la trame HAND" -> article de Légifrance
//
// La trame HAND (RICT b, accessibilité des constructions aux personnes handicapées, neuf) suit
// article par article l'arrêté du 20 avril 2017 relatif à l'accessibilité aux personnes
// handicapées des établissements recevant du public lors de leur construction et des
// installations ouvertes au public lors de leur aménagement (JORF n° 0098 du 26 avril 2017).
// Ses rubriques « Art. N » reprennent les articles 1 à 20 de cet arrêté ; « Art. 7.1 » et
// « Art. 7.2.II » correspondent aux articles 7-1 et 7-2.
//
// Chaque article a son propre identifiant JORFARTI sur Légifrance. Ils ont été relevés le
// 2026-11-22 sur la page de l'arrêté (JORFTEXT000034485459) : un article Légifrance est une
// adresse stable tant que l'arrêté n'est pas modifié. Si un article est modifié, la version
// publiée au Journal officiel reste consultable à cette adresse, mais le texte en vigueur peut
// différer : c'est alors la table qu'il faut régénérer, pas l'adresse qu'il faut deviner.
//
// Une table périmée produit au pire une page de l'arrêté en un autre état, jamais un renvoi
// vers un autre article : chaque clé désigne l'article de l'arrêté par son numéro.

const LEGIFRANCE_ARRETE_PMR_TITRE = "arrêté du 20 avril 2017 (accessibilité des ERP neufs)";

const LEGIFRANCE_ARTICLES_PMR = {
  '1': 'JORFARTI000034485464',
  '2': 'JORFARTI000034485467',
  '3': 'JORFARTI000034485468',
  '4': 'JORFARTI000034485470',
  '5': 'JORFARTI000034485471',
  '6': 'JORFARTI000034485472',
  '7': 'JORFARTI000034485473',
  '7-1': 'JORFARTI000034485474',
  '7-2': 'JORFARTI000034485475',
  '8': 'JORFARTI000034485477',
  '9': 'JORFARTI000034485478',
  '10': 'JORFARTI000034485479',
  '11': 'JORFARTI000034485480',
  '12': 'JORFARTI000034485481',
  '13': 'JORFARTI000034485482',
  '14': 'JORFARTI000034485483',
  '15': 'JORFARTI000034485484',
  '16': 'JORFARTI000034485485',
  '17': 'JORFARTI000034485486',
  '18': 'JORFARTI000034485487',
  '19': 'JORFARTI000034485488',
  '20': 'JORFARTI000034485489',
};

// "7-1" -> "https://www.legifrance.gouv.fr/jorf/article_jo/JORFARTI000034485474"
// Renvoie null si le numéro ne correspond à aucun article de la table : l'appelant n'affiche
// alors aucun lien, plutôt que d'en proposer un qui ne mènerait pas au bon article.
function legifranceUrlForArticlePmr(numero) {
  const id = LEGIFRANCE_ARTICLES_PMR[String(numero || '').trim()];
  return id ? `https://www.legifrance.gouv.fr/jorf/article_jo/${id}` : null;
}
