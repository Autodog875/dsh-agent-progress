#!/usr/bin/env node
/**
 * ap.mjs — write agent progress records for dsh-agent-progress.
 *
 *   node bin/ap.mjs set --key k --label "装插件" --total 6 --done 2
 *   node bin/ap.mjs set --key k --done 4 --eta 30
 *   node bin/ap.mjs done  --key k
 *   node bin/ap.mjs fail  --key k --note "sha256 mismatch"
 *   node bin/ap.mjs hold  --key k --seconds 300      # keep a running row alive
 *   node bin/ap.mjs clear                             # remove finished rows
 *   node bin/ap.mjs dir
 *
 * Directory: <DSH_HOME>/agent-progress/<DSH_SESSION_ID>/<key>.json
 *
 * Every write is mirrored into the other session folders by default, so the
 * same row shows up in every conversation (pass `--local` to keep it to the
 * current session only).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[name] = true;
      else {
        out[name] = next;
        i += 1;
      }
    } else out._.push(token);
  }
  return out;
}

const args = parse(process.argv.slice(2));
const command = args._[0] ?? 'set';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const session = process.env.DSH_SESSION_ID || '';
if (session.length === 0) {
  console.error('DSH_SESSION_ID is not set in this shell');
  process.exit(2);
}
const root = path.join(home, 'agent-progress', session);

const key = typeof args.key === 'string' ? args.key : 'task';
const file = path.join(root, key + '.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function write(record) {
  fs.mkdirSync(root, { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(temp, file);
  mirror(record);
}

/** Copy the record into every other session folder (cross-conversation view). */
function mirror(record) {
  if (args.local === true) return;
  const base = path.join(home, 'agent-progress');
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return;
  }
  const body = JSON.stringify(record, null, 2);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === session) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    const target = path.join(dir, key + '.json');
    try {
      const temp = target + '.tmp';
      fs.writeFileSync(temp, body, 'utf8');
      fs.renameSync(temp, target);
    } catch {
      /* a session folder we cannot write is not worth failing the update */
    }
  }
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

if (command === 'dir') {
  console.log(root);
  process.exit(0);
}

if (command === 'clear') {
  const dirs = [root];
  try {
    const base = path.join(home, 'agent-progress');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== session && /^[A-Za-z0-9._-]+$/.test(entry.name)) {
        dirs.push(path.join(base, entry.name));
      }
    }
  } catch {
    /* nothing to sweep */
  }
  let removed = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const target = path.join(dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (record?.status === 'running') continue;
        fs.rmSync(target, { force: true });
        removed += 1;
      } catch {
        /* unreadable records are left alone */
      }
    }
  }
  console.log('cleared ' + removed);
  process.exit(0);
}

const previous = read() ?? {};
const now = Date.now();
const record = {
  key,
  label: typeof args.label === 'string' ? args.label : previous.label ?? key,
  unit: typeof args.unit === 'string' ? args.unit : previous.unit ?? 'count',
  total: num(args.total) ?? previous.total ?? 0,
  done: num(args.done) ?? previous.done ?? 0,
  speed: num(args.speed) ?? previous.speed ?? 0,
  eta: num(args.eta) ?? previous.eta ?? null,
  phase: typeof args.phase === 'string' ? args.phase : previous.phase ?? '',
  note: typeof args.note === 'string' ? args.note : previous.note ?? '',
  status: previous.status === 'done' || previous.status === 'failed' ? previous.status : 'running',
  startedAt: previous.startedAt ?? now,
  updatedAt: now
};

if (command === 'done') record.status = 'done';
if (command === 'fail') record.status = 'failed';
if (record.status !== 'running') {
  record.finishedAt = now;
  if (record.eta === null || record.eta === 0) record.eta = null;
}

write(record);

if (command === 'hold') {
  const seconds = Math.max(1, num(args.seconds) ?? 60);
  const until = Date.now() + seconds * 1000;
  const timer = setInterval(() => {
    if (Date.now() > until) {
      clearInterval(timer);
      const latest = read() ?? record;
      if (latest.status === 'running') {
        latest.status = 'done';
        latest.finishedAt = Date.now();
        latest.updatedAt = Date.now();
        write(latest);
      }
      return;
    }
    const latest = read() ?? record;
    if (latest.status !== 'running') {
      clearInterval(timer);
      return;
    }
    latest.updatedAt = Date.now();
    write(latest);
  }, 5000);
  timer.unref?.();
  console.log('holding ' + key + ' for ' + seconds + 's');
} else {
  console.log(record.status + ' ' + key + ' ' + record.done + '/' + record.total);
}
