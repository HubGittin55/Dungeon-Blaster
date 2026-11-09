// Images are first-class in this repo, and that used to be a lie: `.gitignore` carried blanket
// `*.png` / `*.jpg` lines, so every image - art candidates, UI captures, a reference frame from the
// d20 - was silently unaddable, and "git didn't take it" looked like a mistake in whatever I'd just
// typed rather than a rule. The fix isn't a comment saying images are welcome; it's a test that fails
// the moment an extension ban comes back.
//
//   node test/ignore_test.mjs
//
// Two things must hold at once, and a single assertion can't see either:
//   1. no image extension is ignored anywhere in the tree, and
//   2. the things that are private (transcripts, saves, weights, the architecture PDF) still are.
// Relaxing (1) by deleting rules wholesale would break (2), so both directions are checked.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const git = (...args) => spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? pass++ : fails.push(what));

// --- 0. the repo is a repo -------------------------------------------------
const top = git('rev-parse', '--show-toplevel');
if (top.status !== 0) {
  console.error('ignore_test: not a git work tree, nothing to assert');
  process.exit(1);
}

// --- 1. git's own answer, not my reading of the patterns -------------------
// --no-index asks the ignore engine what it would do to an untracked path, which is the only
// question that matters here: the point is that a new image can be added.
const ignored = (p) => {
  const r = git('check-ignore', '-q', '--no-index', p);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git check-ignore failed for ${p}: ${r.stderr || r.status}`);
};

const IMAGES = ['docs/x.png', 'art/y.jpg', 'z.jpeg', 'docs/deep/nested/shot.gif', 'a/b/c.webp', 'ui/overlay.svg', 'game/client/card.png'];
for (const p of IMAGES) ok(!ignored(p), `image must be addable but git would ignore it: ${p}`);

const PRIVATE = [
  'journal/messages.jsonl', 'journal/shots/whatever.png', 'shots/whatever.png', 'capture/whatever.png',
  'saves/slot1.json', 'models/heavy.gguf', 'weights.safetensors', 'notes/hf_api.json', 'arch.pdf', '__pycache__/x.pyc',
];
for (const p of PRIVATE) ok(ignored(p), `private artifact is no longer ignored: ${p}`);

// journal/shots is the interesting pair: a transcript screenshot must stay private while a UI
// screenshot in docs/ is fine. That distinction can only come from the path, which is the whole
// argument against banning by extension.
ok(ignored('journal/shots/ui.png') && !ignored('docs/art/ui.png'), 'path rule for screenshots vs art is not working');

// --- 2. the text of .gitignore, so the rule says out loud what git enforces -
const gi = readFileSync(join(REPO, '.gitignore'), 'utf8').split(/\r?\n/);
const ban = /^\s*\*?\.(png|jpe?g|gif|webp|bmp|tiff?|svg)\s*$/i;
for (const line of gi) ok(!ban.test(line), `.gitignore bans an image extension by rule: "${line}"`);
ok(gi.some((l) => /^\s*\*\.pdf\s*$/.test(l)), 'the architecture PDF must stay ignored (*.pdf)');
for (const w of ['gguf', 'safetensors', 'onnx', 'pth']) {
  ok(gi.some((l) => l.trim() === `*.${w}`), `weight-extension ignore missing: *.${w}`);
}

// --- 3. end-to-end: actually add an image and look --------------------------
// check-ignore is the rule; this is the behaviour, because the two can disagree when a global
// excludes-file or core.excludesFile is set on some other machine, which is exactly the "local and
// remote disagree" class of bug being guarded against. A real PNG signature, 8 bytes, honest about
// being a probe, and removed again before the test ends.
try {
  const dir = join(REPO, 'docs', 'art');
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, 'ignore-probe.png');
  writeFileSync(probe, Buffer.from('89504e470d0a1a0a', 'hex'));
  const st = git('status', '--porcelain', '--', 'docs/art/ignore-probe.png');
  ok(/\?\?\s+docs\/art\/ignore-probe\.png/.test(st.stdout), `git will not stage a new image: status said "${st.stdout.trim() || '(clean - ignored)'}"`);
  const add = git('add', '--', 'docs/art/ignore-probe.png');
  ok(add.status === 0, `git add refused a new image: ${add.stderr.trim() || add.status}`);
  ok(git('diff', '--cached', '--name-only').stdout.includes('docs/art/ignore-probe.png'), 'the staged image is not in the index');
  git('rm', '--cached', '-q', '--', 'docs/art/ignore-probe.png');
  rmSync(probe, { force: true });
} catch (e) {
  fails.push(`the add-an-image probe threw: ${e.message}`);
}

for (const f of fails) console.error(`  FAIL ${f}`);
console.log(`ignore: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
