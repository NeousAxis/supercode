// Super Code — interface en ligne de commande.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parser.ts';
import { runMission } from './interp.ts';
import { Journal, SkillManifest, SuperError, pickProvider, describeType } from './runtime.ts';
import { SuperSyntaxError } from './lexer.ts';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a === '-o') {
      const name = a === '-o' ? 'out' : a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { flags[name] = next; i++; }
      else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const USAGE = `
${C.bold('super')} — le langage des missions

  super write "<demande>" -o <f.sup>            fait écrire la mission par le modèle
  super run <fichier.sup> [mission] [options]   exécute une mission
  super watch <fichier.sup> [mission]           relance la mission à son intervalle « every »
  super check <fichier.sup>                     vérifie la syntaxe et les capacités
  super trust [--yes]                           ré-approuve le code des skills modifié
  super approve <runId> [options]               approuve le point d'arrêt en attente
  super runs                                    liste les runs et leur état

Options
  --provider <nom>              api | longcat | openai | cli | fixtures
                                (défaut : api si ANTHROPIC_API_KEY, sinon fixtures)
  --model <nom>                 modèle à utiliser chez ce fournisseur
  --base-url <url>              endpoint compatible OpenAI (fournisseur « openai »)
  --fixtures <fichier>          fichier de fixtures (défaut : <dir>/fixtures.json)
  --resume <runId>              reprend un run existant au lieu d'en créer un
  --every <durée>               force l'intervalle de « super watch »
  --once                        un seul tour de « super watch »
  --yes                         approuve automatiquement tous les points d'arrêt
  --dir <chemin>                dossier d'état (défaut : .super)
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const dir = String(flags.dir ?? '.super');

  if (!cmd || cmd === 'help') { console.log(USAGE); return; }

  if (cmd === 'write') return cmdWrite(positional.slice(1).join(' '), flags, dir);
  if (cmd === 'check') return cmdCheck(positional[1]);
  if (cmd === 'trust') return cmdTrust(dir, flags);
  if (cmd === 'runs') return cmdRuns(dir);
  if (cmd === 'approve') return cmdApprove(positional[1], dir);
  if (cmd === 'run') return cmdRun(positional[1], positional[2], flags, dir);
  if (cmd === 'watch') return cmdWatch(positional[1], positional[2], flags, dir);
  if (cmd === 'conform') return cmdConform(positional[1], flags);

  console.error(C.red(`commande inconnue : ${cmd}`));
  console.log(USAGE);
  process.exit(2);
}

function loadProgram(file: string) {
  if (!file) throw new SuperError('indique un fichier .sup');
  if (!existsSync(file)) throw new SuperError(`fichier introuvable : ${file}`);
  return parse(readFileSync(file, 'utf8'));
}

/**
 * Le modèle écrit du Super Code, pas l'inverse.
 *
 * La grammaire entière tient sur une page, donc elle rentre dans un prompt
 * système : n'importe quel modèle peut produire du Super Code sans en avoir jamais
 * vu pendant son entraînement. La sortie est analysée avant d'être écrite sur
 * le disque, et une mission qui ne compile pas n'est jamais enregistrée.
 */
async function cmdWrite(demande: string, flags: Flags, dir: string) {
  if (!demande) throw new SuperError('décris la mission à écrire : super write "..."');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const grammar = readFileSync(path.join(here, '..', 'spec', 'GRAMMAR.md'), 'utf8');
  const provider = pickProvider({
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    fixtures: typeof flags.fixtures === 'string' ? flags.fixtures : path.join(dir, 'fixtures.json'),
    model: typeof flags.model === 'string' ? flags.model : undefined,
    baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
  });

  const system =
    `Tu écris des programmes dans le langage Super Code. Voici sa grammaire complète, ` +
    `qui est la seule référence : tout ce qui n'y figure pas n'existe pas.\n\n${grammar}\n\n` +
    `Tu réponds UNIQUEMENT par le code Super Code, sans texte autour et sans bloc de code. ` +
    `Déclare toujours les capacités « uses » nécessaires et un « budget ». ` +
    `Mets un « confirm » devant tout effet irréversible ou visible de l'extérieur.`;

  console.log(C.dim(`modèle : ${provider.name} — rédaction…`));

  let source = stripFences((await provider.complete(system, demande)).text);
  let erreur = validate(source);

  if (erreur) {
    console.log(C.dim(`première version invalide (${erreur}) — une correction…`));
    source = stripFences((await provider.complete(
      system,
      `${demande}\n\nTa version précédente ne compile pas : ${erreur}\n\n${source}\n\nRenvoie uniquement le code corrigé.`,
    )).text);
    erreur = validate(source);
  }

  const out = typeof flags.o === 'string' ? flags.o : typeof flags.out === 'string' ? flags.out : null;

  if (erreur) {
    console.error(C.red(`le modèle n'a pas produit de Super Code valide : ${erreur}`));
    console.error(C.dim('sortie brute ci-dessous, non enregistrée :\n'));
    console.error(source);
    process.exit(1);
  }

  if (out) {
    writeFileSync(out, source.endsWith('\n') ? source : source + '\n');
    console.log(C.green(`✓ écrit dans ${out}`) + C.dim(' — vérifié par l\'analyseur avant enregistrement'));
    cmdCheck(out);
  } else {
    console.log(source);
  }
}

/**
 * Mode conformité : le seul point de contact entre le langage et une
 * implémentation.
 *
 * Exécute la première mission d'un fichier et n'écrit sur la sortie standard
 * qu'un unique objet JSON, sans couleur, sans identifiant de run, sans horodatage.
 * Une autre implémentation de Super Code, écrite dans n'importe quel langage,
 * n'a qu'à produire le même objet pour prouver qu'elle est conforme.
 *
 * Voir conformance/CONTRACT.md.
 */
async function cmdConform(file: string, flags: Flags) {
  const workdir = typeof flags.dir === 'string' ? flags.dir : path.dirname(path.resolve(file));
  const etat = path.join(workdir, '.super');
  const logs: string[] = [];

  let sortie: any;
  try {
    const program = loadProgram(file);
    await runMission(program, null, {
      cwd: workdir,
      dir: etat,
      runId: 'conform',
      provider: pickProvider({ provider: 'fixtures', fixtures: path.join(workdir, 'fixtures.json') }),
      autoApprove: true,
      log: (m) => logs.push(m),
    });
    sortie = { logs, error: null, files: listerFichiers(workdir) };
  } catch (e) {
    const code = (e as any).code ?? 'INTERNAL';
    sortie = { logs, error: { code }, files: listerFichiers(workdir) };
  }
  // Rien d'autre ne doit sortir sur stdout : c'est ce qui rend la sortie
  // comparable entre deux implémentations.
  process.stdout.write(JSON.stringify(sortie, null, 2) + '\n');
}

/** Fichiers produits par la mission, triés, hors état interne. */
function listerFichiers(racine: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parcourir = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.super' || e.name === 'fixtures.json') continue;
      const complet = path.join(dir, e.name);
      const relatif = path.relative(racine, complet);
      if (e.isDirectory()) { parcourir(complet); continue; }
      if (relatif.endsWith('.sup') || relatif.endsWith('.expected.json')) continue;
      try { out[relatif] = readFileSync(complet, 'utf8'); } catch { /* binaire : ignoré */ }
    }
  };
  parcourir(racine);
  return out;
}

function validate(source: string): string | null {
  try {
    const p = parse(source);
    if (p.missions.length === 0) return 'aucune mission dans le programme';
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function stripFences(t: string): string {
  const m = t.trim().match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return (m ? m[1] : t).trim();
}

function cmdCheck(file: string) {
  const program = loadProgram(file);
  console.log(C.green('syntaxe correcte.'));
  for (const s of program.skills) {
    const sig = `(${s.params.map((p: any) => `${p.name}: ${describeType(p.type)}`).join(', ')}) -> ${describeType(s.ret)}`;
    console.log(`  ${C.cyan('skill')} ${s.name}${sig}`);
  }
  for (const m of program.missions) {
    console.log(`  ${C.cyan('mission')} ${m.name}`);
    for (const u of m.uses) console.log(`      ${C.dim('uses')}   ${u.ns}.${u.op}("${u.pattern}")`);
    const b = m.budget;
    const parts = [b.usd !== null && `${b.usd} usd`, b.steps !== null && `${b.steps} étapes`, b.ms !== null && `${b.ms} ms`].filter(Boolean);
    if (parts.length) console.log(`      ${C.dim('budget')} ${parts.join(', ')}`);
    if (m.every) console.log(`      ${C.dim('every')}  ${m.every} ms`);
  }
}

/**
 * Ré-approuve le code des skills en cache après une modification volontaire.
 * Affiche le code avant de l'enregistrer : approuver sans regarder n'aurait
 * aucune valeur.
 */
function cmdTrust(dir: string, flags: Flags) {
  const cacheDir = path.join(dir, 'skills');
  if (!existsSync(cacheDir)) { console.log('aucun skill en cache.'); return; }
  const manifest = new SkillManifest(cacheDir);
  const fichiers = readdirSync(cacheDir).filter((f) => f.endsWith('.js'));
  if (!fichiers.length) { console.log('aucun skill en cache.'); return; }

  let aApprouver = 0;
  for (const f of fichiers) {
    const src = readFileSync(path.join(cacheDir, f), 'utf8');
    const refus = manifest.verify(f, src);
    if (!refus) { console.log(`  ${C.dim('déjà approuvé')}  ${f}`); continue; }
    aApprouver++;
    console.log(`\n${C.yellow('à approuver')}  ${f}`);
    console.log(C.dim(`  ${refus.split('\n')[0]}`));
    console.log(src.split('\n').map((l) => '  │ ' + l).join('\n'));
    if (flags.yes === true) {
      manifest.record(f, src, 'approuvé à la main');
      console.log(C.green('  ✓ approuvé'));
    }
  }

  if (aApprouver && flags.yes !== true) {
    console.log(`\n${aApprouver} code(s) à approuver. Relis-les ci-dessus, puis :`);
    console.log(C.dim(`   super trust --yes${dir === '.super' ? '' : ` --dir ${dir}`}`));
    process.exit(10);
  }
}

function cmdRuns(dir: string) {
  const runsDir = path.join(dir, 'runs');
  if (!existsSync(runsDir)) { console.log('aucun run.'); return; }
  const ids = [...new Set(readdirSync(runsDir).map((f) => f.split('.')[0]))].sort();
  if (!ids.length) { console.log('aucun run.'); return; }
  for (const id of ids) {
    const jl = path.join(runsDir, `${id}.jsonl`);
    const steps = existsSync(jl) ? readFileSync(jl, 'utf8').split('\n').filter(Boolean).length : 0;
    const pendingFile = path.join(runsDir, `${id}.pending.json`);
    const state = existsSync(pendingFile) ? C.yellow('en attente d\'approbation') : C.green('terminé');
    console.log(`  ${id}  ${String(steps).padStart(3)} étapes  ${state}`);
  }
}

function cmdApprove(runId: string, dir: string) {
  if (!runId) throw new SuperError('indique un runId (voir « super runs »)');
  const pendingFile = path.join(dir, 'runs', `${runId}.pending.json`);
  if (!existsSync(pendingFile)) throw new SuperError(`aucun point d'arrêt en attente pour ${runId}`);
  const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
  const journal = new Journal(dir, runId);
  journal.approveAll([pending.key]);
  console.log(C.green(`approuvé : ${pending.description}`));
  console.log(C.dim(`reprends avec : super run <fichier.sup> --resume ${runId}`));
}

async function cmdRun(file: string, missionName: string | undefined, flags: Flags, dir: string, enBoucle = false) {
  const program = loadProgram(file);
  mkdirSync(dir, { recursive: true });

  const runId = String(flags.resume ?? newRunId());
  const provider = pickProvider({
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    fixtures: typeof flags.fixtures === 'string' ? flags.fixtures : path.join(dir, 'fixtures.json'),
    model: typeof flags.model === 'string' ? flags.model : undefined,
    baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
  });

  console.log(C.dim(`run ${runId} · modèle : ${provider.name}`));

  const result = await runMission(program, missionName ?? null, {
    cwd: process.cwd(),
    dir,
    runId,
    provider,
    autoApprove: flags.yes === true,
    log: (m) => console.log(`  ${m}`),
  });

  const pendingFile = path.join(dir, 'runs', `${runId}.pending.json`);

  if (result.status === 'awaiting-approval') {
    writeFileSync(pendingFile, JSON.stringify(result.pending, null, 2));
    console.log('');
    console.log(C.yellow('⏸  approbation requise avant cet effet :'));
    console.log(`   ${result.pending!.description}`);
    console.log('');
    console.log(C.dim(`   super approve ${runId}`));
    console.log(C.dim(`   super run ${file} --resume ${runId}`));
    console.log(C.dim(`   (${result.budget.summary()})`));
    // En surveillance, un point d'arrêt met ce tour en attente sans tuer la
    // planification : les tours suivants continuent, celui-ci attend toi.
    if (!enBoucle) process.exit(10);
    return;
  }

  if (existsSync(pendingFile)) {
    // Le point d'arrêt a été franchi : on nettoie l'état d'attente.
    writeFileSync(pendingFile, '');
    try { (await import('node:fs')).unlinkSync(pendingFile); } catch { /* déjà parti */ }
  }
  console.log(C.green(`✓ mission terminée`) + C.dim(` (${result.budget.summary()})`));
}

/**
 * Exécute une mission à l'intervalle qu'elle déclare avec « every ».
 *
 * Chaque déclenchement est un run à part entière, avec son propre journal, donc
 * un plantage n'emporte que le tour en cours et se reprend. Un tour qui échoue
 * est signalé et n'interrompt pas la planification : un agent de veille ne doit
 * pas mourir parce qu'une API était indisponible une fois.
 */
async function cmdWatch(file: string, missionName: string | undefined, flags: Flags, dir: string) {
  const program = loadProgram(file);
  const mission = missionName
    ? program.missions.find((m: any) => m.name === missionName)
    : program.missions[0];
  if (!mission) throw new SuperError(`mission « ${missionName} » introuvable`);

  const interval = typeof flags.every === 'string' ? parseDuree(String(flags.every)) : mission.every;
  if (!interval) {
    throw new SuperError(
      `la mission « ${mission.name} » ne déclare pas d'intervalle. Ajoute « every 6h » dans son en-tête, ou passe --every 6h.`,
    );
  }

  const uneFois = flags.once === true;
  console.log(C.dim(`surveillance de « ${mission.name} » toutes les ${humain(interval)}${uneFois ? ' (un seul tour)' : ''}`));
  console.log(C.dim('Ctrl+C pour arrêter.'));

  let arret = false;
  process.on('SIGINT', () => { arret = true; console.log(C.dim('\narrêt demandé, fin du tour en cours…')); });

  let tour = 0;
  while (!arret) {
    tour++;
    const debut = Date.now();
    console.log(`\n${C.bold(`tour ${tour}`)} ${C.dim(new Date().toISOString())}`);
    try {
      await cmdRun(file, mission.name, { ...flags, resume: undefined }, dir, true);
    } catch (e) {
      // Un tour raté ne casse pas la planification.
      console.error(C.red(`  tour ${tour} en échec : ${(e as Error).message}`));
    }
    if (uneFois || arret) break;

    const attente = Math.max(0, interval - (Date.now() - debut));
    console.log(C.dim(`  prochain tour dans ${humain(attente)}`));
    await dormir(attente, () => arret);
  }
  console.log(C.dim('surveillance terminée.'));
}

/** Sommeil découpé, pour que Ctrl+C réponde sans attendre six heures. */
async function dormir(ms: number, annule: () => boolean): Promise<void> {
  const pas = 500;
  for (let reste = ms; reste > 0 && !annule(); reste -= pas) {
    await new Promise((r) => setTimeout(r, Math.min(pas, reste)));
  }
}

function humain(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function parseDuree(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|min|h|d)$/);
  if (!m) throw new SuperError(`durée invalide : ${s} (exemples : 30s, 5min, 6h)`);
  const unites: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
  return parseFloat(m[1]) * unites[m[2]];
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

main().catch((e) => {
  if (e instanceof SuperSyntaxError) console.error(C.red(`erreur de syntaxe : ${e.message}`));
  else if (e instanceof SuperError) console.error(C.red(`erreur : ${e.message}`));
  else console.error(C.red(`erreur inattendue : ${(e as Error).stack ?? e}`));
  process.exit(1);
});
