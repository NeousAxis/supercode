# Contrat de conformité de Super Code

Ce fichier décrit tout ce qu'une implémentation de Super Code doit faire pour
être vérifiable. Il tient volontairement sur une page, comme la grammaire.

L'implémentation de référence (`src/`) tourne sur Node. Ce n'est qu'une
implémentation parmi d'autres. Le langage, lui, est défini par
[`../spec/GRAMMAR.md`](../spec/GRAMMAR.md) et par cette suite.

## Le seul point de contact

Une implémentation doit fournir une commande qui accepte :

```
<commande> <fichier.sup> --dir <dossier>
```

- `<fichier.sup>` : le programme à exécuter. La **première** mission du fichier
  est celle qui tourne.
- `--dir <dossier>` : le répertoire de travail. Tous les chemins relatifs des
  effets `file.*` et `fs.graph` s'y résolvent.

Elle écrit sur la sortie standard **un unique objet JSON, et rien d'autre.**
Pas de couleur, pas d'identifiant d'exécution, pas d'horodatage, pas de barre de
progression. Ce qui doit être dit à l'humain va sur la sortie d'erreur.

```json
{
  "logs":  ["première ligne", "deuxième ligne"],
  "error": null,
  "files": { "out/note.md": "contenu complet" }
}
```

| Champ | Contenu |
|---|---|
| `logs` | un élément par instruction `log` effectivement exécutée, dans l'ordre, après interpolation |
| `error` | `null` si la mission s'est terminée, sinon `{ "code": "..." }` |
| `files` | tous les fichiers présents dans `--dir` à la fin, chemin relatif vers contenu, hors `.super/`, `fixtures.json`, `*.sup` et `*.expected.json` |

Le code de sortie du processus n'est pas comparé : une mission qui échoue peut
sortir en 0 comme en 1. Seul le JSON compte.

## Codes d'erreur

Les messages ne sont **jamais** comparés : ils peuvent être dans n'importe quelle
langue, aussi détaillés que l'implémentation le souhaite. Seul le code l'est.

| Code | Quand |
|---|---|
| `SYNTAX_ERROR` | le programme ne se lit pas, ou viole une règle refusée à l'analyse |
| `CAPABILITY_DENIED` | un effet sort du périmètre déclaré par `uses` |
| `BUDGET_EXCEEDED` | argent, étapes ou durée épuisés |
| `TYPE_ERROR` | une valeur ne correspond pas au type déclaré |
| `UNDEFINED_NAME` | nom inconnu, ou `it` hors d'un `where`/`map` |
| `NOT_CALLABLE` | appel de ce qui n'est pas appelable |
| `NOT_A_LIST` | `where`, `map` ou `for` sur autre chose qu'une liste |
| `EFFECT_FAILED` | l'effet était autorisé mais a échoué |
| `SKILL_FAILED` | le code d'un skill a échoué ou a été refusé |
| `MISSION_FAILED` | l'instruction `fail` |
| `MODEL_FAILED` | le modèle n'a pas produit de valeur exploitable |
| `INTERNAL` | tout le reste |

## Comportement attendu en mode conformité

- Les points d'arrêt `confirm` sont **approuvés automatiquement** : la suite doit
  être déterministe, et l'attente d'un humain ne l'est pas.
- Aucun appel réseau, aucun appel à un modèle. Les cas de la suite n'utilisent ni
  `net.*` ni `~`.
- Le journal, les skills et l'état interne vont dans `<dir>/.super/`, qui est
  exclu de `files`.

## Ce que la suite ne couvre pas encore

Elle vérifie la sémantique pure, les effets sur fichiers, les capacités, le
budget et les règles refusées à l'analyse. Elle ne couvre pas :

- la reprise après crash et le journal, qui demandent deux exécutions ;
- l'opérateur `~`, qui demande un modèle ;
- `net.get` et `net.post`, qui demandent le réseau ;
- la synthèse d'un skill et son bac à sable.

Ce sont les prochains chapitres. Ils demandent un protocole de test plus riche,
pas une autre philosophie.

## Lancer la suite

Contre l'implémentation de référence :

```bash
node conformance/run.mjs
```

Contre la vôtre :

```bash
node conformance/run.mjs --cmd "python3 chemin/vers/votre/cli.py conform"
node conformance/run.mjs --cmd "./super-rs conform" --only 03 --verbose
```

Un cas est un couple de fichiers dans `cases/` : `<nom>.sup` et
`<nom>.expected.json`. Chaque cas tourne dans un dossier temporaire neuf, donc
aucun cas n'influence les autres. Ajouter un cas, c'est ajouter deux fichiers,
et cela devient une contrainte pour toutes les implémentations.
