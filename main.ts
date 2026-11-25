// Token launch radar: the entry point the grader runs (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, and writes the deliverables into the
// output directory: board.json, data.js for the dashboard, copies of dashboard/ and
// screenshots/, and finally dossier.json, built with the vendored make.fun library from
// everything written before it.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The scorer's own caps, mirrored so a bad build fails here instead of at grading time.
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
}

const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
mkdirSync(out, { recursive: true });

const snapshot = parseSnapshot(readFileSync(inputFile!, 'utf8'));
const radar = buildRadar(snapshot);
const issue = boardIssue(radar.board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

writeFileSync(join(out, 'board.json'), `${JSON.stringify(radar.board, null, 2)}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

for (const dir of ['dashboard', 'screenshots']) {
  const from = join(here, dir);
  const to = join(out, dir);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    copyFileSync(join(from, name), join(to, name));
  }
}

const shots = readdirSync(join(here, 'screenshots')).filter((n) => /\.(png|jpe?g)$/i.test(n));
if (shots.length < 3 || shots.length > SCREENSHOT_CAPS.max) {
  fail(`screenshots/ holds ${shots.length} images, need 3 or 4`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshot name ${name} is outside the allowed pattern`);
}

// The dossier goes last: it summarizes the output directory, so everything it
// describes has to be in place before it is built.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

process.stdout.write(
  `token radar: ${radar.board.rows.length} pre-token rows, watchlist ${radar.watchlist_size}/${radar.watchlist_size}, ` +
    `multiple ${radar.calibration.global_multiple.toFixed(4)}x from ${radar.calibration.live_samples} live protocols\n`,
);
