# Super Code — grammaire complète (v0.1)

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

Le code d'un skill est enregistré avec son empreinte. Un code modifié après coup
n'est jamais exécuté : il faut le relire et le ré-approuver (`super trust`).

## 7. Fonctions intégrées (pures)

`len(x)` `slice(l, a, b)` `join(l, sep)` `split(t, sep)` `upper(t)` `lower(t)`
`trim(t)` `sum(l)` `sort(l)` `unique(l)` `keys(f)` `to_json(x)` `parse_json(t)`
`now()` `int(x)` `text(x)`

## 8. Effets disponibles

| Effet | Capacité à déclarer | Renvoie |
|---|---|---|
| `!net.get(url)` | `net.get("motif")` | texte, ou fiche si la réponse est du JSON |
| `!fs.graph(motif)` | `fs.graph("motif")` | `{fichiers: [{chemin, ext, octets, lignes}], liens: [{de, vers}]}` |
| `!file.read(chemin)` | `file.read("motif")` | texte |
| `!file.write(chemin, contenu)` | `file.write("motif")` | chemin écrit |
| `!file.append(chemin, contenu)` | `file.write("motif")` | chemin écrit |

Les motifs de capacité acceptent `*` (un segment) et `**` (tout le reste).

## 9. Lexique

Commentaires : `#` jusqu'à la fin de la ligne.
Textes : `"..."` avec interpolation `{expr}`, échappements `\"` `\\` `\n` `\{`.
Durées : `250ms` `30s` `5min` `6h` `2d`. Argent : `0.50usd`.
