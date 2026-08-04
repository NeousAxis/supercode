// Super Code — bac à sable isolé pour le code des skills.
//
// Le code d'un skill est écrit par un modèle. Le faire tourner dans le même
// processus que la mission, c'est lui donner l'accès au disque, au réseau et
// aux clés d'API présentes dans l'environnement. « node:vm » isole les
// variables globales, pas les capacités du processus.
//
// Ici le code part dans un processus enfant lancé avec trois barrières qui se
// recouvrent :
//   1. le modèle de permissions de Node, sans aucune autorisation accordée,
//      donc ni disque, ni sous-processus, ni worker, ni addon natif ;
//   2. un contexte « node:vm » vide, donc ni require, ni import, ni fetch,
//      ni process ;
//   3. un environnement vide, donc même une évasion complète ne trouve
//      aucune clé à voler.
//
// Un seul enfant sert toute la mission : le coût de démarrage est payé une
// fois, pas à chaque appel.

import { spawn, type ChildProcess } from 'node:child_process';

// Pas d'import depuis runtime.ts : ce module doit rester sans cycle. Les
// erreurs sont enveloppées par l'appelant.

/** Code de l'enfant. Passé par -e, donc rien n'est lu sur le disque. */
const CHILD = `
import vm from 'node:vm';
const ctx = vm.createContext({ URL, URLSearchParams });
const compiles = new Map();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const ligne = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!ligne) continue;
    let msg;
    try { msg = JSON.parse(ligne); } catch { continue; }
    let out;
    try {
      let fn = compiles.get(msg.src);
      if (!fn) {
        fn = vm.runInContext('(' + msg.src + ')', ctx, { timeout: 1000 });
        if (typeof fn !== 'function') throw new Error("le code synthétisé n'est pas une fonction");
        compiles.set(msg.src, fn);
      }
      const v = fn.apply(null, msg.args);
      if (v && typeof v.then === 'function') throw new Error('un skill ne peut pas être asynchrone');
      out = { id: msg.id, ok: true, value: v === undefined ? null : v };
    } catch (e) {
      out = { id: msg.id, ok: false, error: String((e && e.message) || e) };
    }
    try { process.stdout.write(JSON.stringify(out) + '\\n'); }
    catch { process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: 'valeur non sérialisable' }) + '\\n'); }
  }
});
`;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class IsolatedSandbox {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  private mort: string | null = null;
  private timeoutMs: number;

  constructor(timeoutMs = 5000) { this.timeoutMs = timeoutMs; }

  private start(): ChildProcess {
    if (this.child) return this.child;

    const child = spawn(
      process.execPath,
      ['--permission', '--input-type=module', '-e', CHILD],
      { stdio: ['pipe', 'pipe', 'pipe'], env: {} },
    );

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const ligne = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!ligne) continue;
        let msg: any;
        try { msg = JSON.parse(ligne); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      }
    });

    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { stderr += d; });

    child.on('exit', (code) => {
      this.mort = `le bac à sable s'est arrêté (code ${code})${stderr ? ' : ' + stderr.slice(0, 300) : ''}`;
      this.child = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(this.mort!)); }
      this.pending.clear();
    });

    child.on('error', (e) => {
      this.mort = `impossible de démarrer le bac à sable : ${e.message}`;
    });

    this.child = child;
    return child;
  }

  async call(src: string, args: any[]): Promise<any> {
    if (this.mort) throw new Error(this.mort);
    const child = this.start();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Un skill qui ne rend pas la main tue le bac à sable : on le coupe
        // net plutôt que de laisser la mission bloquée.
        this.kill();
        reject(new Error(`le skill a dépassé ${this.timeoutMs}ms, bac à sable interrompu`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ id, src, args }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`écriture vers le bac à sable impossible : ${err.message}`));
        }
      });
    });
  }

  kill(): void {
    if (this.child) { this.child.kill('SIGKILL'); this.child = null; }
  }
}
