#!/usr/bin/env python3
"""
Deuxième implémentation de Super Code, en Python, bibliothèque standard seule.

Elle n'existe pas pour être utilisée : elle existe pour prouver que Super Code
est un langage et pas un programme. Elle a été écrite d'après spec/GRAMMAR.md et
conformance/CONTRACT.md, sans partager une ligne avec l'implémentation Node, et
elle passe la même suite de conformité.

Elle couvre le sous-ensemble que la suite vérifie : la sémantique pure, les
effets sur fichiers, les capacités, le budget et les règles refusées à l'analyse.
Ni skills, ni appels au modèle, ni réseau, ni journal.

    python3 super.py conform mission.sup --dir /un/dossier
"""

import json
import os
import re
import sys
import time

# --------------------------------------------------------------------- erreurs


class SuperError(Exception):
    def __init__(self, message, code="INTERNAL"):
        super().__init__(message)
        self.code = code


def syntaxe(message, ligne=0):
    return SuperError(f"{message} (ligne {ligne})", "SYNTAX_ERROR")


# ------------------------------------------------------------------- lexique

MOTS_CLES = {
    "mission", "skill", "uses", "budget", "every",
    "let", "if", "else", "for", "in", "repeat", "until", "confirm", "log",
    "done", "fail", "where", "map", "retry", "timeout", "as",
    "and", "or", "not", "true", "false", "null", "it", "steps",
}

# Les symboles longs d'abord : l'ordre compte.
SYMBOLES = ["|>", "->", "==", "!=", "<=", ">=",
            "{", "}", "(", ")", "[", "]", ",", ":", ".", "!", "~",
            "<", ">", "+", "-", "*", "/", "="]

DUREES = {"ms": 1, "s": 1000, "min": 60000, "h": 3600000, "d": 86400000}

ECHAPPEMENTS = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "{": "{", "}": "}"}


class Tok:
    __slots__ = ("t", "v", "parts", "ligne")

    def __init__(self, t, v=None, parts=None, ligne=0):
        self.t, self.v, self.parts, self.ligne = t, v, parts, ligne

    def __repr__(self):
        return f"Tok({self.t},{self.v})"


def lexer(src):
    toks, i, ligne = [], 0, 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\n":
            ligne += 1
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if c == "#":
            while i < n and src[i] != "\n":
                i += 1
            continue

        depart = ligne

        if c == '"':
            i += 1
            parts, buf = [], ""
            while i < n and src[i] != '"':
                if src[i] == "\\":
                    suivant = src[i + 1] if i + 1 < n else ""
                    if suivant not in ECHAPPEMENTS:
                        raise syntaxe(f"échappement inconnu \\{suivant}", ligne)
                    buf += ECHAPPEMENTS[suivant]
                    i += 2
                    continue
                if src[i] == "{":
                    if buf:
                        parts.append(("texte", buf))
                        buf = ""
                    i += 1
                    profondeur, code = 1, ""
                    while i < n and profondeur > 0:
                        if src[i] == "{":
                            profondeur += 1
                        elif src[i] == "}":
                            profondeur -= 1
                            if profondeur == 0:
                                break
                        if src[i] == "\n":
                            ligne += 1
                        code += src[i]
                        i += 1
                    if profondeur != 0:
                        raise syntaxe("interpolation { non fermée", depart)
                    i += 1
                    parts.append(("code", code))
                    continue
                if src[i] == "\n":
                    ligne += 1
                buf += src[i]
                i += 1
            if i >= n:
                raise syntaxe("texte non fermé", depart)
            i += 1
            if buf or not parts:
                parts.append(("texte", buf))
            toks.append(Tok("str", parts=parts, ligne=depart))
            continue

        if c.isdigit():
            debut = i
            while i < n and (src[i].isdigit() or src[i] == "."):
                i += 1
            nombre = float(src[debut:i])
            suffixe = ""
            while i < n and (src[i].isalpha() or src[i] == "_"):
                suffixe += src[i]
                i += 1
            if suffixe == "":
                toks.append(Tok("num", nombre, ligne=depart))
            elif suffixe in DUREES:
                toks.append(Tok("dur", nombre * DUREES[suffixe], ligne=depart))
            elif suffixe in ("usd", "eur"):
                toks.append(Tok("money", nombre, ligne=depart))
            else:
                raise syntaxe(f"suffixe numérique inconnu « {suffixe} »", depart)
            continue

        if c.isalpha() or c == "_":
            debut = i
            while i < n and (src[i].isalnum() or src[i] == "_"):
                i += 1
            mot = src[debut:i]
            toks.append(Tok("kw" if mot in MOTS_CLES else "ident", mot, ligne=depart))
            continue

        for s in SYMBOLES:
            if src.startswith(s, i):
                i += len(s)
                toks.append(Tok(s, ligne=depart))
                break
        else:
            raise syntaxe(f"caractère inattendu « {c} »", ligne)

    toks.append(Tok("eof", ligne=ligne))
    return toks


# ------------------------------------------------------------------- syntaxe


def contient(noeud, genre):
    """Cherche un genre de nœud dans un arbre."""
    if isinstance(noeud, dict):
        if noeud.get("k") == genre:
            return True
        return any(contient(v, genre) for v in noeud.values())
    if isinstance(noeud, list):
        return any(contient(v, genre) for v in noeud)
    return False


class Analyseur:
    def __init__(self, toks):
        self.toks, self.p = toks, 0

    def cur(self):
        return self.toks[self.p]

    def est(self, t, v=None):
        c = self.cur()
        return c.t == t and (v is None or c.v == v)

    def kw(self, v):
        return self.est("kw", v)

    def avance(self):
        self.p += 1
        return self.toks[self.p - 1]

    def mange(self, t, v=None):
        if not self.est(t, v):
            c = self.cur()
            raise syntaxe(f"attendu « {v or t} », trouvé « {c.v or c.t} »", c.ligne)
        return self.avance()

    def essaie(self, t, v=None):
        if self.est(t, v):
            self.avance()
            return True
        return False

    # -- programme

    def programme(self):
        missions = []
        while not self.est("eof"):
            if self.kw("mission"):
                missions.append(self.mission())
            elif self.kw("skill"):
                raise syntaxe("les skills ne sont pas gérés par cette implémentation",
                              self.cur().ligne)
            else:
                raise syntaxe("attendu « mission » au premier niveau", self.cur().ligne)
        return missions

    def mission(self):
        depart = self.mange("kw", "mission")
        nom = self.mange("ident").v
        self.mange("{")
        uses, budget, every = [], {"usd": None, "steps": None, "ms": None}, None
        while self.est("kw") and self.cur().v in ("uses", "budget", "every"):
            mot = self.avance().v
            if mot == "uses":
                while True:
                    uses.append(self.capacite())
                    if not self.essaie(","):
                        break
            elif mot == "budget":
                while True:
                    t = self.avance()
                    if t.t == "money":
                        budget["usd"] = t.v
                    elif t.t == "dur":
                        budget["ms"] = t.v
                    elif t.t == "num":
                        self.mange("kw", "steps")
                        budget["steps"] = t.v
                    else:
                        raise syntaxe("limite de budget invalide", t.ligne)
                    if not self.essaie(","):
                        break
            else:
                every = self.mange("dur").v
        corps = self.corps()
        self.mange("}")
        if contient(corps, "repeat") and budget["steps"] is None and budget["ms"] is None:
            raise syntaxe(
                f"la mission « {nom} » contient un « repeat » : elle doit déclarer "
                "un budget en étapes ou en durée", depart.ligne)
        return {"nom": nom, "uses": uses, "budget": budget, "every": every, "corps": corps}

    def capacite(self):
        ns = self.mange("ident").v
        self.mange(".")
        op = self.mange("ident").v
        self.mange("(")
        motif = self.texte_constant(self.mange("str"))
        self.mange(")")
        return {"ns": ns, "op": op, "motif": motif}

    def texte_constant(self, tok):
        if any(genre == "code" for genre, _ in tok.parts):
            raise syntaxe("interpolation interdite ici", tok.ligne)
        return "".join(v for _, v in tok.parts)

    # -- instructions

    def corps(self):
        out = []
        while not self.est("}") and not self.est("eof"):
            out.append(self.instruction())
        return out

    def bloc(self):
        self.mange("{")
        out = self.corps()
        self.mange("}")
        return out

    def instruction(self):
        c = self.cur()
        if self.kw("let"):
            self.avance()
            nom = self.mange("ident").v
            self.mange("=")
            return {"k": "let", "nom": nom, "val": self.expr(), "ligne": c.ligne}
        if self.kw("if"):
            self.avance()
            cond = self.expr()
            alors = self.bloc()
            sinon = self.bloc() if self.essaie("kw", "else") else None
            return {"k": "if", "cond": cond, "alors": alors, "sinon": sinon, "ligne": c.ligne}
        if self.kw("for"):
            self.avance()
            nom = self.mange("ident").v
            self.mange("kw", "in")
            liste = self.expr()
            return {"k": "for", "nom": nom, "liste": liste, "corps": self.bloc(), "ligne": c.ligne}
        if self.kw("repeat"):
            self.avance()
            corps = self.bloc()
            self.mange("kw", "until")
            return {"k": "repeat", "corps": corps, "until": self.expr(), "ligne": c.ligne}
        if self.kw("confirm"):
            self.avance()
            val = self.expr()
            if not contient(val, "effet"):
                raise syntaxe("« confirm » doit porter sur un effet", c.ligne)
            return {"k": "confirm", "val": val, "ligne": c.ligne}
        if self.kw("log"):
            self.avance()
            return {"k": "log", "val": self.expr(), "ligne": c.ligne}
        if self.kw("done"):
            self.avance()
            return {"k": "done", "ligne": c.ligne}
        if self.kw("fail"):
            self.avance()
            return {"k": "fail", "val": self.expr(), "ligne": c.ligne}
        return {"k": "expr", "val": self.expr(), "ligne": c.ligne}

    # -- expressions, par précédence croissante

    def expr(self):
        return self.tube()

    def tube(self):
        g = self.filtre()
        while self.est("|>"):
            self.avance()
            g = {"k": "pipe", "g": g, "d": self.filtre()}
        return g

    def filtre(self):
        g = self.ou()
        while self.kw("where") or self.kw("map"):
            op = self.avance().v
            g = {"k": op, "liste": g, "corps": self.ou()}
        return g

    def ou(self):
        g = self.et()
        while self.kw("or"):
            self.avance()
            g = {"k": "bin", "op": "or", "g": g, "d": self.et()}
        return g

    def et(self):
        g = self.cmp()
        while self.kw("and"):
            self.avance()
            g = {"k": "bin", "op": "and", "g": g, "d": self.cmp()}
        return g

    def cmp(self):
        g = self.somme()
        while self.cur().t in ("==", "!=", "<", ">", "<=", ">="):
            op = self.avance().t
            g = {"k": "bin", "op": op, "g": g, "d": self.somme()}
        return g

    def somme(self):
        g = self.produit()
        while self.cur().t in ("+", "-"):
            op = self.avance().t
            g = {"k": "bin", "op": op, "g": g, "d": self.produit()}
        return g

    def produit(self):
        g = self.unaire()
        while self.cur().t in ("*", "/"):
            op = self.avance().t
            g = {"k": "bin", "op": op, "g": g, "d": self.unaire()}
        return g

    def unaire(self):
        if self.kw("not"):
            self.avance()
            return {"k": "un", "op": "not", "val": self.unaire()}
        if self.est("-"):
            self.avance()
            return {"k": "un", "op": "-", "val": self.unaire()}
        return self.suffixe()

    def suffixe(self):
        n = self.primaire()
        while True:
            if self.est("."):
                self.avance()
                n = {"k": "champ", "cible": n, "nom": self.mange("ident").v}
            elif self.est("["):
                self.avance()
                idx = self.expr()
                self.mange("]")
                n = {"k": "index", "cible": n, "idx": idx}
            elif self.est("("):
                n = {"k": "appel", "cible": n, "args": self.args()}
            else:
                return n

    def args(self):
        self.mange("(")
        out = []
        if not self.est(")"):
            while True:
                out.append(self.expr())
                if not self.essaie(","):
                    break
        self.mange(")")
        return out

    def primaire(self):
        c = self.cur()
        if c.t in ("num", "dur", "money"):
            self.avance()
            return {"k": "num", "val": c.v}
        if c.t == "str":
            self.avance()
            return self.texte(c)
        if c.t == "kw":
            if c.v == "true":
                self.avance()
                return {"k": "bool", "val": True}
            if c.v == "false":
                self.avance()
                return {"k": "bool", "val": False}
            if c.v == "null":
                self.avance()
                return {"k": "null"}
            if c.v == "it":
                self.avance()
                return {"k": "it"}
        if c.t == "ident":
            self.avance()
            return {"k": "ident", "nom": c.v, "ligne": c.ligne}
        if c.t == ".":
            return {"k": "it"}  # « .champ » vaut « it.champ » : le point reste au suffixe
        if c.t == "(":
            self.avance()
            e = self.expr()
            self.mange(")")
            return e
        if c.t == "[":
            self.avance()
            items = []
            if not self.est("]"):
                while True:
                    items.append(self.expr())
                    if not self.essaie(","):
                        break
            self.mange("]")
            return {"k": "liste", "items": items}
        if c.t == "{":
            self.avance()
            champs = []
            if not self.est("}"):
                while True:
                    nom = self.mange("ident").v
                    self.mange(":")
                    champs.append((nom, self.expr()))
                    if not self.essaie(","):
                        break
            self.mange("}")
            return {"k": "fiche", "champs": champs}
        if c.t == "!":
            self.avance()
            ns = self.mange("ident").v
            self.mange(".")
            op = self.mange("ident").v
            args = self.args()
            essais, delai = 0, None
            while True:
                if self.kw("retry"):
                    self.avance()
                    essais = int(self.mange("num").v)
                    continue
                if self.kw("timeout"):
                    self.avance()
                    delai = self.mange("dur").v
                    continue
                break
            return {"k": "effet", "ns": ns, "op": op, "args": args,
                    "essais": essais, "delai": delai, "ligne": c.ligne}
        if c.t == "~":
            raise syntaxe("l'opérateur ~ n'est pas géré par cette implémentation", c.ligne)
        raise syntaxe(f"expression attendue, trouvé « {c.v or c.t} »", c.ligne)

    def texte(self, tok):
        parts = []
        for genre, valeur in tok.parts:
            if genre == "texte":
                parts.append(("texte", valeur))
            else:
                parts.append(("code", Analyseur(lexer(valeur)).expr()))
        return {"k": "str", "parts": parts}


# ------------------------------------------------------------------ exécution


class Fini(Exception):
    pass


def motif_vers_regex(motif):
    morceaux = [
        "[^/]*".join(re.escape(x) for x in seg.split("*"))
        for seg in motif.split("**")
    ]
    return re.compile("^" + ".*".join(morceaux) + "$")


def normaliser(v):
    """Un nombre entier s'écrit sans partie décimale (spec, section 9)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, list):
        return [normaliser(x) for x in v]
    if isinstance(v, dict):
        return {k: normaliser(x) for k, x in v.items()}
    return v


def texte_de(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(normaliser(v))
    return json.dumps(normaliser(v), ensure_ascii=False, separators=(",", ":"))


def fini(v, op):
    """Il n'existe ni infini ni « pas un nombre » dans Super Code."""
    if v != v or v in (float("inf"), float("-inf")):
        raise SuperError(f"« {op} » ne donne pas un nombre fini", "ARITHMETIC_ERROR")
    return v


def vrai(v):
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, (str, list, dict)):
        return len(v) > 0
    return True


def nombre(v):
    return float(v) if not isinstance(v, bool) else float(v)


class Interprete:
    def __init__(self, mission, dossier):
        self.mission = mission
        self.dossier = dossier
        self.logs = []
        self.etapes = 0
        self.debut = time.time()
        self.budget = mission["budget"]
        self.caps = mission["uses"]

    # -- garde-fous

    def etape(self):
        self.etapes += 1
        b = self.budget
        if b["steps"] is not None and self.etapes > b["steps"]:
            raise SuperError("budget épuisé : étapes", "BUDGET_EXCEEDED")
        if b["ms"] is not None and (time.time() - self.debut) * 1000 > b["ms"]:
            raise SuperError("budget épuisé : durée", "BUDGET_EXCEEDED")

    def autorise(self, ns, op, cible):
        for c in self.caps:
            if c["ns"] == ns and c["op"] == op and motif_vers_regex(c["motif"]).match(cible):
                return
        raise SuperError(f"capacité refusée : {ns}.{op}(\"{cible}\")", "CAPABILITY_DENIED")

    # -- instructions

    def bloc(self, instructions, portees):
        for i in instructions:
            self.instruction(i, portees)

    def instruction(self, s, portees):
        k = s["k"]
        if k == "let":
            portees[-1][s["nom"]] = self.eval(s["val"], portees)
        elif k == "if":
            if vrai(self.eval(s["cond"], portees)):
                self.bloc(s["alors"], portees + [{}])
            elif s["sinon"] is not None:
                self.bloc(s["sinon"], portees + [{}])
        elif k == "for":
            liste = self.eval(s["liste"], portees)
            if not isinstance(liste, list):
                raise SuperError("« for » attend une liste", "NOT_A_LIST")
            for item in liste:
                self.bloc(s["corps"], portees + [{s["nom"]: item}])
        elif k == "repeat":
            # Le corps travaille dans la portée courante : un accumulateur
            # traverse les tours et survit à la boucle.
            while True:
                self.etape()
                self.bloc(s["corps"], portees)
                if vrai(self.eval(s["until"], portees)):
                    return
        elif k == "confirm":
            # En mode conformité, un point d'arrêt est approuvé d'office.
            self.eval(s["val"], portees)
        elif k == "log":
            self.logs.append(texte_de(self.eval(s["val"], portees)))
        elif k == "done":
            raise Fini()
        elif k == "fail":
            raise SuperError(texte_de(self.eval(s["val"], portees)), "MISSION_FAILED")
        elif k == "expr":
            self.eval(s["val"], portees)
        else:
            raise SuperError(f"instruction inconnue : {k}", "INTERNAL")

    # -- expressions

    def eval(self, n, portees):
        k = n["k"]
        if k == "num":
            return n["val"]
        if k == "bool":
            return n["val"]
        if k == "null":
            return None
        if k == "str":
            return "".join(
                v if genre == "texte" else texte_de(self.eval(v, portees))
                for genre, v in n["parts"]
            )
        if k == "ident":
            for p in reversed(portees):
                if n["nom"] in p:
                    return p[n["nom"]]
            if n["nom"] in BUILTINS:
                return ("builtin", n["nom"])
            raise SuperError(f"« {n['nom']} » n'est pas défini", "UNDEFINED_NAME")
        if k == "it":
            for p in reversed(portees):
                if "it" in p:
                    return p["it"]
            raise SuperError("« it » hors d'un where ou d'un map", "UNDEFINED_NAME")
        if k == "liste":
            return [self.eval(x, portees) for x in n["items"]]
        if k == "fiche":
            return {nom: self.eval(v, portees) for nom, v in n["champs"]}
        if k == "champ":
            cible = self.eval(n["cible"], portees)
            if cible is None:
                return None
            if isinstance(cible, dict):
                return cible.get(n["nom"])
            if isinstance(cible, list) and n["nom"] == "len":
                return float(len(cible))
            return None
        if k == "index":
            cible = self.eval(n["cible"], portees)
            idx = self.eval(n["idx"], portees)
            if cible is None:
                return None
            if isinstance(cible, list):
                i = int(idx)
                return cible[i] if 0 <= i < len(cible) else None
            if isinstance(cible, dict):
                return cible.get(idx)
            return None
        if k == "un":
            v = self.eval(n["val"], portees)
            return (not vrai(v)) if n["op"] == "not" else -nombre(v)
        if k == "bin":
            return self.binaire(n, portees)
        if k in ("where", "map"):
            liste = self.eval(n["liste"], portees)
            if not isinstance(liste, list):
                raise SuperError(f"« {k} » attend une liste", "NOT_A_LIST")
            if k == "where":
                return [x for x in liste if vrai(self.eval(n["corps"], portees + [{"it": x}]))]
            return [self.eval(n["corps"], portees + [{"it": x}]) for x in liste]
        if k == "pipe":
            return self.applique(self.eval(n["d"], portees), [self.eval(n["g"], portees)])
        if k == "appel":
            fn = self.eval(n["cible"], portees)
            return self.applique(fn, [self.eval(a, portees) for a in n["args"]])
        if k == "effet":
            return self.effet(n, [self.eval(a, portees) for a in n["args"]])
        raise SuperError(f"expression inconnue : {k}", "INTERNAL")

    def binaire(self, n, portees):
        op = n["op"]
        if op == "and":
            return vrai(self.eval(n["g"], portees)) and vrai(self.eval(n["d"], portees))
        if op == "or":
            return vrai(self.eval(n["g"], portees)) or vrai(self.eval(n["d"], portees))
        a, b = self.eval(n["g"], portees), self.eval(n["d"], portees)
        if op == "+":
            if isinstance(a, list) and isinstance(b, list):
                return a + b
            if isinstance(a, str) or isinstance(b, str):
                return texte_de(a) + texte_de(b)
            return fini(nombre(a) + nombre(b), op)
        if op == "-":
            return fini(nombre(a) - nombre(b), op)
        if op == "*":
            return fini(nombre(a) * nombre(b), op)
        if op == "/":
            if nombre(b) == 0:
                raise SuperError("division par zéro", "ARITHMETIC_ERROR")
            return fini(nombre(a) / nombre(b), op)
        if op == "==":
            return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
        if op == "!=":
            return json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True)
        if op in ("<", ">", "<=", ">="):
            # Ordonner deux valeurs de natures différentes n'a pas de sens.
            meme = ((isinstance(a, (int, float)) and not isinstance(a, bool)
                     and isinstance(b, (int, float)) and not isinstance(b, bool))
                    or (isinstance(a, str) and isinstance(b, str)))
            if not meme:
                raise SuperError(f"« {op} » compare deux nombres ou deux textes", "TYPE_ERROR")
            if op == "<":
                return a < b
            if op == ">":
                return a > b
            if op == "<=":
                return a <= b
            return a >= b
        raise SuperError(f"opérateur inconnu : {op}", "INTERNAL")

    def applique(self, fn, args):
        if isinstance(fn, tuple) and fn[0] == "builtin":
            return BUILTINS[fn[1]](*args)
        raise SuperError("ceci n'est pas appelable", "NOT_CALLABLE")

    # -- effets

    def effet(self, n, args):
        ns, op = n["ns"], n["op"]
        cible = texte_de(args[0]) if args else ""
        self.autorise(ns, op, cible)
        self.etape()
        essais = n["essais"]
        derniere = None
        for _ in range(essais + 1):
            try:
                return self.faire(ns, op, args)
            except SuperError:
                raise
            except Exception as e:  # noqa: BLE001
                derniere = e
        raise SuperError(f"!{ns}.{op} a échoué : {derniere}", "EFFECT_FAILED")

    def faire(self, ns, op, args):
        if ns == "file":
            chemin = os.path.join(self.dossier, texte_de(args[0]))
            if op == "read":
                try:
                    with open(chemin, encoding="utf-8") as f:
                        return f.read()
                except OSError as e:
                    raise SuperError(str(e), "EFFECT_FAILED") from e
            if op in ("write", "append"):
                os.makedirs(os.path.dirname(chemin) or ".", exist_ok=True)
                with open(chemin, "a" if op == "append" else "w", encoding="utf-8") as f:
                    f.write(texte_de(args[1]) if len(args) > 1 else "")
                return texte_de(args[0])
        raise SuperError(f"effet non géré par cette implémentation : !{ns}.{op}", "EFFECT_FAILED")


# ---------------------------------------------------------------- intégrées


def _slice(l, a, b):
    a, b = int(a), int(b)
    return l[a:b]


def _unique(l):
    vus, out = [], []
    for x in l:
        cle = json.dumps(x, sort_keys=True)
        if cle not in vus:
            vus.append(cle)
            out.append(x)
    return out


BUILTINS = {
    "len": lambda x: float(0 if x is None else len(x)),
    "slice": _slice,
    "join": lambda l, sep="": sep.join(texte_de(x) for x in (l or [])),
    "split": lambda t, sep: texte_de(t).split(sep),
    "upper": lambda t: texte_de(t).upper(),
    "lower": lambda t: texte_de(t).lower(),
    "trim": lambda t: texte_de(t).strip(),
    "sum": lambda l: float(sum(nombre(x) for x in (l or []))),
    "sort": lambda l: sorted(l or []),
    "unique": _unique,
    "keys": lambda f: list((f or {}).keys()),
    "to_json": lambda x: json.dumps(normaliser(x), ensure_ascii=False, indent=2),
    "parse_json": lambda t: json.loads(texte_de(t)),
    "now": lambda: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    "int": lambda x: float(int(nombre(x))),
    "text": texte_de,
}


# ------------------------------------------------------------------ contrat

IGNORES = {".super", "fixtures.json"}


def lister_fichiers(racine):
    out = {}
    for dossier, sous, fichiers in os.walk(racine):
        sous[:] = sorted(d for d in sous if d not in IGNORES)
        for f in sorted(fichiers):
            if f in IGNORES or f.endswith(".sup") or f.endswith(".expected.json"):
                continue
            complet = os.path.join(dossier, f)
            relatif = os.path.relpath(complet, racine)
            try:
                with open(complet, encoding="utf-8") as fh:
                    out[relatif] = fh.read()
            except (OSError, UnicodeDecodeError):
                pass
    return out


def main(argv):
    if len(argv) < 2 or argv[0] != "conform":
        print("usage : super.py conform <fichier.sup> --dir <dossier>", file=sys.stderr)
        return 2
    fichier = argv[1]
    dossier = os.path.dirname(os.path.abspath(fichier))
    if "--dir" in argv:
        dossier = argv[argv.index("--dir") + 1]

    logs, erreur = [], None
    try:
        with open(fichier, encoding="utf-8") as f:
            missions = Analyseur(lexer(f.read())).programme()
        if not missions:
            raise SuperError("aucune mission dans ce fichier", "SYNTAX_ERROR")
        interp = Interprete(missions[0], dossier)
        try:
            interp.bloc(missions[0]["corps"], [{}])
        except Fini:
            pass
        logs = interp.logs
    except SuperError as e:
        logs = interp.logs if "interp" in dir() and hasattr(interp, "logs") else logs
        erreur = {"code": e.code}
    except Exception as e:  # noqa: BLE001
        print(repr(e), file=sys.stderr)
        erreur = {"code": "INTERNAL"}

    print(json.dumps({"logs": logs, "error": erreur, "files": lister_fichiers(dossier)},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
