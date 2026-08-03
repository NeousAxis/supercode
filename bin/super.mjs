#!/usr/bin/env node
// Lanceur : délègue à src/cli.ts, que Node exécute directement (type stripping).
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, '..', 'src', 'cli.ts'));
