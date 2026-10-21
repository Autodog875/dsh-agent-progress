// Verifies that background jobs (registry events) become rows, across sessions.
import fs from 'node:fs';

fs.copyFileSync(new URL('../lib/index.js', import.meta.url), new URL('./_copy-index.js', import.meta.url));
const mod = await import('./_copy-index.js');

let listener;
const fakeJobs = {
  events: {
    subscribe(_filter, fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    }
  },
  list() {
    return [];
  }
};
const ctx = {
  get(name) {
    return name === 'jobs' ? fakeJobs : undefined;
  },
  logger: { info() {}, warn() {} }
};
const svc = new mod.AgentProgressService(ctx, { dir: 'C:/Users/13001/.dsh/agent-progress-does-not-exist' });

const base = {
  id: 'pwsh-0123456789abcdef',
  kind: 'pwsh',
  label: 'Verify uploaded package.json and README',
  status: 'running',
  startedAt: Date.now() - 30000
};
listener({ type: 'registered', job: { ...base, owner: { id: 'session-other' } } });
listener({ type: 'progress', job: { ...base, progress: '7/10 files', owner: { id: 'session-other' } } });

const live = await svc.state({ sessionId: 'session-current', global: true });
const row = live.tasks.find((task) => task.key === 'job:pwsh-0123456789abcdef');
console.log('running job ->', row === undefined ? '(MISSING)' : JSON.stringify({
  label: row.label,
  status: row.status,
  percent: row.percent,
  phase: row.phase,
  foreign: row.foreign,
  sessionId: row.sessionId
}));
if (row === undefined) process.exitCode = 1;
if (row !== undefined && (row.percent !== 70 || row.foreign !== true || row.status !== 'running')) process.exitCode = 1;

listener({ type: 'settled', job: { ...base, status: 'failed', detail: 'exit 1', finishedAt: Date.now(), owner: { id: 'session-other' } } });
const after = await svc.state({ sessionId: 'session-current', global: true });
const done = after.tasks.find((task) => task.key === 'job:pwsh-0123456789abcdef');
console.log('settled job ->', done === undefined ? '(MISSING, expected within keep window)' : `${done.status} phase=${done.phase}`);
if (done === undefined || done.status !== 'failed') process.exitCode = 1;

console.log(process.exitCode === 1 ? 'FAIL' : 'ALL PASS (jobs)');
