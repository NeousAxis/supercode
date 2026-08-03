// Super Code — analyse syntaxique. Descente récursive, une fonction par niveau de
// précédence, dans l'ordre exact de spec/GRAMMAR.md.

import { lex, SuperSyntaxError, type Tok, type StrPart } from './lexer.ts';

export type Node = any;

export type Program = {
  missions: Node[];
  skills: Node[];
};

class Parser {
  private p = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }

  private cur(): Tok { return this.toks[this.p]; }
  private at(t: string, v?: string): boolean {
    const c = this.cur();
    return c.t === t && (v === undefined || c.v === v);
  }
  private atKw(v: string): boolean { return this.at('kw', v); }

  private next(): Tok { return this.toks[this.p++]; }

  private eat(t: string, v?: string): Tok {
    if (!this.at(t, v)) {
      const c = this.cur();
      const got = c.v !== undefined ? `« ${c.v} »` : `« ${c.t} »`;
      throw new SuperSyntaxError(`attendu « ${v ?? t} », trouvé ${got}`, c.line, c.col);
    }
    return this.next();
  }

  private tryEat(t: string, v?: string): boolean {
    if (this.at(t, v)) { this.next(); return true; }
    return false;
  }

  // ---------- programme ----------

  parseProgram(): Program {
    const out: Program = { missions: [], skills: [] };
    while (!this.at('eof')) {
      if (this.atKw('mission')) out.missions.push(this.parseMission());
      else if (this.atKw('skill')) out.skills.push(this.parseSkill());
      else {
        const c = this.cur();
        throw new SuperSyntaxError(`attendu « mission » ou « skill » au premier niveau`, c.line, c.col);
      }
    }
    return out;
  }

  private parseMission(): Node {
    const start = this.eat('kw', 'mission');
    const name = this.eat('ident').v;
    this.eat('{');
    const uses: Node[] = [];
    const budget: Node = { usd: null, steps: null, ms: null };
    let every: number | null = null;

    while (this.at('kw') && ['uses', 'budget', 'every'].includes(this.cur().v)) {
      const kw = this.next().v;
      if (kw === 'uses') {
        do { uses.push(this.parseCapability()); } while (this.tryEat(','));
      } else if (kw === 'budget') {
        do {
          const t = this.next();
          if (t.t === 'money') budget.usd = t.v;
          else if (t.t === 'dur') budget.ms = t.v;
          else if (t.t === 'num') { this.eat('kw', 'steps'); budget.steps = t.v; }
          else throw new SuperSyntaxError('limite de budget invalide', t.line, t.col);
        } while (this.tryEat(','));
      } else {
        every = this.eat('dur').v;
      }
    }

    const body = this.parseBlockBody();
    this.eat('}');

    // Une boucle « repeat » n'a de sens que si quelque chose la borne. Le
    // budget en étapes ou en temps est ce quelque chose, et chaque tour en
    // consomme une : la boucle est donc bornée par construction, et pas par la
    // discipline de celui qui l'écrit. Un budget en argent seul ne suffit pas,
    // car une boucle purement locale ne dépense rien.
    if (containsKind(body, 'repeat') && budget.steps === null && budget.ms === null) {
      throw new SuperSyntaxError(
        `la mission « ${name} » contient un « repeat » : elle doit déclarer un budget en étapes ou en durée (par exemple : budget 50 steps)`,
        start.line, start.col,
      );
    }

    return { kind: 'mission', name, uses, budget, every, body, line: start.line };
  }

  private parseCapability(): Node {
    const ns = this.eat('ident').v;
    this.eat('.');
    const op = this.eat('ident').v;
    this.eat('(');
    const patTok = this.eat('str');
    const pattern = staticString(patTok);
    this.eat(')');
    return { ns, op, pattern, line: patTok.line };
  }

  private parseSkill(): Node {
    const start = this.eat('kw', 'skill');
    const name = this.eat('ident').v;
    this.eat('(');
    const params: Node[] = [];
    if (!this.at(')')) {
      do {
        const pname = this.eat('ident').v;
        this.eat(':');
        params.push({ name: pname, type: this.parseType() });
      } while (this.tryEat(','));
    }
    this.eat(')');
    this.eat('->');
    const ret = this.parseType();
    this.eat('{');
    const desc = staticString(this.eat('str'));
    this.eat('}');
    return { kind: 'skill', name, params, ret, desc, line: start.line };
  }

  private parseType(): Node {
    if (this.at('{')) {
      this.next();
      const fields: Node[] = [];
      if (!this.at('}')) {
        do {
          const fname = this.eat('ident').v;
          this.eat(':');
          fields.push({ name: fname, type: this.parseType() });
        } while (this.tryEat(','));
      }
      this.eat('}');
      return { t: 'record', fields };
    }
    const id = this.eat('ident').v;
    if (id === 'list') {
      this.eat('<');
      const of = this.parseType();
      this.eat('>');
      return { t: 'list', of };
    }
    if (!['text', 'number', 'bool', 'any'].includes(id)) {
      const c = this.toks[this.p - 1];
      throw new SuperSyntaxError(`type inconnu « ${id} »`, c.line, c.col);
    }
    return { t: id };
  }

  // ---------- instructions ----------

  private parseBlockBody(): Node[] {
    const out: Node[] = [];
    while (!this.at('}') && !this.at('eof')) out.push(this.parseStmt());
    return out;
  }

  private parseBlock(): Node[] {
    this.eat('{');
    const body = this.parseBlockBody();
    this.eat('}');
    return body;
  }

  private parseStmt(): Node {
    const c = this.cur();
    if (this.atKw('let')) {
      this.next();
      const name = this.eat('ident').v;
      this.eat('=');
      return { kind: 'let', name, value: this.parseExpr(), line: c.line };
    }
    if (this.atKw('if')) {
      this.next();
      const cond = this.parseExpr();
      const then = this.parseBlock();
      let otherwise: Node[] | null = null;
      if (this.tryEat('kw', 'else')) otherwise = this.parseBlock();
      return { kind: 'if', cond, then, otherwise, line: c.line };
    }
    if (this.atKw('for')) {
      this.next();
      const name = this.eat('ident').v;
      this.eat('kw', 'in');
      const list = this.parseExpr();
      return { kind: 'for', name, list, body: this.parseBlock(), line: c.line };
    }
    if (this.atKw('repeat')) {
      this.next();
      const body = this.parseBlock();
      this.eat('kw', 'until');
      return { kind: 'repeat', body, until: this.parseExpr(), line: c.line };
    }
    if (this.atKw('confirm')) {
      this.next();
      const value = this.parseExpr();
      // « confirm » sans effet à garder ne protège rien : ce serait une fausse
      // assurance, donc c'est une erreur de syntaxe et pas un avertissement.
      if (!containsEffect(value)) {
        throw new SuperSyntaxError(
          '« confirm » doit porter sur un effet (une expression contenant un « ! »)',
          c.line, c.col,
        );
      }
      return { kind: 'confirm', value, line: c.line };
    }
    if (this.atKw('log')) {
      this.next();
      return { kind: 'log', value: this.parseExpr(), line: c.line };
    }
    if (this.atKw('done')) { this.next(); return { kind: 'done', line: c.line }; }
    if (this.atKw('fail')) {
      this.next();
      return { kind: 'fail', value: this.parseExpr(), line: c.line };
    }
    return { kind: 'expr', value: this.parseExpr(), line: c.line };
  }

  // ---------- expressions ----------

  parseExpr(): Node { return this.parsePipe(); }

  private parsePipe(): Node {
    let left = this.parseFilter();
    while (this.at('|>')) {
      const line = this.next().line;
      const right = this.parseFilter();
      left = { kind: 'pipe', left, right, line };
    }
    return left;
  }

  private parseFilter(): Node {
    let left = this.parseOr();
    while (this.atKw('where') || this.atKw('map')) {
      const op = this.next().v;
      const body = this.parseOr();
      left = { kind: op, list: left, body };
    }
    return left;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.atKw('or')) { this.next(); left = { kind: 'bin', op: 'or', left, right: this.parseAnd() }; }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseCmp();
    while (this.atKw('and')) { this.next(); left = { kind: 'bin', op: 'and', left, right: this.parseCmp() }; }
    return left;
  }

  private parseCmp(): Node {
    let left = this.parseSum();
    while (['==', '!=', '<', '>', '<=', '>='].includes(this.cur().t)) {
      const op = this.next().t;
      left = { kind: 'bin', op, left, right: this.parseSum() };
    }
    return left;
  }

  private parseSum(): Node {
    let left = this.parseProduct();
    while (this.at('+') || this.at('-')) {
      const op = this.next().t;
      left = { kind: 'bin', op, left, right: this.parseProduct() };
    }
    return left;
  }

  private parseProduct(): Node {
    let left = this.parseUnary();
    while (this.at('*') || this.at('/')) {
      const op = this.next().t;
      left = { kind: 'bin', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.atKw('not')) { this.next(); return { kind: 'un', op: 'not', value: this.parseUnary() }; }
    if (this.at('-')) { this.next(); return { kind: 'un', op: '-', value: this.parseUnary() }; }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.at('.')) {
        this.next();
        node = { kind: 'field', target: node, name: this.eat('ident').v };
      } else if (this.at('[')) {
        this.next();
        const index = this.parseExpr();
        this.eat(']');
        node = { kind: 'index', target: node, index };
      } else if (this.at('(')) {
        node = { kind: 'call', target: node, args: this.parseArgs() };
      } else {
        return node;
      }
    }
  }

  private parseArgs(): Node[] {
    this.eat('(');
    const args: Node[] = [];
    if (!this.at(')')) {
      do { args.push(this.parseExpr()); } while (this.tryEat(','));
    }
    this.eat(')');
    return args;
  }

  private parsePrimary(): Node {
    const c = this.cur();

    if (c.t === 'num') { this.next(); return { kind: 'num', value: c.v }; }
    if (c.t === 'dur') { this.next(); return { kind: 'num', value: c.v }; }
    if (c.t === 'money') { this.next(); return { kind: 'num', value: c.v }; }
    if (c.t === 'str') { this.next(); return strNode(c); }

    if (c.t === 'kw') {
      if (c.v === 'true') { this.next(); return { kind: 'bool', value: true }; }
      if (c.v === 'false') { this.next(); return { kind: 'bool', value: false }; }
      if (c.v === 'null') { this.next(); return { kind: 'null' }; }
      if (c.v === 'it') { this.next(); return { kind: 'it' }; }
    }

    if (c.t === 'ident') { this.next(); return { kind: 'ident', name: c.v, line: c.line }; }

    // « .titre » : raccourci pour « it.titre » dans un where/map
    if (c.t === '.') return { kind: 'it' };

    if (c.t === '(') {
      this.next();
      const e = this.parseExpr();
      this.eat(')');
      return e;
    }

    if (c.t === '[') {
      this.next();
      const items: Node[] = [];
      if (!this.at(']')) { do { items.push(this.parseExpr()); } while (this.tryEat(',')); }
      this.eat(']');
      return { kind: 'list', items };
    }

    if (c.t === '{') {
      this.next();
      const fields: Node[] = [];
      if (!this.at('}')) {
        do {
          const name = this.eat('ident').v;
          this.eat(':');
          fields.push({ name, value: this.parseExpr() });
        } while (this.tryEat(','));
      }
      this.eat('}');
      return { kind: 'record', fields };
    }

    if (c.t === '!') {
      this.next();
      const ns = this.eat('ident').v;
      this.eat('.');
      const op = this.eat('ident').v;
      const args = this.parseArgs();
      let retries = 0, timeoutMs: number | null = null;
      for (;;) {
        if (this.atKw('retry')) { this.next(); retries = this.eat('num').v; continue; }
        if (this.atKw('timeout')) { this.next(); timeoutMs = this.eat('dur').v; continue; }
        break;
      }
      return { kind: 'effect', ns, op, args, retries, timeoutMs, line: c.line };
    }

    if (c.t === '~') {
      this.next();
      const prompt = strNode(this.eat('str'));
      const args = this.at('(') ? this.parseArgs() : [];
      let type: Node = { t: 'text' };
      if (this.tryEat('kw', 'as')) type = this.parseType();
      return { kind: 'ask', prompt, args, type, line: c.line };
    }

    throw new SuperSyntaxError(
      `expression attendue, trouvé « ${c.v ?? c.t} »`, c.line, c.col,
    );
  }
}

/** Parcourt un arbre à la recherche d'un nœud d'un certain genre. */
function containsKind(n: any, kind: string): boolean {
  if (n === null || typeof n !== 'object') return false;
  if (n.kind === kind) return true;
  for (const v of Object.values(n)) {
    if (Array.isArray(v) ? v.some((x) => containsKind(x, kind)) : containsKind(v, kind)) return true;
  }
  return false;
}

const containsEffect = (n: any) => containsKind(n, 'effect');

function staticString(tok: Tok): string {
  const parts = tok.parts!;
  if (parts.some((p) => 'code' in p)) {
    throw new SuperSyntaxError('interpolation interdite ici : ce texte doit être constant', tok.line, tok.col);
  }
  return parts.map((p) => (p as { text: string }).text).join('');
}

function strNode(tok: Tok): Node {
  const parts = (tok.parts as StrPart[]).map((p) => {
    if ('text' in p) return { text: p.text };
    return { expr: parseExpression(p.code) };
  });
  return { kind: 'str', parts, line: tok.line };
}

export function parseExpression(src: string): Node {
  const parser = new Parser(lex(src));
  return parser.parseExpr();
}

export function parse(src: string): Program {
  return new Parser(lex(src)).parseProgram();
}
