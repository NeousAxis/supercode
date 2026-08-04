# Super Code — grammaire complète (v0.1)

> **Traduction de courtoisie, non normative.** La référence est
> [`GRAMMAR.md`](GRAMMAR.md) : en cas d'écart, c'est elle qui tranche.

Ce fichier est la spécification **entière** du langage. Il tient en une page pour
qu'un LLM puisse le lire dans son prompt système et écrire du Super Code correct du
premier coup, sans avoir jamais vu le langage pendant son entraînement.

Règle de conception : **une seule façon d'écrire chaque chose**. Pas de sucre
syntaxique, pas de variantes, pas d'options.

## 1. Structure d'un fichier

```
programme   := ( skill | mission )*

mission     := "mission" IDENT "{" entete* instruction* "}"
entete      := "uses"   capacite ("," capacite)*
             | "budget" limite ("," limite)*
             | "every"  DUREE
skill       := "skill" IDENT "(" params? ")" "->" type "{" TEXTE "}"
```

`uses` déclare tout ce que la mission a le droit de toucher. Ce qui n'est pas
déclaré est refusé à l'exécution, pas au bon vouloir du code.

```
capacite    := IDENT "." IDENT "(" TEXTE ")"      # net.get("https://api.exemple.com/**")
limite      := ARGENT | NOMBRE "steps" | DUREE    # 0.50usd, 30 steps, 5min
```

## 2. Instructions

```
instruction := "let" IDENT "=" expr
             | "if" expr bloc ("else" bloc)?
             | "for" IDENT "in" expr bloc
             | "repeat" bloc "until" expr   # boucle jusqu'à l'objectif
             | "confirm" expr          # point d'arrêt humain obligatoire
             | "log" expr
             | "done"                  # termine la mission avec succès
             | "fail" expr             # termine la mission en erreur
             | expr                    # une expression seule, pour ses effets
bloc        := "{" instruction* "}"
```

`repeat` recommence tant que la condition d'arrêt est fausse. Un `let` réexécuté
remplace sa valeur précédente, donc un accumulateur traverse les tours et
survit à la boucle :

```
let restants = fichiers
let notes    = []
repeat {
  let notes    = notes + ["vu {restants[0]}"]
  let restants = slice(restants, 1, len(restants))
} until len(restants) == 0
```

Deux règles refusées à l'analyse, pas à l'exécution :

- une mission contenant un `repeat` **doit** déclarer un budget en étapes ou en
  durée. Chaque tour en consomme une, donc une boucle qui n'atteint jamais son
  objectif s'arrête sur le budget au lieu de tourner sans fin ;
- un `confirm` **doit** porter sur une expression contenant un effet. Garder
  une valeur ne protège rien et donnerait une fausse assurance.

## 3. Expressions

Par précédence croissante :

```
expr     := pipe
pipe     := filtre ( "|>" filtre )*                    # a |> f |> g  ==  g(f(a))
filtre   := ou ( ("where" | "map") ou )*               # liste where cond, liste map expr
ou       := et ( "or" et )*
et       := cmp ( "and" cmp )*
cmp      := somme ( ("=="|"!="|"<"|">"|"<="|">=") somme )*
somme    := produit ( ("+"|"-") produit )*
produit  := unaire ( ("*"|"/") unaire )*
unaire   := ("not" | "-") unaire | suffixe
suffixe  := primaire ( "." IDENT | "[" expr "]" | "(" args ")" )*
primaire := NOMBRE | TEXTE | "true" | "false" | "null" | "it" | IDENT
          | "(" expr ")" | liste | fiche | effet | modele
          | "." IDENT                                  # sucre pour it.IDENT
liste    := "[" (expr ("," expr)*)? "]"
fiche    := "{" (IDENT ":" expr ("," IDENT ":" expr)*)? "}"
```

Dans un `where` ou un `map`, `it` désigne l'élément courant. `.titre` est un
raccourci pour `it.titre`.

## 4. Les deux opérateurs qui font le langage

```
effet    := "!" IDENT "." IDENT "(" args ")" modificateur*
modificateur := "retry" NOMBRE | "timeout" DUREE
modele   := "~" TEXTE ( "(" args ")" )? ( "as" type )?
```

`!` marque un **effet** : tout ce qui touche le monde extérieur. Chaque effet est
journalisé, donc rejouable : si le programme meurt, il reprend sans refaire les
appels déjà faits. Ce qui n'a pas de `!` est pur et gratuit à rejouer.

`~` marque un **appel au modèle**, typé par sa sortie. Le prompt est une valeur
du langage, pas une chaîne perdue dans un SDK.

```
let pages  = !net.get("https://exemple.com/news") retry 3 timeout 10s
let items  = ~"extrais les titres et leur date" (pages) as list<{titre: text, date: text}>
```

## 5. Types

```
type := "text" | "number" | "bool" | "any"
      | "list" "<" type ">"
      | "{" IDENT ":" type ("," IDENT ":" type)* "}"
```

## 6. Skills — décrire une abstraction une seule fois

```
skill domaine(url: text) -> text {
  "renvoie le nom de domaine d'une URL, sans le www."
}
```

Au premier appel, le modèle écrit l'implémentation, elle est testée sur l'entrée
réelle puis mise en cache. Tous les appels suivants sont du code pur : zéro
token, zéro latence. Si l'abstraction n'est pas exprimable en code, elle reste un
appel au modèle et le signale.

C'est le mécanisme central du langage : une abstraction complexe se décrit en une
phrase et devient une brique définitive.

Le code d'un skill est enregistré avec son empreinte : un code modifié après coup
n'est jamais exécuté, il faut le relire et le ré-approuver (`super trust`). Il
s'exécute dans un processus séparé, sans disque, sans sous-processus et sans
environnement, donc même une évasion n'y trouverait aucune clé.

## 7. Fonctions intégrées (pures)

`len(x)` `slice(l, a, b)` `join(l, sep)` `split(t, sep)` `upper(t)` `lower(t)`
`trim(t)` `sum(l)` `sort(l)` `unique(l)` `keys(f)` `to_json(x)` `parse_json(t)`
`now()` `int(x)` `text(x)`

## 8. Effets disponibles

| Effet | Capacité à déclarer | Renvoie |
|---|---|---|
| `!net.get(url)` | `net.get("motif")` | texte, ou fiche si la réponse est du JSON |
| `!net.post(url, corps, entetes?)` | `net.post("motif")` | idem ; `corps` part en JSON, ou en texte si c’est un texte |
| `!fs.graph(motif)` | `fs.graph("motif")` | `{fichiers: [{chemin, ext, octets, lignes}], liens: [{de, vers}]}` |
| `!file.read(chemin)` | `file.read("motif")` | texte |
| `!file.write(chemin, contenu)` | `file.write("motif")` | chemin écrit |
| `!file.append(chemin, contenu)` | `file.append("motif")` | chemin écrit |
| `!super.run(fichier, mission?)` | `super.run("motif")` | `{fichier, mission, statut, runId, logs, erreur}` |

Règle sans exception : un effet `!ns.op(...)` exige la capacité `ns.op`. Les
motifs acceptent `*` (un segment) et `**` (tout le reste), et sont comparés au
premier argument de l'effet.

`!super.run` lance une **autre mission**, et c'est ce qui rend l'orchestration
possible dans le langage plutôt que dans un script à côté. Le fils est un run à
part entière : son propre journal, son propre budget, ses propres capacités. Le
père ne dépense qu'une étape.

`statut` vaut `terminée`, `en_attente_approbation` ou `échouée`. **Un point
d'arrêt dans le fils n'est pas une erreur, c'est un résultat**, et un fils qui
échoue est une valeur que le père peut lire au lieu d'un plantage qui l'emporte.

La profondeur d'empilement est bornée à trois : une mission qui se relance sans
fin s'arrête avec un message clair au lieu d'épuiser la machine.

## 9. Nombres, comparaisons, fiches

Il n'y a qu'un seul type numérique. Un nombre dont la valeur est entière s'écrit
**sans partie décimale**, partout : dans un texte interpolé, dans `to_json`, et
dans toute sérialisation. `3 / 1` s'écrit `3`, jamais `3.0`.

**Il n'existe ni infini ni « pas un nombre ».** Tout calcul qui ne donne pas un
nombre fini interrompt la mission avec `ARITHMETIC_ERROR`. `1 / 0` ne vaut pas
`Infinity` : une mission qui écrit `Infinity` dans un rapport est pire qu'une
mission qui s'arrête, parce que l'erreur voyage sans bruit jusqu'au lecteur.

**`<`, `>`, `<=`, `>=` comparent deux nombres ou deux textes**, jamais deux
natures différentes. `1 < "a"` est une `TYPE_ERROR`, pas un `false` inventé.

**`==` et `!=` comparent la structure**, pas la sérialisation : `{a: 1, b: 2}`
égale `{b: 2, a: 1}`. L'ordre des champs sert à l'affichage, pas à l'identité.

**Une fiche garde l'ordre de ses champs** pour `keys` et `to_json`. Un champ
répété remplace la valeur du précédent sans changer sa place : `{a: 1, b: 2, a: 3}`
vaut `{a: 3, b: 2}`, dans cet ordre.

Ces cinq règles ne sont pas du détail. Trois implémentations les ont d'abord
enfreintes chacune à sa façon, et sans elles trois programmes corrects donnaient
trois résultats différents.

## 10. Textes

Un texte est une suite de **points de code Unicode**. Ni des unités UTF-16, ni
des octets. `len("👍")` vaut 1, et `slice` découpe par points de code. Sans cette
règle, trois implémentations correctes répondraient 2, 1 et 4.

## 11. Lexique

Commentaires : `#` jusqu'à la fin de la ligne.
Textes : `"..."` avec interpolation `{expr}`, échappements `\"` `\\` `\n` `\{`.
Durées : `250ms` `30s` `5min` `6h` `2d`. Argent : `0.50usd`.
