# Super Code

Un langage pour écrire des **missions d'agents**. Super simple, super rapide,
super léger, et capable de transformer une abstraction complexe décrite en une
phrase en une brique définitive.

```
skill domaine(url: text) -> text {
  "renvoie le nom de domaine d'une URL, sans le préfixe www."
}

mission veille {
  uses net.get("https://hacker-news.firebaseio.com/**"), file.write("out/**")
  budget 1.00usd, 60 steps, 3min
  every 6h

  let ids     = !net.get("https://hacker-news.firebaseio.com/v0/topstories.json") retry 3 timeout 15s
  let stories = slice(ids, 0, 10) map !net.get("https://hacker-news.firebaseio.com/v0/item/{it}.json")
  let picks   = ~"Garde les articles qui parlent d'IA, et dis en une phrase pourquoi."
                (stories map { titre: .title, url: .url }) as list<{titre: text, url: text, pourquoi: text}>

  let rapport = "# Veille IA — {now()}\n\n" + join(picks map "- **{.titre}** _({domaine(.url)})_ — {.pourquoi}", "\n")
  confirm !file.write("out/veille.md", rapport)
}
```

## Pourquoi un langage plutôt qu'une bibliothèque

Un agent passe 99 % de son temps à attendre des tokens et du réseau. Gagner des
millisecondes de parsing ne sert à rien. Ce qui coûte cher, c'est le code autour :
les reprises après crash, les tentatives, les budgets, les garde-fous, les
approbations. Aujourd'hui on empile six bibliothèques pour ça. Ici ce sont des
primitives, et elles tiennent en trois symboles.

### `!` — un effet, donc une étape rejouable

Tout ce qui touche le monde extérieur porte un `!`. Chaque effet est écrit dans un
journal. Si la mission meurt, elle reprend là où elle en était sans refaire un
seul appel déjà passé.

```
let page = !net.get("https://exemple.com") retry 3 timeout 10s
```

`now()` porte la même contrainte : lire l'horloge est une observation du monde,
donc c'est journalisé. Sans cela une reprise ne produirait pas le même résultat
que la première exécution, et la promesse du journal ne tiendrait pas.

### `~` — un appel au modèle, typé par sa sortie

```
let items = ~"extrais les titres et leur date" (page) as list<{titre: text, date: text}>
```

Le résultat est vérifié contre le type. En cas d'écart, une seule réparation est
tentée, puis c'est une erreur franche. Pas de JSON douteux qui se propage.

### `confirm` — le point d'arrêt humain

```
confirm !file.write("out/rapport.md", contenu)
```

L'effet ne part pas. La mission s'arrête, affiche exactement ce qu'elle
s'apprête à faire, et attend `super approve`. À la reprise, tout ce qui précède
est rejoué depuis le journal, donc l'approbation porte sur le contenu exact qui
a été montré.

### `repeat ... until` — boucler jusqu'à l'objectif, sans jamais boucler sans fin

```
repeat {
  let notes    = notes + [~"résume ce fichier" (!file.read(restants[0])) as text]
  let restants = slice(restants, 1, len(restants))
} until len(restants) == 0
```

Une mission qui contient un `repeat` **doit** déclarer un budget en étapes ou en
durée, sinon l'analyseur la refuse. Chaque tour consomme une étape. Une boucle
qui n'atteint jamais son objectif s'arrête donc sur le budget, avec un message
clair, jamais sur une facture ouverte. La borne est dans le langage, pas dans la
discipline de celui qui écrit.

### `!fs.graph` — un index de fichiers à parcourir

```
let g = !fs.graph("src/**")
let cibles = g.fichiers where .ext == ".ts" map .chemin
```

Renvoie une fiche plate : la liste des fichiers, et leurs liens d'import. Plate
pour se parcourir avec `where` et `map` et se relire d'un coup d'œil ; journalisée
donc gratuite à rejouer. Le contenu des fichiers n'y est pas, on le relit avec
`!file.read` quand on en a besoin.

### `uses` — le périmètre est du typage, pas de la configuration

```
uses net.get("https://hacker-news.firebaseio.com/**"), file.write("out/**")
```

Ce qui n'est pas déclaré est refusé à l'exécution. Les motifs acceptent `*` pour
un segment et `**` pour le reste.

### `budget` — une limite, pas un vœu

```
budget 1.00usd, 60 steps, 3min
```

Dépassement en argent, en étapes ou en temps : la mission s'arrête net.

### `skill` — décrire une abstraction une seule fois

C'est le cœur du langage. Une abstraction se décrit en français, avec sa
signature :

```
skill domaine(url: text) -> text {
  "renvoie le nom de domaine d'une URL, sans le préfixe www."
}
```

Au premier appel, le modèle écrit l'implémentation. Elle est exécutée dans un bac
à sable sans réseau, sans disque, sans `require` et sans `process`, testée sur
l'entrée réelle, vérifiée contre le type déclaré, puis mise en cache. **Tous les
appels suivants sont du code pur : zéro token, zéro latence, résultat
identique.** Si l'abstraction n'est pas exprimable en code déterministe, elle
reste un appel au modèle et le dit.

C'est la réponse à « synthétiser facilement de grandes abstractions » : une
phrase entre, une fonction définitive sort.

**Intégrité.** Le cache contient du code exécutable. Chaque fichier est
enregistré avec son empreinte SHA-256 dans `.super/skills/manifest.json`, et un
code dont l'empreinte ne correspond plus **n'est jamais exécuté** : la mission
s'arrête avec un message qui montre les deux empreintes. Sans cela, tout ce qui
sait écrire dans ce dossier obtiendrait l'exécution de code au run suivant.
Après une modification volontaire, `super trust` affiche le code et attend
`--yes` pour le ré-approuver. Un skill doit aussi être synchrone : une fonction
qui renvoie une promesse est rejetée.

## Le modèle écrit du Super Code, pas l'inverse

```bash
super write "surveille le top de Hacker News et résume ce qui parle d'IA" -o veille.sup --provider longcat
```

La grammaire entière tient sur une page, donc elle rentre dans un prompt
système. N'importe quel modèle produit du Super Code sans en avoir jamais vu pendant
son entraînement. La sortie passe par l'analyseur **avant** d'être écrite sur le
disque : une mission qui ne compile pas n'est jamais enregistrée, et l'erreur est
renvoyée au modèle pour une correction.

C'est là que le langage prend son sens. Un modèle qui produit du Python produit
du code qui peut tout faire, et qu'il faut relire. Un modèle qui produit du Super Code
produit un programme dont le périmètre est déclaré (`uses`), le coût borné
(`budget`), les effets rejouables (`!`) et les actions irréversibles bloquées
(`confirm`). La relecture porte sur quinze lignes déclaratives, pas sur un script.

## Fournisseurs de modèle

| `--provider` | Endpoint | Notes |
|---|---|---|
| `api` | API Anthropic | `ANTHROPIC_API_KEY`, `--model claude-opus-5` par défaut |
| `longcat` | `api.longcat.chat/openai` | clé lue dans `LONGCAT_API_KEY` ou `~/.config/longcat/key` |
| `openai` | n'importe quel endpoint compatible OpenAI | `--base-url`, `SUPER_API_KEY` — GLM, Mistral, Ollama, un modèle local |
| `cli` | la CLI `claude` locale | réutilise ta session, sans clé |
| `fixtures` | réponses enregistrées | démo hors ligne, exécution reproductible |

Parler ces formats HTTP n'est pas « apprendre leur langage » : c'est un pilote de
quarante lignes, écrit une fois, pour causer à une machine qu'on ne possède pas.
Ce qui compte est dans l'autre sens, et c'est `super write`.

## Prendre en main

Node 22.6 ou plus récent. Aucune dépendance à installer.

```bash
node src/cli.ts check missions/veille.sup       # vérifie syntaxe, capacités, budget
node src/cli.ts run   missions/hello.sup        # la mission minimale
node test/run.ts                                # 22 tests, sans réseau
```

Démonstration complète, hors ligne, avec des réponses de modèle enregistrées :

```bash
node src/cli.ts run missions/veille.sup --fixtures examples/fixtures.json
# → s'arrête sur le point d'approbation
node src/cli.ts approve <runId>
node src/cli.ts run missions/veille.sup --resume <runId> --fixtures examples/fixtures.json
# → out/veille.md
```

En vrai, avec un modèle :

```bash
export ANTHROPIC_API_KEY=...
node src/cli.ts run missions/veille.sup --provider api
```

Ou, sans clé, en réutilisant ta session Claude Code locale :

```bash
node src/cli.ts run missions/veille.sup --provider cli
```

### Commandes

| Commande | Rôle |
|---|---|
| `super check <f.sup>` | vérifie la syntaxe, affiche capacités et budget |
| `super run <f.sup> [mission]` | exécute |
| `super runs` | liste les runs et ceux qui attendent une approbation |
| `super trust [--yes]` | ré-approuve le code des skills modifié après relecture |
| `super approve <runId>` | approuve le point d'arrêt en attente |

Options : `--provider api\|cli\|fixtures`, `--fixtures <f>`, `--resume <runId>`,
`--yes`, `--dir <chemin>`.

## Ce qui est vérifié, et ce qui ne l'est pas

Vérifié de bout en bout sur cette machine :

- l'analyse, l'interprétation, les 13 tests ;
- les effets réseau réels (11 appels à l'API Hacker News) et leur journalisation ;
- la reprise : un run repris rejoue les étapes sans refaire un seul appel ;
- le point d'arrêt : le fichier n'est pas écrit tant que l'approbation manque ;
- le contrôle de capacités et le budget, qui coupent bien la mission ;
- la synthèse d'un skill par un vrai modèle (LongCat), son isolement en bac à
  sable, sa vérification de type, sa mise en cache et sa réutilisation ;
- le refus d'exécuter un code de skill modifié après approbation ;
- la boucle `repeat` qui s'arrête sur l'objectif, et son refus à l'analyse sans
  budget borné ;
- `!fs.graph` sur un vrai dépôt, et un audit fichier par fichier bouclé avec
  LongCat de bout en bout ;
- la reprise après un journal tronqué par un crash.

**Non vérifié ici :** les appels à un vrai modèle. La machine n'a ni
`ANTHROPIC_API_KEY`, ni session `claude` utilisable depuis un sous-processus. Les
deux fournisseurs sont écrits mais n'ont pas tourné. Dans la démonstration hors
ligne, le contenu des réponses vient de `examples/fixtures.json`, donc le code du
skill `domaine` a été écrit à la main, pas par un modèle. Toute la mécanique
autour, elle, est réelle.

## Limites connues de la v0.1

- Le bac à sable des skills repose sur `node:vm`, qui isole les globales mais
  n'est pas une frontière de sécurité contre du code hostile. Suffisant pour du
  code écrit par un modèle sur ta propre machine, pas pour du code non fiable.
- `every 6h` est déclaratif : rien ne planifie encore les missions.
- Pas de fonctions définies par l'utilisateur en dehors des skills.
- Effets limités à `net.get`, `file.read`, `file.write`, `file.append`.
- Le journal est un fichier par run, sans compaction.

## Organisation

```
spec/GRAMMAR.md   la grammaire entière, sur une page
src/lexer.ts      analyse lexicale
src/parser.ts     analyse syntaxique
src/interp.ts     interpréteur
src/runtime.ts    journal, capacités, budget, effets, modèle, skills
src/cli.ts        ligne de commande
test/run.ts       tests
missions/         exemples exécutables
examples/         réponses de modèle enregistrées pour la démo hors ligne
```

`spec/GRAMMAR.md` tient sur une page pour une raison précise : un langage inventé
n'a aucune donnée d'entraînement derrière lui. Pour qu'un modèle écrive du Super Code
correct du premier coup, la grammaire entière doit tenir dans son prompt système.
C'est la contrainte qui a dicté toute la conception : une seule façon d'écrire
chaque chose.
