// Super Code — tests. Aucune dépendance : node test/run.ts

import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parse } from '../src/parser.ts';
import { runMission } from '../src/interp.ts';
import { FixtureProvider, SkillManifest, SuperError, matchPattern } from '../src/runtime.ts';
import { SuperSyntaxError } from '../src/lexer.ts';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { failures.push(`${name} : ${(e as Error).message}`); console.log(`  KO  ${name}\n      ${(e as Error).message}`); });
}

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEq(actual: any, expected: any, msg = ''): void {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} attendu ${b}, obtenu ${a}`);
}

/** Exécute une source Super Code dans un dossier jetable et renvoie les logs. */
async function run(src: string, opts: { fixtures?: Record<string, string>; autoApprove?: boolean; dir?: string; runId?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'super-test-'));
  const fixturesFile = path.join(dir, 'fixtures.json');
  writeFileSync(fixturesFile, JSON.stringify(opts.fixtures ?? {}));
  const logs: string[] = [];
  const result = await runMission(parse(src), null, {
    cwd: dir,
    dir,
    runId: opts.runId ?? 'test',
    provider: new FixtureProvider(fixturesFile),
    autoApprove: opts.autoApprove ?? true,
    log: (m) => logs.push(m),
    diag: (m) => logs.push(m),
  });
  return { logs, result, dir };
}

async function expectFailure(src: string, fragment: string, opts: Parameters<typeof run>[1] = {}) {
  try {
    await run(src, opts);
  } catch (e) {
    const msg = (e as Error).message;
    assert(msg.includes(fragment), `message attendu contenant « ${fragment} », obtenu « ${msg} »`);
    return;
  }
  throw new Error(`aucune erreur levée, alors que « ${fragment} » était attendu`);
}

console.log('\nsuper — tests\n');

await test('arithmétique et précédence', async () => {
  const { logs } = await run(`mission m { log "{2 + 3 * 4}" log "{(2 + 3) * 4}" }`);
  assertEq(logs, ['14', '20']);
});

await test('where, map et it', async () => {
  const { logs } = await run(`
    mission m {
      let n = [1, 2, 3, 4, 5]
      let grands = n where it > 2
      let doubles = grands map it * 2
      log "{join(doubles, ",")}"
    }`);
  assertEq(logs, ['6,8,10']);
});

await test('le raccourci .champ vaut it.champ', async () => {
  const { logs } = await run(`
    mission m {
      let gens = [{nom: "Ada", age: 36}, {nom: "Alan", age: 41}]
      log "{join(gens where .age > 40 map .nom, ",")}"
    }`);
  assertEq(logs, ['Alan']);
});

await test('if / else et done', async () => {
  const { logs } = await run(`
    mission m {
      if len([1,2]) == 2 { log "deux" } else { log "pas deux" }
      done
      log "jamais atteint"
    }`);
  assertEq(logs, ['deux']);
});

await test('une capacité non déclarée est refusée', async () => {
  await expectFailure(
    `mission m {
       uses net.get("https://autorise.example/**")
       let x = !net.get("https://interdit.example/secret")
     }`,
    'capacité refusée',
  );
});

await test('une capacité déclarée passe le contrôle de motif', () => {
  assert(matchPattern('https://a.example/**', 'https://a.example/x/y'), '** doit couvrir plusieurs segments');
  assert(!matchPattern('https://a.example/**', 'https://b.example/x'), 'un autre hôte ne doit pas passer');
  assert(matchPattern('out/*', 'out/f.md'), '* doit couvrir un segment');
  assert(!matchPattern('out/*', 'out/sub/f.md'), '* ne doit pas franchir un /');
});

await test('le budget en étapes coupe la mission', async () => {
  await expectFailure(
    `mission m {
       uses file.write("**")
       budget 2 steps
       let a = !file.write("a.txt", "1")
       let b = !file.write("b.txt", "2")
       let c = !file.write("c.txt", "3")
     }`,
    'budget épuisé',
  );
});

await test('une erreur de syntaxe indique la ligne', async () => {
  try {
    parse(`mission m {\n  let x =\n}`);
    throw new Error('aucune erreur levée');
  } catch (e) {
    assert(e instanceof SuperSyntaxError, `type inattendu : ${(e as Error).name}`);
    assert((e as Error).message.includes('ligne 3'), `ligne absente du message : ${(e as Error).message}`);
  }
});

await test('un effet déjà journalisé n\'est pas refait', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-journal-'));
  const src = `
    mission m {
      uses file.write("**"), file.read("**")
      let p = !file.write("compteur.txt", "premier")
      log "écrit {p}"
    }`;
  await run(src, { dir, runId: 'r1' });
  // On modifie le fichier hors du langage : si l'effet était refait, il serait réécrit.
  writeFileSync(path.join(dir, 'compteur.txt'), 'modifié à la main');
  await run(src, { dir, runId: 'r1' });
  assertEq(readFileSync(path.join(dir, 'compteur.txt'), 'utf8'), 'modifié à la main', 'le contenu ne devait pas être réécrit :');
});

await test('un journal tronqué par un crash ne fait pas planter la reprise', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-crash-'));
  const src = `
    mission m {
      uses file.write("**")
      let a = !file.write("a.txt", "1")
      let b = !file.write("b.txt", "2")
      log "fini"
    }`;
  await run(src, { dir, runId: 'k1' });

  // On simule un crash pendant appendFileSync : dernière ligne coupée en deux.
  const jl = path.join(dir, 'runs', 'k1.jsonl');
  const entier = readFileSync(jl, 'utf8');
  writeFileSync(jl, entier.slice(0, entier.length - 25));

  const { logs } = await run(src, { dir, runId: 'k1' });
  assert(logs.some((l) => l.includes('journal tronqué')), `l'avertissement manque : ${JSON.stringify(logs)}`);
  assert(logs.includes('fini'), 'la mission doit aller au bout malgré la troncature');
});

await test('confirm bloque l\'effet tant qu\'il n\'est pas approuvé', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-confirm-'));
  const src = `
    mission m {
      uses file.write("**")
      confirm !file.write("sensible.txt", "contenu")
      log "passé"
    }`;
  const { result, logs } = await run(src, { dir, runId: 'c1', autoApprove: false });
  assertEq(result.status, 'awaiting-approval', 'statut :');
  assertEq(logs, [], 'aucun log ne doit suivre le point d\'arrêt :');
  assert(!existsSync(path.join(dir, 'sensible.txt')), 'le fichier ne devait pas être écrit');
});

await test('un confirm sans effet est refusé à l\'analyse', async () => {
  try {
    parse(`mission m { let x = "coucou" confirm x }`);
    throw new Error('aucune erreur levée : un confirm vide donnerait une fausse assurance');
  } catch (e) {
    assert(e instanceof SuperSyntaxError, `type inattendu : ${(e as Error).name}`);
    assert((e as Error).message.includes('doit porter sur un effet'), `message : ${(e as Error).message}`);
  }
  // La forme correcte, elle, passe.
  parse(`mission m { uses file.write("**") confirm !file.write("a.txt", "x") }`);
});

await test('un skill est synthétisé une fois puis relu du cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-skill-'));
  const fixtures = { ['loose:' + shaFirstLine('Description : met le texte en majuscules')] : '(t) => String(t).toUpperCase()' };
  const src = `
    skill crier(t: text) -> text { "met le texte en majuscules" }
    mission m { log crier("bonjour") }`;
  const a = await run(src, { dir, runId: 's1', fixtures });
  assertEq(a.logs.filter((l) => l.includes('BONJOUR')).length, 1, 'sortie du skill :');
  assert(a.logs.some((l) => l.includes('synthèse en cours')), 'la première exécution doit synthétiser');

  // Deuxième run, nouveau journal, mais sans fixture : le cache doit suffire.
  const b = await run(src, { dir, runId: 's2', fixtures: {} });
  assert(!b.logs.some((l) => l.includes('synthèse en cours')), 'la deuxième exécution ne doit pas rappeler le modèle');
  assert(b.logs.some((l) => l.includes('BONJOUR')), 'le skill en cache doit toujours répondre');
});

await test('un skill hors type est rejeté', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-skilltype-'));
  const fixtures = { ['loose:' + shaFirstLine('Description : compte les caractères')] : '(t) => "pas un nombre"' };
  const src = `
    skill compte(t: text) -> number { "compte les caractères" }
    mission m { log compte("abc") }`;
  // Le code synthétisé renvoie le mauvais type : le runtime le rejette et
  // retombe sur le modèle, qui n'a pas de fixture pour cet appel.
  await expectFailure(src, 'aucune fixture', { dir, runId: 't1', fixtures });
});

await test('le code d\'un skill ne voit ni process ni require', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-sandbox-'));
  const fixtures = { ['loose:' + shaFirstLine('Description : tente de lire l\'environnement')] : '() => typeof process === "undefined" && typeof require === "undefined" ? "isolé" : "fuite"' };
  const src = `
    skill sonde() -> text { "tente de lire l'environnement" }
    mission m { log sonde() }`;
  const { logs } = await run(src, { dir, runId: 'sb1', fixtures });
  assert(logs.includes('isolé'), `le bac à sable a fui : ${JSON.stringify(logs)}`);
});

await test('repeat s\'arrête quand l\'objectif est atteint', async () => {
  const { logs } = await run(`
    mission m {
      budget 20 steps
      let n = 0
      repeat {
        let n = n + 1
        log "tour {n}"
      } until n >= 3
    }`);
  assertEq(logs, ['tour 1', 'tour 2', 'tour 3']);
});

await test('ce que repeat accumule survit à la boucle', async () => {
  const { logs } = await run(`
    mission m {
      budget 20 steps
      let n = 0
      let acc = []
      repeat {
        let n = n + 1
        let acc = acc + [n * 10]
      } until n >= 3
      log "{join(acc, ",")} ({len(acc)})"
    }`);
  assertEq(logs, ['10,20,30 (3)']);
});

await test('un repeat sans budget borné est refusé à l\'analyse', async () => {
  try {
    parse(`mission m { repeat { log "x" } until false }`);
    throw new Error('aucune erreur levée : une boucle non bornée serait acceptée');
  } catch (e) {
    assert(e instanceof SuperSyntaxError, `type inattendu : ${(e as Error).name}`);
    assert((e as Error).message.includes('budget en étapes ou en durée'), `message : ${(e as Error).message}`);
  }
  // Un budget en argent seul ne borne pas une boucle purement locale.
  try {
    parse(`mission m { budget 1.00usd repeat { log "x" } until false }`);
    throw new Error('un budget en argent seul ne devrait pas suffire');
  } catch (e) {
    assert(e instanceof SuperSyntaxError, 'devrait être refusé');
  }
  parse(`mission m { budget 10 steps repeat { log "x" } until true }`);
});

await test('un objectif jamais atteint s\'arrête sur le budget', async () => {
  await expectFailure(
    `mission m {
       budget 5 steps
       repeat { log "encore" } until false
     }`,
    'budget épuisé',
  );
});

await test('!fs.graph indexe les fichiers et leurs imports', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-graph-'));
  writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b.ts';\nexport const a = 1;\n");
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  writeFileSync(path.join(dir, 'notes.md'), 'pas du code\n');
  const { logs } = await run(`
    mission m {
      uses fs.graph("**")
      let g = !fs.graph("**")
      let code = g.fichiers where .ext == ".ts"
      log "fichiers={len(g.fichiers)} code={len(code)} liens={len(g.liens)}"
      log "lien: {g.liens[0].de} -> {g.liens[0].vers}"
    }`, { dir, runId: 'g1' });
  assert(logs[0].includes('code=2'), `deux fichiers .ts attendus : ${logs[0]}`);
  assert(logs[0].includes('liens=1'), `un lien d'import attendu : ${logs[0]}`);
  assertEq(logs[1], 'lien: a.ts -> b.ts');
});

await test('un code de skill modifié en douce n\'est jamais exécuté', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-manifest-'));
  const fixtures = { ['loose:' + shaFirstLine('Description : met le texte en majuscules')]: '(t) => String(t).toUpperCase()' };
  const src = `
    skill crier(t: text) -> text { "met le texte en majuscules" }
    mission m { log crier("bonjour") }`;

  const a = await run(src, { dir, runId: 'm1', fixtures });
  assert(a.logs.some((l) => l.includes('BONJOUR')), 'première exécution :');

  // Un tiers remplace le code en cache par autre chose.
  const cacheDir = path.join(dir, 'skills');
  const cible = path.join(cacheDir, readdirSync(cacheDir).find((f) => f.endsWith('.js'))!);
  writeFileSync(cible, '(t) => "CODE INJECTÉ"');

  await expectFailure(src, 'code de skill modifié depuis son approbation', { dir, runId: 'm2', fixtures: {} });

  // Le manifeste permet de ré-approuver explicitement après relecture.
  new SkillManifest(cacheDir).record(path.basename(cible), readFileSync(cible, 'utf8'), 'test');
  const c = await run(src, { dir, runId: 'm3', fixtures: {} });
  assert(c.logs.some((l) => l.includes('CODE INJECTÉ')), 'après ré-approbation explicite :');
});

await test('un skill absent du manifeste est refusé', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-nomanifest-'));
  const cacheDir = path.join(dir, 'skills');
  mkdirSync(cacheDir, { recursive: true });
  // Du code déposé dans le cache sans passer par la synthèse.
  const nom = 'crier.' + shaFirstLine('x') + '.js';
  writeFileSync(path.join(cacheDir, nom), '(t) => "PIRATE"');
  const src = `
    skill crier(t: text) -> text { "met le texte en majuscules" }
    mission m { log crier("bonjour") }`;
  // Le nom de fichier ne correspondra pas à celui attendu, donc la synthèse
  // repart ; le test réel est qu'aucun code non enregistré ne s'exécute.
  const m = new SkillManifest(cacheDir);
  assert(m.verify(nom, '(t) => "PIRATE"') !== null, 'un fichier absent du manifeste doit être refusé');
});

await test('un skill ne peut ni lire le disque ni lancer un process', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-isole-'));
  // Du code hostile, qui tente explicitement de sortir du bac à sable.
  const hostile = `() => {
    const essais = [];
    try { essais.push('require:' + typeof require); } catch { essais.push('require:bloqué'); }
    try { essais.push('process:' + typeof process); } catch { essais.push('process:bloqué'); }
    try { essais.push('fetch:' + typeof fetch); } catch { essais.push('fetch:bloqué'); }
    return essais.join(' ');
  }`;
  const fixtures = { ['loose:' + shaFirstLine("Description : tente de sortir du bac à sable")]: hostile };
  const src = `
    skill evasion() -> text { "tente de sortir du bac à sable" }
    mission m { log evasion() }`;
  const { logs } = await run(src, { dir, runId: 'iso1', fixtures });
  const sortie = logs.find((l) => l.includes('require:')) ?? '';
  assert(sortie.includes('require:undefined'), `require ne doit pas exister : ${sortie}`);
  assert(sortie.includes('process:undefined'), `process ne doit pas exister : ${sortie}`);
  assert(sortie.includes('fetch:undefined'), `fetch ne doit pas exister : ${sortie}`);
});

await test('un skill qui boucle sans fin est interrompu', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'super-boucle-'));
  const fixtures = { ['loose:' + shaFirstLine('Description : boucle sans fin')]: '() => { while (true) {} }' };
  const src = `
    skill bloque() -> text { "boucle sans fin" }
    mission m { log bloque() }`;
  // Le code ne rend jamais la main : le bac à sable le coupe. Le skill est
  // alors jugé invalide et retombe sur le modèle, qui n'a pas de fixture ici.
  // Ce qui compte : la mission se termine au lieu de rester bloquée à jamais.
  await expectFailure(src, 'aucune fixture', { dir, runId: 'b1', fixtures });
});

function shaFirstLine(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

console.log(`\n${passed} test(s) réussis, ${failures.length} échec(s).\n`);
if (failures.length) process.exit(1);
