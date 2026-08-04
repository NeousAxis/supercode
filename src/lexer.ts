// Super Code — analyse lexicale.
// Un seul passage, pas de regex globale, pour que les erreurs pointent une ligne.

export type StrPart = { text: string } | { code: string; line: number };

export type Tok = {
  t: string; // type: 'ident' | 'num' | 'str' | 'money' | 'dur' | 'kw' | symbole brut | 'eof'
  v?: any;
  parts?: StrPart[];
  line: number;
  col: number;
};

export const KEYWORDS = new Set([
  'mission', 'skill', 'uses', 'budget', 'every',
  'let', 'if', 'else', 'for', 'in', 'repeat', 'until', 'confirm', 'log', 'done', 'fail',
  'where', 'map', 'retry', 'timeout', 'as',
  'and', 'or', 'not', 'true', 'false', 'null', 'it', 'steps',
]);

// Les symboles longs d'abord : l'ordre de ce tableau est significatif.
const SYMBOLS = [
  '|>', '->', '==', '!=', '<=', '>=',
  '{', '}', '(', ')', '[', ']', ',', ':', '.', '!', '~',
  '<', '>', '+', '-', '*', '/', '=',
];

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };

export class SuperSyntaxError extends Error {
  readonly code = 'SYNTAX_ERROR';
  line: number;
  col: number;
  constructor(msg: string, line: number, col: number) {
    super(`${msg} (ligne ${line}, colonne ${col})`);
    this.name = 'SuperSyntaxError';
    this.line = line;
    this.col = col;
  }
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1, col = 1;

  const peek = (k = 0) => src[i + k];
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isAlnum = (c: string) => isAlpha(c) || isDigit(c);

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    if (c === '#') { while (i < src.length && src[i] !== '\n') advance(); continue; }

    const startLine = line, startCol = col;

    // Texte, avec interpolation {expr}
    if (c === '"') {
      advance();
      const parts: StrPart[] = [];
      let buf = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const n = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', '{': '{', '}': '}' };
          if (n in map) { buf += map[n]; advance(2); continue; }
          throw new SuperSyntaxError(`échappement inconnu \\${n}`, line, col);
        }
        if (src[i] === '{') {
          if (buf) { parts.push({ text: buf }); buf = ''; }
          advance();
          const codeLine = line;
          let depth = 1, code = '';
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) break; }
            code += src[i];
            advance();
          }
          if (depth !== 0) throw new SuperSyntaxError('interpolation { non fermée', startLine, startCol);
          advance(); // }
          parts.push({ code, line: codeLine });
          continue;
        }
        buf += src[i];
        advance();
      }
      if (i >= src.length) throw new SuperSyntaxError('texte non fermé', startLine, startCol);
      advance(); // "
      if (buf || parts.length === 0) parts.push({ text: buf });
      toks.push({ t: 'str', parts, line: startLine, col: startCol });
      continue;
    }

    // Nombres, avec suffixe éventuel : durée ou argent
    if (isDigit(c)) {
      let num = '';
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) { num += src[i]; advance(); }
      let suffix = '';
      while (i < src.length && isAlpha(src[i])) { suffix += src[i]; advance(); }
      const value = parseFloat(num);
      if (suffix === '') {
        toks.push({ t: 'num', v: value, line: startLine, col: startCol });
      } else if (suffix in DURATION_UNITS) {
        toks.push({ t: 'dur', v: value * DURATION_UNITS[suffix], line: startLine, col: startCol });
      } else if (suffix === 'usd' || suffix === 'eur') {
        toks.push({ t: 'money', v: value, line: startLine, col: startCol });
      } else {
        throw new SuperSyntaxError(`suffixe numérique inconnu « ${suffix} »`, startLine, startCol);
      }
      continue;
    }

    // Identifiants et mots-clés
    if (isAlpha(c)) {
      let id = '';
      while (i < src.length && isAlnum(src[i])) { id += src[i]; advance(); }
      toks.push({ t: KEYWORDS.has(id) ? 'kw' : 'ident', v: id, line: startLine, col: startCol });
      continue;
    }

    // Symboles
    let matched = false;
    for (const s of SYMBOLS) {
      if (src.startsWith(s, i)) {
        advance(s.length);
        toks.push({ t: s, line: startLine, col: startCol });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    throw new SuperSyntaxError(`caractère inattendu « ${c} »`, line, col);
  }

  toks.push({ t: 'eof', line, col });
  return toks;
}
