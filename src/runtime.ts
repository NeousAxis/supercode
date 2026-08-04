// Super Code — runtime : journal durable, capacités, budget, effets, modèle, skills.
// Tout ce qui touche le monde extérieur passe par ici, et rien d'autre.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { IsolatedSandbox } from './sandbox.ts';

export class SuperError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SuperError'; }
}

/** Levée quand la mission attend une approbation humaine. Ce n'est pas un échec. */
export class NeedsApproval extends Error {
  runId: string;
  description: string;
  constructor(runId: string, description: string) {
    super(description);
    this.name = 'NeedsApproval';
    this.runId = runId;
    this.description = description;
  }
}

export class BudgetExceeded extends SuperError {}
export class CapabilityDenied extends SuperError {}

export function sha(x: unknown): string {
  return createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- capacités

/** Motif de capacité : `*` couvre un segment, `**` couvre tout le reste. */
export function matchPattern(pattern: string, value: string): boolean {
  const rx = pattern
    .split('**').map((seg) => seg.split('*').map(escapeRx).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${rx}$`).test(value);
}

function escapeRx(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

export class Capabilities {
  private granted: { ns: string; op: string; pattern: string }[];
  constructor(granted: { ns: string; op: string; pattern: string }[]) { this.granted = granted; }

  check(ns: string, op: string, target: string): void {
    const relevant = this.granted.filter((g) => g.ns === ns && g.op === op);
    if (relevant.some((g) => matchPattern(g.pattern, target))) return;
    const decl = relevant.length
      ? `déclaré : ${relevant.map((g) => `${ns}.${op}("${g.pattern}")`).join(', ')}`
      : `aucune capacité ${ns}.${op} déclarée`;
    throw new CapabilityDenied(
      `capacité refusée : ${ns}.${op}("${target}") — ${decl}. Ajoute-la dans « uses » si c'est voulu.`,
    );
  }
}

// ------------------------------------------------------------------ budget

export class Budget {
  spentUsd = 0;
  steps = 0;
  readonly startedAt = Date.now();
  private limits: { usd: number | null; steps: number | null; ms: number | null };

  constructor(limits: { usd: number | null; steps: number | null; ms: number | null }) { this.limits = limits; }

  step(what: string): void {
    this.steps++;
    if (this.limits.steps !== null && this.steps > this.limits.steps) {
      throw new BudgetExceeded(`budget épuisé : ${this.limits.steps} étapes dépassées (à « ${what} »)`);
    }
    if (this.limits.ms !== null && Date.now() - this.startedAt > this.limits.ms) {
      throw new BudgetExceeded(`budget épuisé : durée maximale ${this.limits.ms}ms dépassée (à « ${what} »)`);
    }
  }

  charge(usd: number, what: string): void {
    this.spentUsd += usd;
    if (this.limits.usd !== null && this.spentUsd > this.limits.usd) {
      throw new BudgetExceeded(
        `budget épuisé : ${this.spentUsd.toFixed(4)} usd dépensés, limite ${this.limits.usd} usd (à « ${what} »)`,
      );
    }
  }

  summary(): string {
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    return `${this.steps} étapes, ${this.spentUsd.toFixed(4)} usd, ${secs}s`;
  }
}

// ----------------------------------------------------------------- journal

type JournalEntry = { seq: number; kind: string; key: string; value: any };

/**
 * Journal append-only. Chaque effet et chaque appel au modèle y laisse une
 * trace, ce qui rend une mission rejouable : au redémarrage, les étapes déjà
 * faites renvoient leur valeur enregistrée au lieu d'être refaites.
 */
export class Journal {
  private replay: JournalEntry[] = [];
  private seq = 0;
  private file: string;
  private approvalsFile: string;
  private approvals: Set<string>;
  readonly warnings: string[] = [];
  dir: string;
  runId: string;

  constructor(dir: string, runId: string) {
    this.dir = dir;
    this.runId = runId;
    mkdirSync(path.join(dir, 'runs'), { recursive: true });
    this.file = path.join(dir, 'runs', `${runId}.jsonl`);
    this.approvalsFile = path.join(dir, 'runs', `${runId}.approvals.json`);

    if (existsSync(this.file)) {
      // Un crash pendant l'écriture laisse une dernière ligne tronquée. Faire
      // confiance au fichier ruinerait la seule chose que le journal promet :
      // on lit ligne par ligne, on s'arrête à la première illisible, et on
      // réécrit le fichier propre. Les étapes valides restent rejouables.
      const lignes = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      for (const l of lignes) {
        try {
          this.replay.push(JSON.parse(l));
        } catch {
          this.warnings.push(
            `journal tronqué à l'étape ${this.replay.length + 1} (${lignes.length - this.replay.length} ligne(s) illisible(s) écartée(s)) : la mission reprendra à partir de là.`,
          );
          writeFileSync(this.file, this.replay.map((e) => JSON.stringify(e)).join('\n') + (this.replay.length ? '\n' : ''));
          break;
        }
      }
    }
    this.approvals = new Set(
      existsSync(this.approvalsFile) ? JSON.parse(readFileSync(this.approvalsFile, 'utf8')) : [],
    );
  }

  get replayedCount(): number { return this.replay.length; }

  isApproved(key: string): boolean { return this.approvals.has(key); }

  approveAll(keys: string[]): void {
    for (const k of keys) this.approvals.add(k);
    writeFileSync(this.approvalsFile, JSON.stringify([...this.approvals], null, 2));
  }

  /** Exécute `fn`, sauf si cette étape est déjà dans le journal. */
  async perform<T>(kind: string, key: string, fn: () => Promise<T>): Promise<T> {
    const seq = ++this.seq;
    const prior = this.replay[seq - 1];
    if (prior) {
      if (prior.key === key) return prior.value as T;
      // Le programme a divergé de la trace : on tronque et on repart d'ici.
      this.truncate(seq);
    }
    const value = await fn();
    appendFileSync(this.file, JSON.stringify({ seq, kind, key, value }) + '\n');
    return value;
  }

  private truncate(fromSeq: number): void {
    this.replay = this.replay.slice(0, fromSeq - 1);
    writeFileSync(this.file, this.replay.map((e) => JSON.stringify(e)).join('\n') + (this.replay.length ? '\n' : ''));
  }
}

// ------------------------------------------------------------------ modèle

export type ModelResult = { text: string; usd: number };

export interface ModelProvider {
  readonly name: string;
  complete(system: string, prompt: string): Promise<ModelResult>;
}

/** Fournisseur 1 : API Anthropic directe (ANTHROPIC_API_KEY). */
export class ApiProvider implements ModelProvider {
  readonly name = 'api';
  // Tarifs Claude Opus 5 : 5 usd / 25 usd par million de tokens.
  private static IN = 5 / 1_000_000;
  private static OUT = 25 / 1_000_000;

  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'claude-opus-5') { this.apiKey = apiKey; this.model = model; }

  async complete(system: string, prompt: string): Promise<ModelResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16000,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new SuperError(`API Anthropic ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const body: any = await res.json();
    if (body.stop_reason === 'refusal') throw new SuperError('le modèle a refusé cette requête');
    const text = (body.content ?? [])
      .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const u = body.usage ?? {};
    const usd = (u.input_tokens ?? 0) * ApiProvider.IN + (u.output_tokens ?? 0) * ApiProvider.OUT;
    return { text, usd };
  }
}

/**
 * Fournisseur 2 : n'importe quel endpoint compatible OpenAI — LongCat, GLM,
 * Mistral, Ollama, un modèle local. C'est le format que presque tout le monde
 * expose, donc c'est la porte d'entrée la plus large du langage.
 */
export class OpenAICompatProvider implements ModelProvider {
  readonly name: string;
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private usdIn: number;
  private usdOut: number;

  constructor(opts: { name?: string; apiKey: string; baseURL: string; model: string; usdIn?: number; usdOut?: number }) {
    this.name = opts.name ?? 'openai';
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.model = opts.model;
    this.usdIn = opts.usdIn ?? 0;
    this.usdOut = opts.usdOut ?? 0;
  }

  async complete(system: string, prompt: string): Promise<ModelResult> {
    const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new SuperError(`${this.name} ${res.status} : ${(await res.text()).slice(0, 400)}`);
    const body: any = await res.json();
    if (body.error) throw new SuperError(`${this.name} : ${JSON.stringify(body.error).slice(0, 300)}`);
    const choice = body.choices?.[0];
    if (!choice) throw new SuperError(`${this.name} : réponse sans choix — ${JSON.stringify(body).slice(0, 300)}`);
    const text = choice.message?.content ?? '';
    const u = body.usage ?? {};
    const usd = (u.prompt_tokens ?? 0) * this.usdIn + (u.completion_tokens ?? 0) * this.usdOut;
    return { text: String(text), usd };
  }
}

/** Fournisseur 3 : la CLI `claude` locale, qui réutilise ta session existante. */
export class CliProvider implements ModelProvider {
  readonly name = 'cli';

  async complete(system: string, prompt: string): Promise<ModelResult> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', `${system}\n\n---\n\n${prompt}`, '--output-format', 'json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new SuperError(`claude CLI a échoué (${code}) : ${err.slice(0, 300)}`));
        try {
          const body = JSON.parse(out);
          if (body.is_error) return reject(new SuperError(`claude CLI : ${body.result}`));
          resolve({ text: body.result ?? '', usd: body.total_cost_usd ?? 0 });
        } catch {
          reject(new SuperError(`réponse illisible de claude CLI : ${out.slice(0, 300)}`));
        }
      });
    });
  }
}

/**
 * Fournisseur 3 : fixtures. Sert à tester tout le runtime sans modèle et sans
 * réseau. Chaque réponse est indexée par l'empreinte du prompt, donc une
 * exécution hors ligne est reproductible à l'identique.
 */
export class FixtureProvider implements ModelProvider {
  readonly name = 'fixtures';
  private data: Record<string, string>;
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  /**
   * Deux niveaux de clé. La clé exacte couvre le prompt entier. La clé souple
   * ne couvre que la première ligne (l'instruction, ou la description d'un
   * skill), pour qu'une fixture reste valable quand les données d'entrée
   * changent — sinon une démo ne serait rejouable que le jour de son
   * enregistrement.
   */
  static keysFor(system: string, prompt: string): { exact: string; loose: string } {
    return {
      exact: sha(system + '|' + prompt),
      loose: 'loose:' + sha(prompt.split('\n')[0]),
    };
  }

  async complete(system: string, prompt: string): Promise<ModelResult> {
    const { exact, loose } = FixtureProvider.keysFor(system, prompt);
    const hit = exact in this.data ? exact : loose in this.data ? loose : null;
    if (hit === null) {
      throw new SuperError(
        `aucune fixture pour ce prompt.\n` +
        `Ajoute l'une de ces clés dans ${this.file} :\n` +
        `  ${JSON.stringify(exact)}   (exacte : prompt entier)\n` +
        `  ${JSON.stringify(loose)}   (souple : première ligne seulement)\n` +
        `Prompt concerné :\n${prompt.slice(0, 400)}`,
      );
    }
    return { text: this.data[hit], usd: 0 };
  }
}

/** Lit une clé depuis une variable d'environnement, sinon depuis un fichier. */
function readKey(envVar: string, file: string): string | null {
  if (process.env[envVar]) return process.env[envVar]!;
  const p = file.replace(/^~/, process.env.HOME ?? '');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

export function pickProvider(opts: { provider?: string; fixtures?: string; model?: string; baseUrl?: string }): ModelProvider {
  const want = opts.provider ?? (process.env.ANTHROPIC_API_KEY ? 'api' : 'fixtures');

  if (want === 'api') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new SuperError('ANTHROPIC_API_KEY absent : impossible d\'utiliser le fournisseur « api »');
    return new ApiProvider(key, opts.model ?? process.env.SUPER_MODEL ?? 'claude-opus-5');
  }

  if (want === 'longcat') {
    const key = readKey('LONGCAT_API_KEY', '~/.config/longcat/key');
    if (!key) throw new SuperError('clé LongCat introuvable : définis LONGCAT_API_KEY ou place-la dans ~/.config/longcat/key');
    return new OpenAICompatProvider({
      name: 'longcat',
      apiKey: key,
      baseURL: opts.baseUrl ?? 'https://api.longcat.chat/openai',
      model: opts.model ?? process.env.SUPER_MODEL ?? 'LongCat-2.0',
    });
  }

  if (want === 'openai') {
    const key = process.env.SUPER_API_KEY;
    const baseURL = opts.baseUrl ?? process.env.SUPER_BASE_URL;
    if (!key) throw new SuperError('SUPER_API_KEY absent pour le fournisseur « openai »');
    if (!baseURL) throw new SuperError('indique --base-url (ou SUPER_BASE_URL) pour le fournisseur « openai »');
    return new OpenAICompatProvider({
      apiKey: key,
      baseURL,
      model: opts.model ?? process.env.SUPER_MODEL ?? 'gpt-4o-mini',
    });
  }

  if (want === 'cli') return new CliProvider();
  if (want === 'fixtures') return new FixtureProvider(opts.fixtures ?? '.super/fixtures.json');
  throw new SuperError(`fournisseur de modèle inconnu : ${want} (api, longcat, openai, cli, fixtures)`);
}

// ------------------------------------------------------------------- effets

export type EffectContext = {
  caps: Capabilities;
  budget: Budget;
  journal: Journal;
  cwd: string;
};

export async function runEffect(
  ctx: EffectContext,
  ns: string,
  op: string,
  args: any[],
  retries: number,
  timeoutMs: number | null,
): Promise<any> {
  const target = String(args[0] ?? '');
  ctx.caps.check(ns, op, target);
  ctx.budget.step(`!${ns}.${op}`);

  const key = sha({ ns, op, args });
  return ctx.journal.perform('effect', key, async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await withTimeout(doEffect(ctx, ns, op, args), timeoutMs);
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await sleep(300 * 2 ** attempt);
      }
    }
    throw new SuperError(`!${ns}.${op} a échoué après ${retries + 1} tentative(s) : ${(lastErr as Error).message}`);
  });
}

async function doEffect(ctx: EffectContext, ns: string, op: string, args: any[]): Promise<any> {
  if (ns === 'net' && op === 'get') {
    const res = await fetch(String(args[0]), { headers: { 'user-agent': 'super/0.1' } });
    if (!res.ok) throw new SuperError(`HTTP ${res.status} sur ${args[0]}`);
    const body = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) { try { return JSON.parse(body); } catch { return body; } }
    return body;
  }
  if (ns === 'net' && op === 'post') {
    const [url, corps, entetes] = args;
    const estTexte = typeof corps === 'string';
    const res = await fetch(String(url), {
      method: 'POST',
      headers: {
        'content-type': estTexte ? 'text/plain; charset=utf-8' : 'application/json',
        'user-agent': 'super/0.1',
        ...(entetes && typeof entetes === 'object' ? entetes : {}),
      },
      body: estTexte ? corps : JSON.stringify(corps ?? {}),
    });
    const texte = await res.text();
    if (!res.ok) throw new SuperError(`HTTP ${res.status} sur POST ${url} : ${texte.slice(0, 200)}`);
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) { try { return JSON.parse(texte); } catch { return texte; } }
    return texte;
  }
  if (ns === 'fs' && op === 'graph') return buildGraph(ctx.cwd, String(args[0]));
  if (ns === 'file' && op === 'read') {
    return fs.readFile(path.resolve(ctx.cwd, String(args[0])), 'utf8');
  }
  if (ns === 'file' && (op === 'write' || op === 'append')) {
    const p = path.resolve(ctx.cwd, String(args[0]));
    await fs.mkdir(path.dirname(p), { recursive: true });
    const content = String(args[1] ?? '');
    if (op === 'write') await fs.writeFile(p, content);
    else await fs.appendFile(p, content);
    return String(args[0]);
  }
  throw new SuperError(`effet inconnu : !${ns}.${op}`);
}

const IGNORE = new Set(['node_modules', '.git', '.super', 'out', 'dist', 'build', '.next', 'coverage']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Index plat d'un ensemble de fichiers, plus leurs liens d'import.
 *
 * C'est volontairement un index et pas une base : une fiche plate se parcourt
 * avec « where » et « map », se relit d'un coup d'œil, et le journal la rend
 * gratuite à rejouer. Une mission qui boucle sur un dépôt consulte le graphe
 * une fois et travaille dessus ensuite.
 */
async function buildGraph(cwd: string, pattern: string): Promise<any> {
  const fichiers: any[] = [];
  const chemins = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') { if (IGNORE.has(e.name)) continue; }
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(cwd, full);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!matchPattern(pattern, rel)) continue;
      const contenu = await fs.readFile(full, 'utf8').catch(() => null);
      if (contenu === null) continue;
      chemins.add(rel);
      fichiers.push({
        chemin: rel,
        ext: path.extname(rel),
        octets: Buffer.byteLength(contenu),
        lignes: contenu.split('\n').length,
        contenu,
      });
    }
  }
  await walk(cwd);

  // Liens d'import, pour les fichiers de code. Seules les cibles relatives qui
  // existent dans l'index sont retenues : un lien du graphe pointe toujours
  // vers un nœud du graphe.
  const liens: any[] = [];
  const rx = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const f of fichiers) {
    if (!CODE_EXT.has(f.ext)) continue;
    for (const m of f.contenu.matchAll(rx)) {
      const cible = m[1];
      if (!cible.startsWith('.')) continue;
      const base = path.normalize(path.join(path.dirname(f.chemin), cible));
      const candidats = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs'].flatMap((x) => [base + x, path.join(base, 'index' + x)])];
      const trouve = candidats.find((c) => chemins.has(c));
      if (trouve && trouve !== f.chemin) liens.push({ de: f.chemin, vers: trouve });
    }
  }

  // Le contenu ne part pas dans le graphe : il serait recopié dans le journal
  // à chaque exécution. On garde l'index, on relit un fichier avec !file.read.
  return {
    fichiers: fichiers.map(({ contenu, ...reste }) => reste).sort((a, b) => a.chemin.localeCompare(b.chemin)),
    liens: liens.sort((a, b) => (a.de + a.vers).localeCompare(b.de + b.vers)),
  };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout<T>(p: Promise<T>, ms: number | null): Promise<T> {
  if (ms === null) return p;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new SuperError(`délai de ${ms}ms dépassé`)), ms)),
  ]);
}

// ------------------------------------------------------- appels au modèle

export function describeType(t: any): string {
  if (t.t === 'list') return `list<${describeType(t.of)}>`;
  if (t.t === 'record') return `{${t.fields.map((f: any) => `${f.name}: ${describeType(f.type)}`).join(', ')}}`;
  return t.t;
}

const ASK_SYSTEM =
  'Tu es le moteur d\'inférence du langage Super Code. On te donne une instruction, ' +
  'des entrées, et un type de sortie. Tu réponds UNIQUEMENT par une valeur JSON ' +
  'conforme au type demandé. Pas de texte autour, pas de bloc de code, pas ' +
  'd\'explication. Si le type est « text », réponds par une chaîne JSON.';

export async function runAsk(
  ctx: EffectContext,
  provider: ModelProvider,
  prompt: string,
  args: any[],
  type: any,
): Promise<any> {
  ctx.budget.step('~modèle');
  const typeDesc = describeType(type);
  const userMsg =
    `Instruction : ${prompt}\n\n` +
    (args.length ? `Entrées :\n${args.map((a, i) => `[${i}] ${JSON.stringify(a).slice(0, 20000)}`).join('\n')}\n\n` : '') +
    `Type de sortie attendu : ${typeDesc}\n` +
    `Réponds uniquement par la valeur JSON.`;

  const key = sha({ ask: prompt, args, type: typeDesc });
  return ctx.journal.perform('ask', key, async () => {
    let raw = await provider.complete(ASK_SYSTEM, userMsg);
    ctx.budget.charge(raw.usd, '~modèle');
    let parsed = tryParseJson(raw.text, type);
    if (parsed.ok) return parsed.value;

    // Une seule réparation : on renvoie l'erreur au modèle.
    const repair = await provider.complete(
      ASK_SYSTEM,
      `${userMsg}\n\nTa réponse précédente était invalide (${parsed.error}) :\n${raw.text.slice(0, 1000)}\n\nRenvoie uniquement le JSON corrigé.`,
    );
    ctx.budget.charge(repair.usd, '~modèle (réparation)');
    parsed = tryParseJson(repair.text, type);
    if (parsed.ok) return parsed.value;
    throw new SuperError(`le modèle n'a pas produit de ${typeDesc} valide : ${parsed.error}`);
  });
}

function stripFences(t: string): string {
  const m = t.trim().match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return (m ? m[1] : t).trim();
}

function tryParseJson(text: string, type: any): { ok: true; value: any } | { ok: false; error: string } {
  const body = stripFences(text);
  let value: any;
  try {
    value = JSON.parse(body);
  } catch {
    // Le type « text » tolère une réponse en clair.
    if (type.t === 'text') return { ok: true, value: body };
    return { ok: false, error: 'JSON illisible' };
  }
  // « as text » accepte tout ce qui se lit : une chaîne JSON, un nombre, ou du
  // texte brut qui se trouvait être du JSON valide. Exiger la chaîne JSON
  // rendrait le type le plus courant du langage le plus fragile.
  if (type.t === 'text' && typeof value !== 'string') {
    return { ok: true, value: typeof value === 'object' ? body : String(value) };
  }
  const err = typeError(value, type);
  return err ? { ok: false, error: err } : { ok: true, value };
}

/** Vérification structurelle : renvoie null si la valeur est conforme. */
export function typeError(v: any, t: any, at = 'valeur'): string | null {
  switch (t.t) {
    case 'any': return null;
    case 'text': return typeof v === 'string' ? null : `${at} devrait être text`;
    case 'number': return typeof v === 'number' ? null : `${at} devrait être number`;
    case 'bool': return typeof v === 'boolean' ? null : `${at} devrait être bool`;
    case 'list':
      if (!Array.isArray(v)) return `${at} devrait être une liste`;
      for (let i = 0; i < v.length; i++) {
        const e = typeError(v[i], t.of, `${at}[${i}]`);
        if (e) return e;
      }
      return null;
    case 'record': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return `${at} devrait être une fiche`;
      for (const f of t.fields) {
        if (!(f.name in v)) return `${at}.${f.name} manquant`;
        const e = typeError(v[f.name], f.type, `${at}.${f.name}`);
        if (e) return e;
      }
      return null;
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ skills

const SKILL_SYSTEM =
  'Tu écris une fonction JavaScript pure. On te donne une description en ' +
  'français, la signature, et un exemple d\'entrée réelle. Tu réponds ' +
  'UNIQUEMENT par une expression de fonction fléchée JavaScript, sans texte ' +
  'autour et sans bloc de code. La fonction doit être déterministe, sans accès ' +
  'réseau, sans accès disque, sans require, sans import. Seuls sont ' +
  'disponibles les objets de base de JavaScript, plus URL et URLSearchParams. ' +
  'Si la tâche ne peut pas être résolue par du code pur et déterministe, ' +
  'réponds exactement : IMPOSSIBLE';

export type SkillDef = { name: string; params: { name: string; type: any }[]; ret: any; desc: string };

/** Empreinte forte, utilisée pour l'intégrité du code des skills. */
export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

type ManifestEntry = { skill: string; sha256: string; approuveLe: string; origine: string };

/**
 * Registre d'intégrité du cache des skills.
 *
 * Le cache contient du code exécutable écrit par un modèle. Sans contrôle,
 * tout ce qui sait écrire dans ce dossier obtient l'exécution de code au run
 * suivant. Le manifeste enregistre l'empreinte de chaque fichier approuvé, et
 * le code dont l'empreinte ne correspond pas n'est jamais exécuté.
 */
export class SkillManifest {
  private file: string;
  private data: Record<string, ManifestEntry>;

  constructor(cacheDir: string) {
    this.file = path.join(cacheDir, 'manifest.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  /** null si conforme, sinon la raison du refus. */
  verify(fileName: string, source: string): string | null {
    const entry = this.data[fileName];
    if (!entry) return `code de skill non approuvé (absent du manifeste) : ${fileName}`;
    if (entry.sha256 !== sha256(source)) {
      return `code de skill modifié depuis son approbation : ${fileName}\n` +
             `  empreinte attendue ${entry.sha256.slice(0, 16)}…\n` +
             `  empreinte trouvée  ${sha256(source).slice(0, 16)}…\n` +
             `  si la modification est voulue : super trust`;
    }
    return null;
  }

  record(fileName: string, source: string, origine: string): void {
    this.data[fileName] = {
      skill: fileName.split('.')[0],
      sha256: sha256(source),
      approuveLe: new Date().toISOString(),
      origine,
    };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  entries(): [string, ManifestEntry][] { return Object.entries(this.data); }
}

/**
 * Une abstraction décrite en une phrase devient une fonction déterministe.
 * Le premier appel la fait écrire par le modèle, la teste sur l'entrée réelle,
 * puis la met en cache. Les appels suivants ne coûtent plus rien.
 */
export class SkillRegistry {
  private compiled = new Map<string, string>();
  private sandbox = new IsolatedSandbox();
  private cacheDir: string;
  private provider: ModelProvider;
  private ctx: EffectContext;
  private log: (m: string) => void;
  private manifest: SkillManifest;

  constructor(dir: string, provider: ModelProvider, ctx: EffectContext, log: (m: string) => void) {
    this.provider = provider;
    this.ctx = ctx;
    this.log = log;
    this.cacheDir = path.join(dir, 'skills');
    mkdirSync(this.cacheDir, { recursive: true });
    this.manifest = new SkillManifest(this.cacheDir);
  }

  private cachePath(def: SkillDef): string {
    return path.join(this.cacheDir, `${def.name}.${sha(def.desc + describeType(def.ret))}.js`);
  }

  async call(def: SkillDef, args: any[]): Promise<any> {
    const src = await this.resolve(def, args);
    if (src) {
      let out: any;
      try {
        out = await this.sandbox.call(src, args);
      } catch (e) {
        throw new SuperError(`le skill « ${def.name} » a échoué : ${(e as Error).message}`);
      }
      const err = typeError(out, def.ret, `${def.name}(...)`);
      if (err) throw new SuperError(`le skill « ${def.name} » a renvoyé une valeur hors type : ${err}`);
      return out;
    }
    // Pas de code possible : on retombe sur un appel au modèle, à chaque appel.
    return runAsk(this.ctx, this.provider, def.desc, args, def.ret);
  }

  /** Libère le processus du bac à sable en fin de mission. */
  close(): void { this.sandbox.kill(); }

  private async resolve(def: SkillDef, args: any[]): Promise<string | null> {
    if (this.compiled.has(def.name)) return this.compiled.get(def.name)!;

    const file = this.cachePath(def);
    const fileName = path.basename(file);
    if (existsSync(file)) {
      const src = readFileSync(file, 'utf8');
      if (src === 'IMPOSSIBLE') return null;
      // Le code en cache n'est exécuté que si son empreinte correspond à celle
      // enregistrée au moment où il a été synthétisé et testé.
      const refus = this.manifest.verify(fileName, src);
      if (refus) throw new SuperError(refus);
      this.compiled.set(def.name, src);
      return src;
    }

    this.log(`skill « ${def.name} » : synthèse en cours…`);
    const sig = `(${def.params.map((p) => `${p.name}: ${describeType(p.type)}`).join(', ')}) -> ${describeType(def.ret)}`;
    const prompt =
      `Description : ${def.desc}\n` +
      `Signature : ${sig}\n` +
      `Exemple d'entrée réelle : ${JSON.stringify(args).slice(0, 4000)}\n\n` +
      `Écris la fonction fléchée JavaScript correspondante.`;

    const res = await this.provider.complete(SKILL_SYSTEM, prompt);
    this.ctx.budget.charge(res.usd, `skill ${def.name}`);
    const src = stripFences(res.text);

    if (src.trim() === 'IMPOSSIBLE') {
      writeFileSync(file, 'IMPOSSIBLE');
      this.manifest.record(fileName, 'IMPOSSIBLE', this.provider.name);
      this.log(`skill « ${def.name} » : non exprimable en code, il restera un appel au modèle.`);
      return null;
    }

    // Le code fraîchement écrit est essayé dans le bac à sable isolé, sur
    // l'entrée réelle, avant d'être approuvé et mis en cache.
    try {
      const out = await this.sandbox.call(src, args);
      const err = typeError(out, def.ret, `${def.name}(...)`);
      if (err) throw new SuperError(err);
    } catch (e) {
      this.log(`skill « ${def.name} » : le code synthétisé est invalide (${(e as Error).message}), repli sur le modèle.`);
      writeFileSync(file, 'IMPOSSIBLE');
      this.manifest.record(fileName, 'IMPOSSIBLE', this.provider.name);
      return null;
    }

    writeFileSync(file, src);
    this.manifest.record(fileName, src, this.provider.name);
    this.compiled.set(def.name, src);
    this.log(`skill « ${def.name} » : compilé, empreinte enregistrée, mis en cache (${path.relative(process.cwd(), file)}).`);
    return src;
  }
}

