// Super Code — interpréteur. Évalue une mission ; toute sortie sur le monde passe
// par runtime.ts.

import {
  Budget, Capabilities, Journal, NeedsApproval, SkillRegistry, SuperError,
  describeType, runAsk, runEffect, sha, typeError,
  type EffectContext, type ModelProvider, type SkillDef,
} from './runtime.ts';
import type { Node, Program } from './parser.ts';

class DoneSignal extends Error {}

type Scope = Map<string, any>;

export type RunOptions = {
  cwd: string;
  dir: string;
  runId: string;
  provider: ModelProvider;
  autoApprove: boolean;
  /** Sortie du programme : uniquement les instructions « log ». */
  log: (msg: string) => void;
  /** Sortie de diagnostic : reprises, synthèses, avertissements. Jamais mêlée
   *  à la précédente, sinon deux implémentations ne pourraient pas être
   *  comparées. */
  diag: (msg: string) => void;
};

export type RunResult = {
  status: 'ok' | 'awaiting-approval';
  budget: Budget;
  pending?: { key: string; description: string };
};

export async function runMission(program: Program, missionName: string | null, opts: RunOptions): Promise<RunResult> {
  const mission = missionName
    ? program.missions.find((m: Node) => m.name === missionName)
    : program.missions[0];
  if (!mission) throw new SuperError(missionName ? `mission « ${missionName} » introuvable` : 'aucune mission dans ce fichier', 'SYNTAX_ERROR');

  const caps = new Capabilities(mission.uses);
  const budget = new Budget(mission.budget);
  const journal = new Journal(opts.dir, opts.runId);
  const ctx: EffectContext = {
    caps, budget, journal, cwd: opts.cwd,
    dir: opts.dir,
    providerName: opts.provider.name,
  };
  const skills = new SkillRegistry(opts.dir, opts.provider, ctx, opts.diag);

  const skillDefs = new Map<string, SkillDef>(program.skills.map((s: Node) => [s.name, s as SkillDef]));

  const interp = new Interp(ctx, opts, skills, skillDefs);

  for (const w of journal.warnings) opts.diag(`⚠ ${w}`);
  if (journal.replayedCount > 0) {
    opts.diag(`reprise du run ${opts.runId} : ${journal.replayedCount} étape(s) déjà faites, non refaites.`);
  }

  try {
    await interp.execBlock(mission.body, [new Map()]);
  } catch (e) {
    if (e instanceof DoneSignal) { /* mission terminée volontairement */ }
    else if (e instanceof NeedsApproval) {
      return { status: 'awaiting-approval', budget, pending: { key: interp.pendingKey!, description: e.description } };
    } else throw e;
  } finally {
    // Le processus du bac à sable ne survit pas à la mission.
    skills.close();
  }
  return { status: 'ok', budget };
}

class Interp {
  pendingKey: string | null = null;
  private requireApproval = false;

  private ctx: EffectContext;
  private opts: RunOptions;
  private skills: SkillRegistry;
  private skillDefs: Map<string, SkillDef>;

  constructor(ctx: EffectContext, opts: RunOptions, skills: SkillRegistry, skillDefs: Map<string, SkillDef>) {
    this.ctx = ctx;
    this.opts = opts;
    this.skills = skills;
    this.skillDefs = skillDefs;
  }

  // ------------------------------------------------------------ instructions

  async execBlock(stmts: Node[], scopes: Scope[]): Promise<void> {
    for (const s of stmts) await this.exec(s, scopes);
  }

  private async exec(s: Node, scopes: Scope[]): Promise<void> {
    switch (s.kind) {
      case 'let': {
        const v = await this.eval(s.value, scopes);
        scopes[scopes.length - 1].set(s.name, v);
        return;
      }
      case 'if': {
        if (truthy(await this.eval(s.cond, scopes))) await this.execBlock(s.then, [...scopes, new Map()]);
        else if (s.otherwise) await this.execBlock(s.otherwise, [...scopes, new Map()]);
        return;
      }
      case 'for': {
        const list = await this.eval(s.list, scopes);
        if (!Array.isArray(list)) throw new SuperError(`« for » attend une liste, ligne ${s.line}`, 'NOT_A_LIST');
        for (const item of list) {
          const inner = new Map([[s.name, item]]);
          await this.execBlock(s.body, [...scopes, inner]);
        }
        return;
      }
      case 'repeat': {
        // Le corps travaille dans le champ de variables de la mission, sans en
        // créer un nouveau : c'est ce qui permet à un accumulateur de survivre
        // d'un tour à l'autre, puis à la boucle elle-même. Un « let » réexécuté
        // remplace la valeur précédente.
        //
        // Chaque tour consomme une étape du budget, donc une boucle dont
        // l'objectif n'est jamais atteint s'arrête sur le budget, avec un
        // message clair, au lieu de tourner indéfiniment.
        for (;;) {
          this.ctx.budget.step('repeat');
          await this.execBlock(s.body, scopes);
          if (truthy(await this.eval(s.until, scopes))) return;
        }
      }
      case 'confirm': {
        this.requireApproval = true;
        try { await this.eval(s.value, scopes); }
        finally { this.requireApproval = false; }
        return;
      }
      case 'log': {
        this.opts.log(String(await this.eval(s.value, scopes)));
        return;
      }
      case 'done': throw new DoneSignal();
      case 'fail': throw new SuperError(String(await this.eval(s.value, scopes)), 'MISSION_FAILED');
      case 'expr': { await this.eval(s.value, scopes); return; }
      default: throw new SuperError(`instruction inconnue : ${s.kind}`, 'INTERNAL');
    }
  }

  // ------------------------------------------------------------- expressions

  async eval(n: Node, scopes: Scope[]): Promise<any> {
    switch (n.kind) {
      case 'num': return n.value;
      case 'bool': return n.value;
      case 'null': return null;

      case 'str': {
        let out = '';
        for (const p of n.parts) out += 'text' in p ? p.text : stringify(await this.eval(p.expr, scopes));
        return out;
      }

      case 'ident': {
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(n.name)) return scopes[i].get(n.name);
        if (this.skillDefs.has(n.name)) return { __skill: n.name };
        if (n.name in BUILTINS) return { __builtin: n.name };
        throw new SuperError(`« ${n.name} » n'est pas défini (ligne ${n.line})`, 'UNDEFINED_NAME');
      }

      case 'it': {
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has('it')) return scopes[i].get('it');
        throw new SuperError('« it » n\'a de sens que dans un where ou un map', 'UNDEFINED_NAME');
      }

      case 'list': {
        const out = [];
        for (const item of n.items) out.push(await this.eval(item, scopes));
        return out;
      }

      case 'record': {
        const out: Record<string, any> = {};
        for (const f of n.fields) out[f.name] = await this.eval(f.value, scopes);
        return out;
      }

      case 'field': {
        const target = await this.eval(n.target, scopes);
        if (target === null || target === undefined) return null;
        if (typeof target === 'object' && n.name in target) return (target as any)[n.name];
        if (Array.isArray(target) && n.name === 'len') return target.length;
        return null;
      }

      case 'index': {
        const target = await this.eval(n.target, scopes);
        const idx = await this.eval(n.index, scopes);
        if (target === null || target === undefined) return null;
        return (target as any)[idx] ?? null;
      }

      case 'un': {
        const v = await this.eval(n.value, scopes);
        return n.op === 'not' ? !truthy(v) : -Number(v);
      }

      case 'bin': return this.evalBin(n, scopes);

      case 'where': {
        const list = await this.expectList(n.list, scopes, 'where');
        const out = [];
        for (const item of list) {
          if (truthy(await this.eval(n.body, [...scopes, new Map([['it', item]])]))) out.push(item);
        }
        return out;
      }

      case 'map': {
        const list = await this.expectList(n.list, scopes, 'map');
        const out = [];
        for (const item of list) out.push(await this.eval(n.body, [...scopes, new Map([['it', item]])]));
        return out;
      }

      case 'pipe': {
        const value = await this.eval(n.left, scopes);
        const fn = await this.eval(n.right, scopes);
        return this.apply(fn, [value], n.line);
      }

      case 'call': {
        const fn = await this.eval(n.target, scopes);
        const args = [];
        for (const a of n.args) args.push(await this.eval(a, scopes));
        return this.apply(fn, args, n.target.line);
      }

      case 'effect': {
        const args = [];
        for (const a of n.args) args.push(await this.eval(a, scopes));
        if (this.requireApproval) await this.gate(n, args);
        return runEffect(this.ctx, n.ns, n.op, args, n.retries, n.timeoutMs);
      }

      case 'ask': {
        const prompt = await this.eval(n.prompt, scopes);
        const args = [];
        for (const a of n.args) args.push(await this.eval(a, scopes));
        return runAsk(this.ctx, this.opts.provider, prompt, args, n.type);
      }

      default: throw new SuperError(`expression inconnue : ${n.kind}`, 'INTERNAL');
    }
  }

  private async expectList(node: Node, scopes: Scope[], op: string): Promise<any[]> {
    const list = await this.eval(node, scopes);
    if (!Array.isArray(list)) throw new SuperError(`« ${op} » attend une liste, reçu ${typeName(list)}`, 'NOT_A_LIST');
    return list;
  }

  private async evalBin(n: Node, scopes: Scope[]): Promise<any> {
    if (n.op === 'and') {
      const l = await this.eval(n.left, scopes);
      return truthy(l) ? truthy(await this.eval(n.right, scopes)) : false;
    }
    if (n.op === 'or') {
      const l = await this.eval(n.left, scopes);
      return truthy(l) ? true : truthy(await this.eval(n.right, scopes));
    }
    const a = await this.eval(n.left, scopes);
    const b = await this.eval(n.right, scopes);

    // Ordonner deux valeurs de natures différentes n'a pas de sens. JavaScript
    // répondrait « false » à « 1 < "a" », ce qui est une réponse inventée : on
    // refuse plutôt que d'en choisir une au hasard.
    if (['<', '>', '<=', '>='].includes(n.op)) {
      const memeNature =
        (typeof a === 'number' && typeof b === 'number') ||
        (typeof a === 'string' && typeof b === 'string');
      if (!memeNature) {
        throw new SuperError(
          `« ${n.op} » compare deux nombres ou deux textes, pas ${typeName(a)} et ${typeName(b)}`,
          'TYPE_ERROR',
        );
      }
    }

    switch (n.op) {
      case '+':
        // « + » assemble : deux listes, deux textes, ou deux nombres.
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
        if (typeof a === 'string' || typeof b === 'string') return stringify(a) + stringify(b);
        return fini(Number(a) + Number(b), n.op);
      case '-': return fini(Number(a) - Number(b), n.op);
      case '*': return fini(Number(a) * Number(b), n.op);
      case '/': return fini(Number(a) / Number(b), n.op);
      case '==': return egal(a, b);
      case '!=': return !egal(a, b);
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: throw new SuperError(`opérateur inconnu : ${n.op}`, 'INTERNAL');
    }
  }

  private async apply(fn: any, args: any[], line: number): Promise<any> {
    if (fn && typeof fn === 'object' && '__skill' in fn) {
      const def = this.skillDefs.get(fn.__skill)!;
      return this.skills.call(def, args);
    }
    if (fn && typeof fn === 'object' && '__builtin' in fn) {
      const name = fn.__builtin;
      // `now()` lit l'horloge : c'est une observation du monde extérieur, donc
      // elle est journalisée comme un effet. Sans cela une reprise produirait
      // un résultat différent de la première exécution, et le langage ne
      // pourrait pas promettre qu'un run rejoué est identique.
      if (name === 'now') return this.ctx.journal.perform('now', 'now', async () => new Date().toISOString());
      return BUILTINS[name](...args);
    }
    throw new SuperError(`ceci n'est pas appelable (ligne ${line})`, 'NOT_CALLABLE');
  }

  /** Point d'arrêt humain : l'effet ne part pas tant qu'il n'est pas approuvé. */
  private async gate(n: Node, args: any[]): Promise<void> {
    const key = sha({ ns: n.ns, op: n.op, args });
    if (this.opts.autoApprove || this.ctx.journal.isApproved(key)) return;
    this.pendingKey = key;
    const preview = args.map((a) => truncate(stringify(a), 200)).join(', ');
    throw new NeedsApproval(this.opts.runId, `!${n.ns}.${n.op}(${preview})`);
  }
}

// ------------------------------------------------------------------ outils

function truthy(v: any): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Il n'existe pas de valeur infinie ni de « pas un nombre » dans Super Code.
 *
 * Une mission qui écrit « Infinity » dans un rapport est pire qu'une mission qui
 * s'arrête : l'erreur se propage sans bruit jusqu'au destinataire. Tout calcul
 * qui ne donne pas un nombre fini interrompt la mission.
 */
function fini(v: number, op: string): number {
  if (!Number.isFinite(v)) {
    throw new SuperError(
      `« ${op} » ne donne pas un nombre fini (division par zéro, ou dépassement)`,
      'ARITHMETIC_ERROR',
    );
  }
  return v;
}

/**
 * Égalité structurelle.
 *
 * Une fiche garde l'ordre de ses champs pour « keys » et « to_json », parce
 * qu'une sortie prévisible vaut mieux qu'une sortie commode. Mais cet ordre ne
 * doit rien changer à l'égalité : {a: 1, b: 2} et {b: 2, a: 1} portent la même
 * information. Comparer du texte sérialisé confondait les deux notions.
 */
function egal(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => egal(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && egal(a[k], b[k]));
  }
  return false;
}

function typeName(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'liste';
  return typeof v === 'object' ? 'fiche' : typeof v;
}

function stringify(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `… (+${s.length - n} car.)`;
}

// Un texte est une suite de points de code Unicode, jamais d'unités UTF-16 ni
// d'octets. Sans cette règle, « len("👍") » vaudrait 2 en JavaScript, 1 en
// Python et 4 en Rust, et trois implémentations correctes se contrediraient.
const points = (s: string) => Array.from(s);

const BUILTINS: Record<string, (...a: any[]) => any> = {
  len: (x) => (x === null || x === undefined ? 0
    : typeof x === 'string' ? points(x).length
    : Array.isArray(x) ? x.length
    : Object.keys(x).length),
  slice: (l, a, b) => (typeof l === 'string' ? points(l).slice(a, b).join('') : (l ?? []).slice(a, b)),
  join: (l, sep) => (l ?? []).map(stringify).join(sep ?? ''),
  split: (t, sep) => String(t).split(sep),
  upper: (t) => String(t).toUpperCase(),
  lower: (t) => String(t).toLowerCase(),
  trim: (t) => String(t).trim(),
  sum: (l) => (l ?? []).reduce((a: number, b: any) => a + Number(b), 0),
  sort: (l) => [...(l ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  unique: (l) => [...new Set((l ?? []).map((x: any) => JSON.stringify(x)))].map((s) => JSON.parse(s as string)),
  keys: (f) => Object.keys(f ?? {}),
  to_json: (x) => JSON.stringify(x, null, 2),
  parse_json: (t) => JSON.parse(String(t)),
  now: () => new Date().toISOString(),
  int: (x) => Math.trunc(Number(x)),
  text: (x) => stringify(x),
};

export { describeType, typeError };
