//! Troisième implémentation de Super Code, en Rust, bibliothèque standard seule.
//!
//! Elle existe pour une raison précise : Node et Python se ressemblent trop.
//! Tous deux ont un seul type numérique utile, des chaînes indexées par point de
//! code ou presque, des tables ordonnées et du JSON natif. Ils tombent d'accord
//! par accident. Rust ne tombe d'accord sur rien par accident : les entiers et
//! les flottants sont distincts, une chaîne est une suite d'octets UTF-8, une
//! HashMap n'a pas d'ordre, et il n'y a pas de null.
//!
//! Écrite d'après spec/GRAMMAR.md et conformance/CONTRACT.md, sans partager une
//! ligne avec les deux autres. Couvre le niveau 1 de la suite : sémantique pure,
//! effets sur fichiers, capacités, budget, règles refusées à l'analyse.
//!
//!     super-rs conform mission.sup --dir /un/dossier

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

// ----------------------------------------------------------------- erreurs

#[derive(Debug)]
struct SErr {
    code: &'static str,
    #[allow(dead_code)]
    msg: String,
}

impl SErr {
    fn new(code: &'static str, msg: impl Into<String>) -> Self {
        SErr { code, msg: msg.into() }
    }
    fn syntaxe(msg: impl Into<String>) -> Self {
        SErr::new("SYNTAX_ERROR", msg)
    }
}

type R<T> = Result<T, SErr>;

// ----------------------------------------------------------------- lexique

const MOTS_CLES: &[&str] = &[
    "mission", "skill", "uses", "budget", "every", "let", "if", "else", "for", "in", "repeat",
    "until", "confirm", "log", "done", "fail", "where", "map", "retry", "timeout", "as", "and",
    "or", "not", "true", "false", "null", "it", "steps",
];

// Les symboles longs d'abord : l'ordre compte.
const SYMBOLES: &[&str] = &[
    "|>", "->", "==", "!=", "<=", ">=", "{", "}", "(", ")", "[", "]", ",", ":", ".", "!", "~",
    "<", ">", "+", "-", "*", "/", "=",
];

#[derive(Clone, Debug, PartialEq)]
enum Part {
    Texte(String),
    Code(String),
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Dur(f64),
    Money(f64),
    Str(Vec<Part>),
    Ident(String),
    Kw(String),
    Sym(String),
    Eof,
}

fn duree(unite: &str) -> Option<f64> {
    match unite {
        "ms" => Some(1.0),
        "s" => Some(1000.0),
        "min" => Some(60000.0),
        "h" => Some(3600000.0),
        "d" => Some(86400000.0),
        _ => None,
    }
}

fn echappement(c: char) -> Option<char> {
    match c {
        'n' => Some('\n'),
        't' => Some('\t'),
        '"' => Some('"'),
        '\\' => Some('\\'),
        '{' => Some('{'),
        '}' => Some('}'),
        _ => None,
    }
}

fn lexer(src: &str) -> R<Vec<Tok>> {
    // On travaille sur les points de code, pas sur les octets : une chaîne de
    // Super Code est une suite de points de code (spec, section 10).
    let cs: Vec<char> = src.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0usize;

    while i < cs.len() {
        let c = cs[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '#' {
            while i < cs.len() && cs[i] != '\n' {
                i += 1;
            }
            continue;
        }

        if c == '"' {
            i += 1;
            let mut parts: Vec<Part> = Vec::new();
            let mut buf = String::new();
            while i < cs.len() && cs[i] != '"' {
                if cs[i] == '\\' {
                    let suivant = *cs.get(i + 1).ok_or_else(|| SErr::syntaxe("texte non fermé"))?;
                    match echappement(suivant) {
                        Some(e) => {
                            buf.push(e);
                            i += 2;
                        }
                        None => return Err(SErr::syntaxe(format!("échappement inconnu \\{suivant}"))),
                    }
                    continue;
                }
                if cs[i] == '{' {
                    if !buf.is_empty() {
                        parts.push(Part::Texte(std::mem::take(&mut buf)));
                    }
                    i += 1;
                    let mut profondeur = 1;
                    let mut code = String::new();
                    while i < cs.len() && profondeur > 0 {
                        if cs[i] == '{' {
                            profondeur += 1;
                        } else if cs[i] == '}' {
                            profondeur -= 1;
                            if profondeur == 0 {
                                break;
                            }
                        }
                        code.push(cs[i]);
                        i += 1;
                    }
                    if profondeur != 0 {
                        return Err(SErr::syntaxe("interpolation { non fermée"));
                    }
                    i += 1;
                    parts.push(Part::Code(code));
                    continue;
                }
                buf.push(cs[i]);
                i += 1;
            }
            if i >= cs.len() {
                return Err(SErr::syntaxe("texte non fermé"));
            }
            i += 1;
            if !buf.is_empty() || parts.is_empty() {
                parts.push(Part::Texte(buf));
            }
            toks.push(Tok::Str(parts));
            continue;
        }

        if c.is_ascii_digit() {
            let debut = i;
            while i < cs.len() && (cs[i].is_ascii_digit() || cs[i] == '.') {
                i += 1;
            }
            let nombre: String = cs[debut..i].iter().collect();
            let valeur: f64 = nombre.parse().map_err(|_| SErr::syntaxe("nombre invalide"))?;
            let mut suffixe = String::new();
            while i < cs.len() && cs[i].is_alphabetic() {
                suffixe.push(cs[i]);
                i += 1;
            }
            if suffixe.is_empty() {
                toks.push(Tok::Num(valeur));
            } else if let Some(f) = duree(&suffixe) {
                toks.push(Tok::Dur(valeur * f));
            } else if suffixe == "usd" || suffixe == "eur" {
                toks.push(Tok::Money(valeur));
            } else {
                return Err(SErr::syntaxe(format!("suffixe numérique inconnu « {suffixe} »")));
            }
            continue;
        }

        if c.is_alphabetic() || c == '_' {
            let debut = i;
            while i < cs.len() && (cs[i].is_alphanumeric() || cs[i] == '_') {
                i += 1;
            }
            let mot: String = cs[debut..i].iter().collect();
            if MOTS_CLES.contains(&mot.as_str()) {
                toks.push(Tok::Kw(mot));
            } else {
                toks.push(Tok::Ident(mot));
            }
            continue;
        }

        let reste: String = cs[i..].iter().collect();
        let mut trouve = false;
        for s in SYMBOLES {
            if reste.starts_with(s) {
                toks.push(Tok::Sym((*s).to_string()));
                i += s.chars().count();
                trouve = true;
                break;
            }
        }
        if !trouve {
            return Err(SErr::syntaxe(format!("caractère inattendu « {c} »")));
        }
    }

    toks.push(Tok::Eof);
    Ok(toks)
}

// ----------------------------------------------------------------- syntaxe

#[derive(Clone, Debug)]
enum Expr {
    Num(f64),
    Bool(bool),
    Null,
    It,
    Texte(Vec<TextePart>),
    Ident(String),
    Liste(Vec<Expr>),
    Fiche(Vec<(String, Expr)>),
    Champ(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Appel(Box<Expr>, Vec<Expr>),
    Bin(String, Box<Expr>, Box<Expr>),
    Un(String, Box<Expr>),
    Filtre(String, Box<Expr>, Box<Expr>),
    Pipe(Box<Expr>, Box<Expr>),
    Effet(String, String, Vec<Expr>),
}

#[derive(Clone, Debug)]
enum TextePart {
    Texte(String),
    Code(Box<Expr>),
}

#[derive(Clone, Debug)]
enum Inst {
    Let(String, Expr),
    If(Expr, Vec<Inst>, Option<Vec<Inst>>),
    For(String, Expr, Vec<Inst>),
    Repeat(Vec<Inst>, Expr),
    Confirm(Expr),
    Log(Expr),
    Done,
    Fail(Expr),
    Expression(Expr),
}

struct Capacite {
    ns: String,
    op: String,
    motif: String,
}

struct Mission {
    uses: Vec<Capacite>,
    etapes_max: Option<f64>,
    ms_max: Option<f64>,
    corps: Vec<Inst>,
}

struct Analyseur {
    toks: Vec<Tok>,
    p: usize,
}

impl Analyseur {
    fn new(toks: Vec<Tok>) -> Self {
        Analyseur { toks, p: 0 }
    }
    fn cur(&self) -> &Tok {
        &self.toks[self.p]
    }
    fn avance(&mut self) -> Tok {
        self.p += 1;
        self.toks[self.p - 1].clone()
    }
    fn est_sym(&self, s: &str) -> bool {
        matches!(self.cur(), Tok::Sym(x) if x == s)
    }
    fn est_kw(&self, k: &str) -> bool {
        matches!(self.cur(), Tok::Kw(x) if x == k)
    }
    fn mange_sym(&mut self, s: &str) -> R<()> {
        if self.est_sym(s) {
            self.p += 1;
            Ok(())
        } else {
            Err(SErr::syntaxe(format!("attendu « {s} », trouvé {:?}", self.cur())))
        }
    }
    fn mange_kw(&mut self, k: &str) -> R<()> {
        if self.est_kw(k) {
            self.p += 1;
            Ok(())
        } else {
            Err(SErr::syntaxe(format!("attendu « {k} », trouvé {:?}", self.cur())))
        }
    }
    fn mange_ident(&mut self) -> R<String> {
        match self.avance() {
            Tok::Ident(s) => Ok(s),
            autre => Err(SErr::syntaxe(format!("identifiant attendu, trouvé {autre:?}"))),
        }
    }
    fn essaie_sym(&mut self, s: &str) -> bool {
        if self.est_sym(s) {
            self.p += 1;
            true
        } else {
            false
        }
    }

    // -- programme

    fn programme(&mut self) -> R<Mission> {
        while !matches!(self.cur(), Tok::Eof) {
            if self.est_kw("mission") {
                return self.mission();
            }
            if self.est_kw("skill") {
                return Err(SErr::syntaxe("les skills ne sont pas gérés par cette implémentation"));
            }
            return Err(SErr::syntaxe("attendu « mission » au premier niveau"));
        }
        Err(SErr::syntaxe("aucune mission dans ce fichier"))
    }

    fn mission(&mut self) -> R<Mission> {
        self.mange_kw("mission")?;
        let _nom = self.mange_ident()?;
        self.mange_sym("{")?;
        let mut uses = Vec::new();
        let mut etapes_max = None;
        let mut ms_max = None;

        loop {
            if self.est_kw("uses") {
                self.p += 1;
                loop {
                    let ns = self.mange_ident()?;
                    self.mange_sym(".")?;
                    let op = self.mange_ident()?;
                    self.mange_sym("(")?;
                    let motif = match self.avance() {
                        Tok::Str(parts) => texte_constant(&parts)?,
                        _ => return Err(SErr::syntaxe("motif de capacité attendu")),
                    };
                    self.mange_sym(")")?;
                    uses.push(Capacite { ns, op, motif });
                    if !self.essaie_sym(",") {
                        break;
                    }
                }
            } else if self.est_kw("budget") {
                self.p += 1;
                loop {
                    match self.avance() {
                        Tok::Money(_) => {}
                        Tok::Dur(v) => ms_max = Some(v),
                        Tok::Num(v) => {
                            self.mange_kw("steps")?;
                            etapes_max = Some(v);
                        }
                        _ => return Err(SErr::syntaxe("limite de budget invalide")),
                    }
                    if !self.essaie_sym(",") {
                        break;
                    }
                }
            } else if self.est_kw("every") {
                self.p += 1;
                self.avance();
            } else {
                break;
            }
        }

        let corps = self.corps()?;
        self.mange_sym("}")?;

        if contient_repeat(&corps) && etapes_max.is_none() && ms_max.is_none() {
            return Err(SErr::syntaxe(
                "une mission contenant un « repeat » doit déclarer un budget en étapes ou en durée",
            ));
        }
        Ok(Mission { uses, etapes_max, ms_max, corps })
    }

    // -- instructions

    fn corps(&mut self) -> R<Vec<Inst>> {
        let mut out = Vec::new();
        while !self.est_sym("}") && !matches!(self.cur(), Tok::Eof) {
            out.push(self.instruction()?);
        }
        Ok(out)
    }

    fn bloc(&mut self) -> R<Vec<Inst>> {
        self.mange_sym("{")?;
        let out = self.corps()?;
        self.mange_sym("}")?;
        Ok(out)
    }

    fn instruction(&mut self) -> R<Inst> {
        if self.est_kw("let") {
            self.p += 1;
            let nom = self.mange_ident()?;
            self.mange_sym("=")?;
            return Ok(Inst::Let(nom, self.expr()?));
        }
        if self.est_kw("if") {
            self.p += 1;
            let cond = self.expr()?;
            let alors = self.bloc()?;
            let sinon = if self.est_kw("else") {
                self.p += 1;
                Some(self.bloc()?)
            } else {
                None
            };
            return Ok(Inst::If(cond, alors, sinon));
        }
        if self.est_kw("for") {
            self.p += 1;
            let nom = self.mange_ident()?;
            self.mange_kw("in")?;
            let liste = self.expr()?;
            return Ok(Inst::For(nom, liste, self.bloc()?));
        }
        if self.est_kw("repeat") {
            self.p += 1;
            let corps = self.bloc()?;
            self.mange_kw("until")?;
            return Ok(Inst::Repeat(corps, self.expr()?));
        }
        if self.est_kw("confirm") {
            self.p += 1;
            let val = self.expr()?;
            if !contient_effet(&val) {
                return Err(SErr::syntaxe("« confirm » doit porter sur un effet"));
            }
            return Ok(Inst::Confirm(val));
        }
        if self.est_kw("log") {
            self.p += 1;
            return Ok(Inst::Log(self.expr()?));
        }
        if self.est_kw("done") {
            self.p += 1;
            return Ok(Inst::Done);
        }
        if self.est_kw("fail") {
            self.p += 1;
            return Ok(Inst::Fail(self.expr()?));
        }
        Ok(Inst::Expression(self.expr()?))
    }

    // -- expressions, par précédence croissante

    fn expr(&mut self) -> R<Expr> {
        self.tube()
    }

    fn tube(&mut self) -> R<Expr> {
        let mut g = self.filtre()?;
        while self.est_sym("|>") {
            self.p += 1;
            g = Expr::Pipe(Box::new(g), Box::new(self.filtre()?));
        }
        Ok(g)
    }

    fn filtre(&mut self) -> R<Expr> {
        let mut g = self.ou()?;
        loop {
            let op = if self.est_kw("where") {
                "where"
            } else if self.est_kw("map") {
                "map"
            } else {
                break;
            };
            self.p += 1;
            g = Expr::Filtre(op.to_string(), Box::new(g), Box::new(self.ou()?));
        }
        Ok(g)
    }

    fn ou(&mut self) -> R<Expr> {
        let mut g = self.et()?;
        while self.est_kw("or") {
            self.p += 1;
            g = Expr::Bin("or".into(), Box::new(g), Box::new(self.et()?));
        }
        Ok(g)
    }

    fn et(&mut self) -> R<Expr> {
        let mut g = self.comparaison()?;
        while self.est_kw("and") {
            self.p += 1;
            g = Expr::Bin("and".into(), Box::new(g), Box::new(self.comparaison()?));
        }
        Ok(g)
    }

    fn comparaison(&mut self) -> R<Expr> {
        let mut g = self.somme()?;
        loop {
            let op = match self.cur() {
                Tok::Sym(s) if ["==", "!=", "<", ">", "<=", ">="].contains(&s.as_str()) => s.clone(),
                _ => break,
            };
            self.p += 1;
            g = Expr::Bin(op, Box::new(g), Box::new(self.somme()?));
        }
        Ok(g)
    }

    fn somme(&mut self) -> R<Expr> {
        let mut g = self.produit()?;
        loop {
            let op = match self.cur() {
                Tok::Sym(s) if s == "+" || s == "-" => s.clone(),
                _ => break,
            };
            self.p += 1;
            g = Expr::Bin(op, Box::new(g), Box::new(self.produit()?));
        }
        Ok(g)
    }

    fn produit(&mut self) -> R<Expr> {
        let mut g = self.unaire()?;
        loop {
            let op = match self.cur() {
                Tok::Sym(s) if s == "*" || s == "/" => s.clone(),
                _ => break,
            };
            self.p += 1;
            g = Expr::Bin(op, Box::new(g), Box::new(self.unaire()?));
        }
        Ok(g)
    }

    fn unaire(&mut self) -> R<Expr> {
        if self.est_kw("not") {
            self.p += 1;
            return Ok(Expr::Un("not".into(), Box::new(self.unaire()?)));
        }
        if self.est_sym("-") {
            self.p += 1;
            return Ok(Expr::Un("-".into(), Box::new(self.unaire()?)));
        }
        self.suffixe()
    }

    fn suffixe(&mut self) -> R<Expr> {
        let mut n = self.primaire()?;
        loop {
            if self.est_sym(".") {
                self.p += 1;
                n = Expr::Champ(Box::new(n), self.mange_ident()?);
            } else if self.est_sym("[") {
                self.p += 1;
                let idx = self.expr()?;
                self.mange_sym("]")?;
                n = Expr::Index(Box::new(n), Box::new(idx));
            } else if self.est_sym("(") {
                n = Expr::Appel(Box::new(n), self.args()?);
            } else {
                return Ok(n);
            }
        }
    }

    fn args(&mut self) -> R<Vec<Expr>> {
        self.mange_sym("(")?;
        let mut out = Vec::new();
        if !self.est_sym(")") {
            loop {
                out.push(self.expr()?);
                if !self.essaie_sym(",") {
                    break;
                }
            }
        }
        self.mange_sym(")")?;
        Ok(out)
    }

    fn primaire(&mut self) -> R<Expr> {
        match self.cur().clone() {
            Tok::Num(v) | Tok::Dur(v) | Tok::Money(v) => {
                self.p += 1;
                Ok(Expr::Num(v))
            }
            Tok::Str(parts) => {
                self.p += 1;
                let mut out = Vec::new();
                for p in parts {
                    match p {
                        Part::Texte(t) => out.push(TextePart::Texte(t)),
                        Part::Code(c) => {
                            let mut sous = Analyseur::new(lexer(&c)?);
                            out.push(TextePart::Code(Box::new(sous.expr()?)));
                        }
                    }
                }
                Ok(Expr::Texte(out))
            }
            Tok::Kw(k) => match k.as_str() {
                "true" => {
                    self.p += 1;
                    Ok(Expr::Bool(true))
                }
                "false" => {
                    self.p += 1;
                    Ok(Expr::Bool(false))
                }
                "null" => {
                    self.p += 1;
                    Ok(Expr::Null)
                }
                "it" => {
                    self.p += 1;
                    Ok(Expr::It)
                }
                _ => Err(SErr::syntaxe(format!("expression attendue, trouvé « {k} »"))),
            },
            Tok::Ident(nom) => {
                self.p += 1;
                Ok(Expr::Ident(nom))
            }
            Tok::Sym(s) => match s.as_str() {
                // « .champ » vaut « it.champ » : le point est laissé au suffixe.
                "." => Ok(Expr::It),
                "(" => {
                    self.p += 1;
                    let e = self.expr()?;
                    self.mange_sym(")")?;
                    Ok(e)
                }
                "[" => {
                    self.p += 1;
                    let mut items = Vec::new();
                    if !self.est_sym("]") {
                        loop {
                            items.push(self.expr()?);
                            if !self.essaie_sym(",") {
                                break;
                            }
                        }
                    }
                    self.mange_sym("]")?;
                    Ok(Expr::Liste(items))
                }
                "{" => {
                    self.p += 1;
                    let mut champs = Vec::new();
                    if !self.est_sym("}") {
                        loop {
                            let nom = self.mange_ident()?;
                            self.mange_sym(":")?;
                            champs.push((nom, self.expr()?));
                            if !self.essaie_sym(",") {
                                break;
                            }
                        }
                    }
                    self.mange_sym("}")?;
                    Ok(Expr::Fiche(champs))
                }
                "!" => {
                    self.p += 1;
                    let ns = self.mange_ident()?;
                    self.mange_sym(".")?;
                    let op = self.mange_ident()?;
                    let args = self.args()?;
                    // retry / timeout : acceptés, sans effet au niveau 1.
                    loop {
                        if self.est_kw("retry") {
                            self.p += 1;
                            self.avance();
                        } else if self.est_kw("timeout") {
                            self.p += 1;
                            self.avance();
                        } else {
                            break;
                        }
                    }
                    Ok(Expr::Effet(ns, op, args))
                }
                "~" => Err(SErr::syntaxe("l'opérateur ~ n'est pas géré par cette implémentation")),
                autre => Err(SErr::syntaxe(format!("expression attendue, trouvé « {autre} »"))),
            },
            Tok::Eof => Err(SErr::syntaxe("fin de fichier inattendue")),
        }
    }
}

fn texte_constant(parts: &[Part]) -> R<String> {
    let mut out = String::new();
    for p in parts {
        match p {
            Part::Texte(t) => out.push_str(t),
            Part::Code(_) => return Err(SErr::syntaxe("interpolation interdite ici")),
        }
    }
    Ok(out)
}

fn contient_repeat(corps: &[Inst]) -> bool {
    corps.iter().any(|i| match i {
        Inst::Repeat(_, _) => true,
        Inst::If(_, a, b) => contient_repeat(a) || b.as_deref().map(contient_repeat).unwrap_or(false),
        Inst::For(_, _, c) => contient_repeat(c),
        _ => false,
    })
}

fn contient_effet(e: &Expr) -> bool {
    match e {
        Expr::Effet(_, _, _) => true,
        Expr::Texte(parts) => parts.iter().any(|p| match p {
            TextePart::Code(c) => contient_effet(c),
            _ => false,
        }),
        Expr::Liste(xs) => xs.iter().any(contient_effet),
        Expr::Fiche(fs) => fs.iter().any(|(_, v)| contient_effet(v)),
        Expr::Champ(t, _) => contient_effet(t),
        Expr::Index(t, i) => contient_effet(t) || contient_effet(i),
        Expr::Appel(t, a) => contient_effet(t) || a.iter().any(contient_effet),
        Expr::Bin(_, g, d) | Expr::Filtre(_, g, d) | Expr::Pipe(g, d) => {
            contient_effet(g) || contient_effet(d)
        }
        Expr::Un(_, v) => contient_effet(v),
        _ => false,
    }
}

// ----------------------------------------------------------------- valeurs

#[derive(Clone, Debug)]
enum Val {
    Null,
    Bool(bool),
    Num(f64),
    Texte(String),
    Liste(Vec<Val>),
    // Un vecteur de paires, pas une table : une fiche garde l'ordre de ses
    // champs pour « keys » et « to_json » (spec, section 6).
    Fiche(Vec<(String, Val)>),
    Integree(String),
}

fn nombre_en_texte(v: f64) -> String {
    // Un nombre entier s'écrit sans partie décimale (spec, section 9).
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v}");
        s
    }
}

/// Il n'existe ni infini ni « pas un nombre » dans Super Code : une mission qui
/// écrit « inf » dans un rapport est pire qu'une mission qui s'arrête.
fn fini(v: f64, op: &str) -> R<f64> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(SErr::new("ARITHMETIC_ERROR", format!("« {op} » ne donne pas un nombre fini")))
    }
}

fn texte_de(v: &Val) -> String {
    match v {
        Val::Null => String::new(),
        Val::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
        Val::Num(n) => nombre_en_texte(*n),
        Val::Texte(t) => t.clone(),
        _ => json_compact(v),
    }
}

fn vrai(v: &Val) -> bool {
    match v {
        Val::Null => false,
        Val::Bool(b) => *b,
        Val::Num(n) => *n != 0.0,
        Val::Texte(t) => !t.is_empty(),
        Val::Liste(l) => !l.is_empty(),
        Val::Fiche(f) => !f.is_empty(),
        Val::Integree(_) => true,
    }
}

fn nombre(v: &Val) -> f64 {
    match v {
        Val::Num(n) => *n,
        Val::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Val::Texte(t) => t.parse().unwrap_or(f64::NAN),
        Val::Null => 0.0,
        _ => f64::NAN,
    }
}

/// Égalité structurelle : l'ordre des champs d'une fiche ne compte pas.
fn egal(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Null, Val::Null) => true,
        (Val::Bool(x), Val::Bool(y)) => x == y,
        (Val::Num(x), Val::Num(y)) => x == y,
        (Val::Texte(x), Val::Texte(y)) => x == y,
        (Val::Liste(x), Val::Liste(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| egal(a, b)),
        (Val::Fiche(x), Val::Fiche(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, v)| y.iter().any(|(k2, v2)| k == k2 && egal(v, v2)))
        }
        _ => false,
    }
}

fn echapper_json(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_compact(v: &Val) -> String {
    match v {
        Val::Null => "null".into(),
        Val::Bool(b) => b.to_string(),
        Val::Num(n) => nombre_en_texte(*n),
        Val::Texte(t) => echapper_json(t),
        Val::Liste(l) => format!("[{}]", l.iter().map(json_compact).collect::<Vec<_>>().join(",")),
        Val::Fiche(f) => format!(
            "{{{}}}",
            f.iter()
                .map(|(k, v)| format!("{}:{}", echapper_json(k), json_compact(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Val::Integree(_) => "null".into(),
    }
}

fn json_indente(v: &Val, niveau: usize) -> String {
    let pad = "  ".repeat(niveau);
    let pad2 = "  ".repeat(niveau + 1);
    match v {
        Val::Liste(l) if !l.is_empty() => format!(
            "[\n{}\n{}]",
            l.iter().map(|x| format!("{pad2}{}", json_indente(x, niveau + 1))).collect::<Vec<_>>().join(",\n"),
            pad
        ),
        Val::Liste(_) => "[]".into(),
        Val::Fiche(f) if !f.is_empty() => format!(
            "{{\n{}\n{}}}",
            f.iter()
                .map(|(k, x)| format!("{pad2}{}: {}", echapper_json(k), json_indente(x, niveau + 1)))
                .collect::<Vec<_>>()
                .join(",\n"),
            pad
        ),
        Val::Fiche(_) => "{}".into(),
        autre => json_compact(autre),
    }
}

// -------------------------------------------------------------- exécution

enum Arret {
    Fini,
    Erreur(SErr),
}

impl From<SErr> for Arret {
    fn from(e: SErr) -> Self {
        Arret::Erreur(e)
    }
}

type X<T> = Result<T, Arret>;

struct Interprete {
    mission: Mission,
    dossier: PathBuf,
    logs: Vec<String>,
    etapes: f64,
    debut: Instant,
}

type Portees = Vec<Vec<(String, Val)>>;

fn lire(portees: &Portees, nom: &str) -> Option<Val> {
    for p in portees.iter().rev() {
        for (k, v) in p.iter().rev() {
            if k == nom {
                return Some(v.clone());
            }
        }
    }
    None
}

/// `*` couvre un segment, `**` couvre tout le reste. Écrit à la main : pas de
/// dépendance, donc pas de moteur d'expressions régulières.
fn motif_correspond(motif: &str, valeur: &str) -> bool {
    let segments: Vec<&str> = motif.split("**").collect();
    correspond_multi(&segments, valeur, true)
}

fn correspond_multi(segments: &[&str], valeur: &str, debut: bool) -> bool {
    if segments.len() == 1 {
        return correspond_simple(segments[0], valeur, debut, true);
    }
    let premier = segments[0];
    // Le premier segment doit coller au début.
    let mut restes: Vec<usize> = Vec::new();
    for fin in 0..=valeur.len() {
        if valeur.is_char_boundary(fin) && correspond_simple(premier, &valeur[..fin], debut, true) {
            restes.push(fin);
        }
    }
    for r in restes {
        // `**` absorbe n'importe quoi ensuite.
        let suite = &valeur[r..];
        for saut in 0..=suite.len() {
            if !suite.is_char_boundary(saut) {
                continue;
            }
            if correspond_multi(&segments[1..], &suite[saut..], false) {
                return true;
            }
        }
    }
    false
}

fn correspond_simple(motif: &str, valeur: &str, _debut: bool, _fin: bool) -> bool {
    let parties: Vec<&str> = motif.split('*').collect();
    if parties.len() == 1 {
        return motif == valeur;
    }
    let mut pos = 0usize;
    for (i, partie) in parties.iter().enumerate() {
        if i == 0 {
            if !valeur[pos..].starts_with(partie) {
                return false;
            }
            pos += partie.len();
            continue;
        }
        // `*` ne franchit pas un « / ».
        let reste = &valeur[pos..];
        let borne = reste.find('/').unwrap_or(reste.len());
        if i == parties.len() - 1 {
            if partie.is_empty() {
                return !reste[..borne].contains('/') && pos + borne == valeur.len();
            }
            match reste[..borne].find(partie) {
                Some(k) if pos + k + partie.len() == valeur.len() => return true,
                _ => return false,
            }
        }
        match reste[..borne].find(partie) {
            Some(k) => pos += k + partie.len(),
            None => return false,
        }
    }
    pos == valeur.len()
}

impl Interprete {
    fn etape(&mut self) -> R<()> {
        self.etapes += 1.0;
        if let Some(max) = self.mission.etapes_max {
            if self.etapes > max {
                return Err(SErr::new("BUDGET_EXCEEDED", "budget épuisé : étapes"));
            }
        }
        if let Some(max) = self.mission.ms_max {
            if self.debut.elapsed().as_millis() as f64 > max {
                return Err(SErr::new("BUDGET_EXCEEDED", "budget épuisé : durée"));
            }
        }
        Ok(())
    }

    fn autorise(&self, ns: &str, op: &str, cible: &str) -> R<()> {
        for c in &self.mission.uses {
            if c.ns == ns && c.op == op && motif_correspond(&c.motif, cible) {
                return Ok(());
            }
        }
        Err(SErr::new(
            "CAPABILITY_DENIED",
            format!("capacité refusée : {ns}.{op}(\"{cible}\")"),
        ))
    }

    fn bloc(&mut self, insts: &[Inst], portees: &mut Portees) -> X<()> {
        for i in insts {
            self.instruction(i, portees)?;
        }
        Ok(())
    }

    fn instruction(&mut self, inst: &Inst, portees: &mut Portees) -> X<()> {
        match inst {
            Inst::Let(nom, e) => {
                let v = self.eval(e, portees)?;
                let dernier = portees.last_mut().unwrap();
                if let Some(slot) = dernier.iter_mut().find(|(k, _)| k == nom) {
                    slot.1 = v;
                } else {
                    dernier.push((nom.clone(), v));
                }
                Ok(())
            }
            Inst::If(cond, alors, sinon) => {
                let c = self.eval(cond, portees)?;
                if vrai(&c) {
                    portees.push(Vec::new());
                    let r = self.bloc(alors, portees);
                    portees.pop();
                    r
                } else if let Some(s) = sinon {
                    portees.push(Vec::new());
                    let r = self.bloc(s, portees);
                    portees.pop();
                    r
                } else {
                    Ok(())
                }
            }
            Inst::For(nom, liste, corps) => {
                let l = self.eval(liste, portees)?;
                let items = match l {
                    Val::Liste(x) => x,
                    _ => return Err(SErr::new("NOT_A_LIST", "« for » attend une liste").into()),
                };
                for item in items {
                    portees.push(vec![(nom.clone(), item)]);
                    let r = self.bloc(corps, portees);
                    portees.pop();
                    r?;
                }
                Ok(())
            }
            Inst::Repeat(corps, until) => loop {
                self.etape()?;
                self.bloc(corps, portees)?;
                let c = self.eval(until, portees)?;
                if vrai(&c) {
                    return Ok(());
                }
            },
            // En mode conformité, un point d'arrêt est approuvé d'office.
            Inst::Confirm(e) => {
                self.eval(e, portees)?;
                Ok(())
            }
            Inst::Log(e) => {
                let v = self.eval(e, portees)?;
                self.logs.push(texte_de(&v));
                Ok(())
            }
            Inst::Done => Err(Arret::Fini),
            Inst::Fail(e) => {
                let v = self.eval(e, portees)?;
                Err(SErr::new("MISSION_FAILED", texte_de(&v)).into())
            }
            Inst::Expression(e) => {
                self.eval(e, portees)?;
                Ok(())
            }
        }
    }

    fn eval(&mut self, e: &Expr, portees: &mut Portees) -> X<Val> {
        Ok(match e {
            Expr::Num(v) => Val::Num(*v),
            Expr::Bool(b) => Val::Bool(*b),
            Expr::Null => Val::Null,
            Expr::It => lire(portees, "it")
                .ok_or_else(|| SErr::new("UNDEFINED_NAME", "« it » hors d'un where ou d'un map"))?,
            Expr::Texte(parts) => {
                let mut out = String::new();
                for p in parts {
                    match p {
                        TextePart::Texte(t) => out.push_str(t),
                        TextePart::Code(c) => {
                            let v = self.eval(c, portees)?;
                            out.push_str(&texte_de(&v));
                        }
                    }
                }
                Val::Texte(out)
            }
            Expr::Ident(nom) => match lire(portees, nom) {
                Some(v) => v,
                None if INTEGREES.contains(&nom.as_str()) => Val::Integree(nom.clone()),
                None => {
                    return Err(SErr::new("UNDEFINED_NAME", format!("« {nom} » n'est pas défini")).into())
                }
            },
            Expr::Liste(items) => {
                let mut out = Vec::new();
                for i in items {
                    out.push(self.eval(i, portees)?);
                }
                Val::Liste(out)
            }
            Expr::Fiche(champs) => {
                // Un champ répété remplace le précédent, sans changer sa place :
                // même règle qu'en JSON, et « {a: 1, a: 2} » vaut « {a: 2} ».
                let mut out: Vec<(String, Val)> = Vec::new();
                for (k, v) in champs {
                    let val = self.eval(v, portees)?;
                    match out.iter_mut().find(|(n, _)| n == k) {
                        Some(slot) => slot.1 = val,
                        None => out.push((k.clone(), val)),
                    }
                }
                Val::Fiche(out)
            }
            Expr::Champ(cible, nom) => {
                let c = self.eval(cible, portees)?;
                match c {
                    Val::Fiche(f) => f.iter().find(|(k, _)| k == nom).map(|(_, v)| v.clone()).unwrap_or(Val::Null),
                    Val::Liste(l) if nom == "len" => Val::Num(l.len() as f64),
                    _ => Val::Null,
                }
            }
            Expr::Index(cible, idx) => {
                let c = self.eval(cible, portees)?;
                let i = self.eval(idx, portees)?;
                match c {
                    Val::Liste(l) => {
                        let k = nombre(&i);
                        if k < 0.0 || k as usize >= l.len() || k.fract() != 0.0 {
                            Val::Null
                        } else {
                            l[k as usize].clone()
                        }
                    }
                    Val::Fiche(f) => {
                        let k = texte_de(&i);
                        f.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap_or(Val::Null)
                    }
                    Val::Texte(t) => {
                        let k = nombre(&i);
                        t.chars().nth(k as usize).map(|c| Val::Texte(c.to_string())).unwrap_or(Val::Null)
                    }
                    _ => Val::Null,
                }
            }
            Expr::Un(op, v) => {
                let x = self.eval(v, portees)?;
                if op == "not" {
                    Val::Bool(!vrai(&x))
                } else {
                    Val::Num(-nombre(&x))
                }
            }
            Expr::Bin(op, g, d) => return self.binaire(op, g, d, portees),
            Expr::Filtre(op, liste, corps) => {
                let l = self.eval(liste, portees)?;
                let items = match l {
                    Val::Liste(x) => x,
                    _ => return Err(SErr::new("NOT_A_LIST", format!("« {op} » attend une liste")).into()),
                };
                let mut out = Vec::new();
                for item in items {
                    portees.push(vec![("it".to_string(), item.clone())]);
                    let r = self.eval(corps, portees);
                    portees.pop();
                    let v = r?;
                    if op == "where" {
                        if vrai(&v) {
                            out.push(item);
                        }
                    } else {
                        out.push(v);
                    }
                }
                Val::Liste(out)
            }
            Expr::Pipe(g, d) => {
                let val = self.eval(g, portees)?;
                let f = self.eval(d, portees)?;
                self.applique(&f, vec![val])?
            }
            Expr::Appel(cible, args) => {
                let f = self.eval(cible, portees)?;
                let mut vals = Vec::new();
                for a in args {
                    vals.push(self.eval(a, portees)?);
                }
                self.applique(&f, vals)?
            }
            Expr::Effet(ns, op, args) => {
                let mut vals = Vec::new();
                for a in args {
                    vals.push(self.eval(a, portees)?);
                }
                self.effet(ns, op, &vals)?
            }
        })
    }

    fn binaire(&mut self, op: &str, g: &Expr, d: &Expr, portees: &mut Portees) -> X<Val> {
        if op == "and" {
            let a = self.eval(g, portees)?;
            if !vrai(&a) {
                return Ok(Val::Bool(false));
            }
            let b = self.eval(d, portees)?;
            return Ok(Val::Bool(vrai(&b)));
        }
        if op == "or" {
            let a = self.eval(g, portees)?;
            if vrai(&a) {
                return Ok(Val::Bool(true));
            }
            let b = self.eval(d, portees)?;
            return Ok(Val::Bool(vrai(&b)));
        }
        let a = self.eval(g, portees)?;
        let b = self.eval(d, portees)?;
        Ok(match op {
            "+" => match (&a, &b) {
                (Val::Liste(x), Val::Liste(y)) => {
                    let mut out = x.clone();
                    out.extend(y.clone());
                    Val::Liste(out)
                }
                (Val::Texte(_), _) | (_, Val::Texte(_)) => {
                    Val::Texte(format!("{}{}", texte_de(&a), texte_de(&b)))
                }
                _ => Val::Num(fini(nombre(&a) + nombre(&b), op)?),
            },
            "-" => Val::Num(fini(nombre(&a) - nombre(&b), op)?),
            "*" => Val::Num(fini(nombre(&a) * nombre(&b), op)?),
            "/" => Val::Num(fini(nombre(&a) / nombre(&b), op)?),
            "==" => Val::Bool(egal(&a, &b)),
            "!=" => Val::Bool(!egal(&a, &b)),
            "<" | ">" | "<=" | ">=" => {
                // Ordonner deux valeurs de natures différentes n'a pas de sens.
                let ordre = match (&a, &b) {
                    (Val::Texte(x), Val::Texte(y)) => x.cmp(y),
                    (Val::Num(x), Val::Num(y)) => {
                        x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal)
                    }
                    _ => {
                        return Err(SErr::new(
                            "TYPE_ERROR",
                            format!("« {op} » compare deux nombres ou deux textes"),
                        )
                        .into())
                    }
                };
                Val::Bool(match op {
                    "<" => ordre.is_lt(),
                    ">" => ordre.is_gt(),
                    "<=" => ordre.is_le(),
                    _ => ordre.is_ge(),
                })
            }
            _ => return Err(SErr::new("INTERNAL", format!("opérateur inconnu : {op}")).into()),
        })
    }

    fn applique(&mut self, f: &Val, args: Vec<Val>) -> X<Val> {
        match f {
            Val::Integree(nom) => Ok(integree(nom, &args)?),
            _ => Err(SErr::new("NOT_CALLABLE", "ceci n'est pas appelable").into()),
        }
    }

    fn effet(&mut self, ns: &str, op: &str, args: &[Val]) -> X<Val> {
        let cible = args.first().map(texte_de).unwrap_or_default();
        self.autorise(ns, op, &cible)?;
        self.etape()?;
        if ns == "file" {
            let chemin = self.dossier.join(&cible);
            if op == "read" {
                return match fs::read_to_string(&chemin) {
                    Ok(t) => Ok(Val::Texte(t)),
                    Err(e) => Err(SErr::new("EFFECT_FAILED", e.to_string()).into()),
                };
            }
            if op == "write" || op == "append" {
                if let Some(parent) = chemin.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let contenu = args.get(1).map(texte_de).unwrap_or_default();
                let r = if op == "write" {
                    fs::write(&chemin, contenu)
                } else {
                    use std::io::Write;
                    fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&chemin)
                        .and_then(|mut f| f.write_all(contenu.as_bytes()))
                };
                return match r {
                    Ok(_) => Ok(Val::Texte(cible)),
                    Err(e) => Err(SErr::new("EFFECT_FAILED", e.to_string()).into()),
                };
            }
        }
        Err(SErr::new("EFFECT_FAILED", format!("effet non géré : !{ns}.{op}")).into())
    }
}

// -------------------------------------------------------------- intégrées

const INTEGREES: &[&str] = &[
    "len", "slice", "join", "split", "upper", "lower", "trim", "sum", "sort", "unique", "keys",
    "to_json", "parse_json", "now", "int", "text",
];

fn integree(nom: &str, args: &[Val]) -> R<Val> {
    let a0 = args.first().cloned().unwrap_or(Val::Null);
    Ok(match nom {
        "len" => Val::Num(match &a0 {
            // Une chaîne se mesure en points de code (spec, section 10).
            Val::Texte(t) => t.chars().count() as f64,
            Val::Liste(l) => l.len() as f64,
            Val::Fiche(f) => f.len() as f64,
            _ => 0.0,
        }),
        "slice" => {
            let d = nombre(args.get(1).unwrap_or(&Val::Num(0.0))) as usize;
            let f = nombre(args.get(2).unwrap_or(&Val::Num(0.0))) as usize;
            match &a0 {
                Val::Texte(t) => {
                    let cs: Vec<char> = t.chars().collect();
                    let f = f.min(cs.len());
                    let d = d.min(f);
                    Val::Texte(cs[d..f].iter().collect())
                }
                Val::Liste(l) => {
                    let f = f.min(l.len());
                    let d = d.min(f);
                    Val::Liste(l[d..f].to_vec())
                }
                _ => Val::Null,
            }
        }
        "join" => {
            let sep = args.get(1).map(texte_de).unwrap_or_default();
            match &a0 {
                Val::Liste(l) => Val::Texte(l.iter().map(texte_de).collect::<Vec<_>>().join(&sep)),
                _ => Val::Texte(String::new()),
            }
        }
        "split" => {
            let sep = args.get(1).map(texte_de).unwrap_or_default();
            Val::Liste(texte_de(&a0).split(&sep as &str).map(|s| Val::Texte(s.to_string())).collect())
        }
        "upper" => Val::Texte(texte_de(&a0).to_uppercase()),
        "lower" => Val::Texte(texte_de(&a0).to_lowercase()),
        "trim" => Val::Texte(texte_de(&a0).trim().to_string()),
        "sum" => Val::Num(match &a0 {
            Val::Liste(l) => l.iter().map(nombre).sum(),
            _ => 0.0,
        }),
        "sort" => match &a0 {
            Val::Liste(l) => {
                let mut out = l.clone();
                out.sort_by(|a, b| match (a, b) {
                    (Val::Texte(x), Val::Texte(y)) => x.cmp(y),
                    _ => nombre(a).partial_cmp(&nombre(b)).unwrap_or(std::cmp::Ordering::Equal),
                });
                Val::Liste(out)
            }
            _ => a0.clone(),
        },
        "unique" => match &a0 {
            Val::Liste(l) => {
                let mut vus: HashSet<String> = HashSet::new();
                let mut out = Vec::new();
                for x in l {
                    let cle = json_compact(x);
                    if vus.insert(cle) {
                        out.push(x.clone());
                    }
                }
                Val::Liste(out)
            }
            _ => a0.clone(),
        },
        "keys" => match &a0 {
            Val::Fiche(f) => Val::Liste(f.iter().map(|(k, _)| Val::Texte(k.clone())).collect()),
            _ => Val::Liste(Vec::new()),
        },
        "to_json" => Val::Texte(json_indente(&a0, 0)),
        "parse_json" => return Err(SErr::new("INTERNAL", "parse_json non géré au niveau 1")),
        "now" => Val::Texte("1970-01-01T00:00:00.000Z".into()),
        "int" => Val::Num(nombre(&a0).trunc()),
        "text" => Val::Texte(texte_de(&a0)),
        _ => return Err(SErr::new("INTERNAL", format!("intégrée inconnue : {nom}"))),
    })
}

// ----------------------------------------------------------------- contrat

fn lister_fichiers(racine: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    parcourir(racine, racine, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn parcourir(racine: &Path, dossier: &Path, out: &mut Vec<(String, String)>) {
    let entrees = match fs::read_dir(dossier) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut noms: Vec<PathBuf> = entrees.filter_map(|e| e.ok().map(|e| e.path())).collect();
    noms.sort();
    for chemin in noms {
        let nom = chemin.file_name().unwrap_or_default().to_string_lossy().to_string();
        if nom == ".super" || nom == "fixtures.json" {
            continue;
        }
        if chemin.is_dir() {
            parcourir(racine, &chemin, out);
            continue;
        }
        if nom.ends_with(".sup") || nom.ends_with(".expected.json") {
            continue;
        }
        if let Ok(contenu) = fs::read_to_string(&chemin) {
            let relatif = chemin.strip_prefix(racine).unwrap_or(&chemin).to_string_lossy().to_string();
            out.push((relatif, contenu));
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 || args[1] != "conform" {
        eprintln!("usage : super-rs conform <fichier.sup> --dir <dossier>");
        std::process::exit(2);
    }
    let fichier = PathBuf::from(&args[2]);
    let dossier = match args.iter().position(|a| a == "--dir") {
        Some(i) if i + 1 < args.len() => PathBuf::from(&args[i + 1]),
        _ => fichier.parent().unwrap_or(Path::new(".")).to_path_buf(),
    };

    let mut logs: Vec<String> = Vec::new();
    let mut erreur: Option<&'static str> = None;

    match fs::read_to_string(&fichier) {
        Err(_) => erreur = Some("INTERNAL"),
        Ok(src) => {
            let resultat = lexer(&src).and_then(|toks| Analyseur::new(toks).programme());
            match resultat {
                Err(e) => erreur = Some(e.code),
                Ok(mission) => {
                    let mut interp = Interprete {
                        mission,
                        dossier: dossier.clone(),
                        logs: Vec::new(),
                        etapes: 0.0,
                        debut: Instant::now(),
                    };
                    let corps = interp.mission.corps.clone();
                    let mut portees: Portees = vec![Vec::new()];
                    match interp.bloc(&corps, &mut portees) {
                        Ok(()) | Err(Arret::Fini) => {}
                        Err(Arret::Erreur(e)) => erreur = Some(e.code),
                    }
                    logs = interp.logs.clone();
                }
            }
        }
    }

    let fichiers = lister_fichiers(&dossier);
    let mut sortie = String::from("{\n  \"logs\": [");
    sortie.push_str(
        &logs.iter().map(|l| format!("\n    {}", echapper_json(l))).collect::<Vec<_>>().join(","),
    );
    if !logs.is_empty() {
        sortie.push_str("\n  ");
    }
    sortie.push_str("],\n  \"error\": ");
    match erreur {
        None => sortie.push_str("null"),
        Some(c) => sortie.push_str(&format!("{{\n    \"code\": {}\n  }}", echapper_json(c))),
    }
    sortie.push_str(",\n  \"files\": {");
    sortie.push_str(
        &fichiers
            .iter()
            .map(|(k, v)| format!("\n    {}: {}", echapper_json(k), echapper_json(v)))
            .collect::<Vec<_>>()
            .join(","),
    );
    if !fichiers.is_empty() {
        sortie.push_str("\n  ");
    }
    sortie.push_str("}\n}");
    println!("{sortie}");
}
