#!/usr/bin/env node
// Suite de conformité de Super Code.
//
// Ne teste PAS une implémentation en particulier. Elle lance une commande
// quelconque, qui doit honorer le contrat décrit dans CONTRACT.md, et compare
// sa sortie JSON aux attentes. Une implémentation écrite en Rust, en Go ou en
// Python passe cette suite exactement de la même façon.
//
//   node conformance/run.mjs
//   node conformance/run.mjs --cmd "python3 mon_super/cli.py conform"
//   node conformance/run.mjs --cmd "./super-rs conform" --only 03

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(ici, 'cases');

const args = process.argv.slice(2);
const lire = (nom, defaut) => {
  const i = args.indexOf('--' + nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};

const cmd = lire('cmd', `node ${path.join(ici, '..', 'src', 'cli.ts')} conform`);
const filtre = lire('only', null);
const niveauMax = Number(lire('niveau', '99'));
const verbeux = args.includes('--verbose');

const cas = readdirSync(casesDir)
  .filter((f) => f.endsWith('.sup'))
  .filter((f) => !filtre || f.includes(filtre))
  .sort();

if (!cas.length) {
  console.error('aucun cas trouvé dans ' + casesDir);
  process.exit(2);
}

console.log(`\nconformité Super Code — ${cas.length} cas`);
console.log(`implémentation testée : ${cd(cmd)}\n`);

let reussis = 0;
const echecs = [];
const ignores = [];

for (const fichier of cas) {
  const nom = fichier.replace(/\.sup$/, '');
  const attendu = JSON.parse(readFileSync(path.join(casesDir, nom + '.expected.json'), 'utf8'));

  // Chaque cas tourne dans un dossier neuf : aucun cas n'en influence un autre.
  const niveau = attendu.niveau ?? 1;
  if (niveau > niveauMax) { ignores.push(nom); console.log(`  --  ${nom} (niveau ${niveau}, ignoré)`); continue; }

  const bac = mkdtempSync(path.join(tmpdir(), 'super-conf-'));
  copyFileSync(path.join(casesDir, fichier), path.join(bac, 'mission.sup'));

  // Un cas de niveau 2 tourne DEUX fois dans le même dossier : la deuxième
  // exécution doit rejouer son journal et ne refaire aucun effet.
  const deuxFois = niveau >= 2;

  let obtenu;
  try {
    const brut = await lancer(cmd, path.join(bac, 'mission.sup'), bac);
    obtenu = JSON.parse(brut);
    if (deuxFois) obtenu = JSON.parse(await lancer(cmd, path.join(bac, 'mission.sup'), bac));
  } catch (e) {
    echecs.push([nom, `sortie inexploitable : ${e.message.slice(0, 300)}`]);
    console.log(`  KO  ${nom}\n      sortie inexploitable : ${e.message.slice(0, 200)}`);
    rmSync(bac, { recursive: true, force: true });
    continue;
  }
  rmSync(bac, { recursive: true, force: true });

  const ecart = comparer(attendu, obtenu);
  if (ecart) {
    echecs.push([nom, ecart]);
    console.log(`  KO  ${nom}\n      ${ecart}`);
    if (verbeux) console.log('      obtenu : ' + JSON.stringify(obtenu));
  } else {
    reussis++;
    console.log(`  ok  ${nom}`);
  }
}

const testes = cas.length - ignores.length;
console.log(`\n${reussis}/${testes} cas conformes${ignores.length ? `, ${ignores.length} ignoré(s) au-dessus du niveau ${niveauMax}` : ''}.\n`);
if (echecs.length) process.exit(1);

// ---------------------------------------------------------------- utilitaires

function lancer(commande, fichier, dossier) {
  const morceaux = commande.split(' ').filter(Boolean);
  return new Promise((resolve, reject) => {
    execFile(
      morceaux[0],
      [...morceaux.slice(1), fichier, '--dir', dossier],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Une implémentation peut sortir en code non nul sur une mission qui
        // échoue : ce qui compte est le JSON sur stdout.
        if (!stdout.trim()) return reject(new Error(stderr.trim() || (err && err.message) || 'aucune sortie'));
        resolve(stdout);
      },
    );
  });
}

/** Renvoie la première divergence, ou null si tout concorde. */
function comparer(attendu, obtenu) {
  if (!obtenu || typeof obtenu !== 'object') return 'la sortie n\'est pas un objet JSON';

  const a = JSON.stringify(attendu.logs ?? []);
  const b = JSON.stringify(obtenu.logs ?? []);
  if (a !== b) return `logs : attendu ${a}, obtenu ${b}`;

  const codeAttendu = attendu.error ? attendu.error.code : null;
  const codeObtenu = obtenu.error ? obtenu.error.code : null;
  if (codeAttendu !== codeObtenu) {
    return `erreur : attendu ${codeAttendu ?? 'aucune'}, obtenu ${codeObtenu ?? 'aucune'}`;
  }

  const fa = attendu.files ?? {};
  const fo = obtenu.files ?? {};
  const clesA = Object.keys(fa).sort(), clesO = Object.keys(fo).sort();
  if (JSON.stringify(clesA) !== JSON.stringify(clesO)) {
    return `fichiers : attendu ${JSON.stringify(clesA)}, obtenu ${JSON.stringify(clesO)}`;
  }
  for (const k of clesA) {
    if (fa[k] !== fo[k]) return `contenu de ${k} : attendu ${JSON.stringify(fa[k])}, obtenu ${JSON.stringify(fo[k])}`;
  }
  return null;
}

function cd(s) { return s.length > 70 ? '…' + s.slice(-68) : s; }
