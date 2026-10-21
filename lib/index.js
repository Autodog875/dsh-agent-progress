/**
 * dsh-agent-progress — host half.
 *
 * Reads `<DSH home>/agent-progress/<sessionId>/<key>.json` (written by
 * `bin/ap.mjs`) and exposes the rows over the standard `/api` remote gateway as
 * `agentProgress/state`. Nothing is generated ahead of time: the web half reads
 * files on demand and never touches the job registry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

// ── stage-3 decorator support (transpiled; plain Node has no decorators) ──────
var __esDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== 'function') throw new TypeError('Function expected');
    return f;
  }
  var kind = contextIn.kind, key = kind === 'getter' ? 'get' : kind === 'setter' ? 'set' : 'value';
  var target = !descriptorIn && ctor ? (contextIn['static'] ? ctor : ctor.prototype) : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === 'access' ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn.access[p];
    context.addInitializer = function (f) {
      if (done) throw new TypeError('Cannot add initializers after decoration has completed');
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === 'accessor' ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === 'accessor') {
      if (result === void 0) continue;
      if (result === null || typeof result !== 'object') throw new TypeError('Object expected');
      if ((_ = accept(result.get))) descriptor.get = _;
      if ((_ = accept(result.set))) descriptor.set = _;
      if ((_ = accept(result.init))) initializers.unshift(_);
    } else if ((_ = accept(result))) {
      if (kind === 'field') initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
var __runInitializers = function (thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
};

/** A running record whose heartbeat stopped this long ago is treated as gone. */
const STALE_MS = 15000;
/** A finished record stays visible this long, so the bar can show how it ended. */
const KEEP_MS = 60000;
/** The host rewrites a session's projection file while the session is working. */
const SESSION_FRESH_MS = 120000;
/** Background jobs are kept in memory; bound the map so a long uptime cannot grow it. */
const JOB_ROWS_MAX = 200;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `done/total` from a session's todo list, whatever shape it was written in. */
function todoProgress(todos) {
  const items = Array.isArray(todos) ? todos : Array.isArray(todos?.items) ? todos.items : null;
  if (items === null || items.length === 0) return { done: 0, total: 0 };
  let done = 0;
  for (const item of items) {
    const status = typeof item?.status === 'string' ? item.status : '';
    if (status === 'completed' || status === 'done' || item?.done === true) done += 1;
  }
  return { done, total: items.length };
}

/** A percentage a producer published as a bare line ("3/10 files", "42%"). */
function percentFromJob(row) {
  const text = (row.progress || row.detail || '').trim();
  if (text.length === 0) return null;
  const percent = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
  if (percent !== null) return Math.max(0, Math.min(100, Number(percent[1])));
  const ratio = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(text);
  if (ratio !== null) {
    const value = Number(ratio[1]);
    const total = Number(ratio[2]);
    if (total > 0) return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  }
  return null;
}

const AgentProgressService = (() => {
  const _classSuper = TypertRemoteService;
  const _instanceExtraInitializers = [];
  let _state_decorators;
  return class AgentProgressService extends _classSuper {
    static {
      _state_decorators = [Remote('state')];
      __esDecorate(this, null, _state_decorators, {
        kind: 'method',
        name: 'state',
        static: false,
        private: false,
        access: { has: (obj) => 'state' in obj, get: (obj) => obj.state },
        metadata: undefined
      }, null, _instanceExtraInitializers);
    }

    constructor(ctx, config = {}) {
      super(ctx, 'agentProgress');
      __runInitializers(this, _instanceExtraInitializers);
      this.root = typeof config.dir === 'string' && config.dir.length > 0 ? config.dir : dshHomePath('agent-progress');
      this.sessionsRoot = dshHomePath('storages', 'session_projcache', 'sessions');
      this.ctx = ctx;
      this.jobs = undefined;
      this.jobRows = new Map();
      // Background jobs (`job_list` work, subagents, long commands) keep running
      // while the turn is idle, so the projection scan cannot see them. The job
      // registry does, through one process-wide event stream: every session's
      // registration, progress and settlement lands here.
      this.subscribeJobs();
      ctx.logger?.info?.('dsh-agent-progress: mounted, records root ' + this.root);
    }

    /** Look the optional `jobs` service up again; it may load after this plugin. */
    jobsService() {
      if (this.jobs !== undefined) return this.jobs;
      try {
        this.jobs = typeof this.ctx?.get === 'function' ? this.ctx.get('jobs') : undefined;
      } catch {
        this.jobs = undefined;
      }
      return this.jobs;
    }

    subscribeJobs() {
      if (this.jobsSubscribed === true) return;
      const jobs = this.jobsService();
      if (jobs === undefined || typeof jobs.events?.subscribe !== 'function') return;
      try {
        jobs.events.subscribe({}, (event) => this.absorbJobEvent(event));
        this.jobsSubscribed = true;
      } catch (error) {
        this.ctx?.logger?.warn?.('dsh-agent-progress: job stream unavailable: ' + String(error));
      }
    }

    absorbJobEvent(event) {
      if (event === null || typeof event !== 'object') return;
      if (event.type === 'removed') {
        if (event.job !== null && typeof event.job === 'object') this.jobRows.delete(event.job.id);
        return;
      }
      this.absorbJob(event.job);
    }

    /** Keep the narrow projection the bar needs; never retain owner contexts. */
    absorbJob(job) {
      if (job === null || typeof job !== 'object') return;
      const id = typeof job.id === 'string' ? job.id : '';
      if (id.length === 0) return;
      const ownerId = typeof job.owner?.id === 'string' ? job.owner.id : undefined;
      this.jobRows.set(id, {
        id,
        kind: typeof job.kind === 'string' ? job.kind : '',
        label: typeof job.label === 'string' ? job.label : '',
        status: typeof job.status === 'string' ? job.status : 'running',
        progress: typeof job.progress === 'string' ? job.progress : '',
        detail: typeof job.detail === 'string' ? job.detail : '',
        startedAt: finite(job.startedAt) ?? Date.now(),
        finishedAt: finite(job.finishedAt),
        ownerId,
        updatedAt: Date.now()
      });
      if (this.jobRows.size > JOB_ROWS_MAX) {
        const oldest = [...this.jobRows.values()]
          .filter((row) => row.status !== 'running')
          .sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (oldest !== undefined) this.jobRows.delete(oldest.id);
      }
    }

    /** Seed jobs that were registered before this plugin subscribed (and unowned ones). */
    seedJobs(sessionIds) {
      const jobs = this.jobsService();
      if (jobs === undefined || typeof jobs.list !== 'function') return;
      const callers = [...sessionIds, undefined];
      for (const caller of callers) {
        let views = [];
        try {
          views = caller === undefined ? jobs.list() : jobs.list(caller);
        } catch {
          views = [];
        }
        if (!Array.isArray(views)) continue;
        for (const view of views) this.absorbJob(view);
      }
    }

    /** Rows for every running (or just-settled) background job, across sessions. */
    jobState(now, currentSessionId) {
      const out = [];
      const settledKeep = KEEP_MS;
      for (const row of this.jobRows.values()) {
        const running = row.status === 'running' || row.status === 'stopping';
        if (!running && now - (row.finishedAt ?? row.updatedAt) > settledKeep) continue;
        let percent = percentFromJob(row);
        // A producer that publishes no counter still deserves a determinate bar:
        // the estimate grows with elapsed time and never claims completion.
        if (percent === null && running) {
          const elapsed = Math.max(0, now - row.startedAt);
          percent = Math.min(95, Math.round(100 * (1 - Math.exp(-elapsed / 120000))));
        }
        out.push({
          key: 'job:' + row.id,
          label: (row.label.length > 0 ? row.label : row.kind.length > 0 ? row.kind : '后台任务').slice(0, 48),
          status: running ? 'running' : row.status === 'failed' || row.status === 'killed' ? 'failed' : 'done',
          phase: running ? row.progress || row.detail || '运行中' : row.detail || (row.kind.length > 0 ? row.kind : '已结束'),
          percent,
          done: 0,
          total: 0,
          unit: '',
          speed: 0,
          eta: null,
          note: '后台任务 · ' + (row.kind.length > 0 ? row.kind : 'job'),
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          updatedAt: row.updatedAt,
          auto: true,
          job: true,
          foreign: row.ownerId !== undefined && row.ownerId !== currentSessionId,
          sessionId: row.ownerId ?? currentSessionId
        });
      }
      return out;
    }

    /**
     * `/api` endpoint `agentProgress/state` → this session's rows, plus (when
     * `global` is set) whatever is running in any other session, so every
     * conversation shows the same live task list.
     */
    async state(request) {
      const now = Date.now();
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
      if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) {
        return { sessionId: null, now, tasks: [] };
      }
      if (request?.probe !== undefined && request?.probe !== null) this.lastProbe = request.probe;
      const own = this.read(sessionId, now);
      if (request?.global !== true) return { sessionId, now, tasks: own };

      const seen = new Set(own.map((task) => task.key));
      const foreign = [];
      for (const dirent of readDir(this.root)) {
        if (!dirent.isDirectory()) continue;
        const other = dirent.name;
        if (other === sessionId || !/^[A-Za-z0-9._-]+$/.test(other) || other.includes('..')) continue;
        for (const task of this.read(other, now)) {
          if (seen.has(task.key)) continue;
          seen.add(task.key);
          foreign.push({ ...task, foreign: true, sessionId: other });
        }
      }
      const tasks = [...own, ...foreign];
      // Sessions that write no record still show up: any conversation the host is
      // mid-step on is discovered from its projection file.
      const covered = new Set(
        tasks.filter((task) => task.status === 'running').map((task) => task.sessionId ?? sessionId)
      );
      const auto = this.scanSessions(now, covered);
      // Pick up jobs registered before the stream was attached, including the
      // ones belonging to the busy sessions just discovered.
      this.subscribeJobs();
      this.seedJobs([sessionId, ...auto.map((task) => task.sessionId).filter((id) => typeof id === 'string')]);
      const jobs = this.jobState(now, sessionId);
      const jobSessions = new Set(jobs.map((task) => task.sessionId).filter((id) => typeof id === 'string'));
      const merged = [...jobs, ...tasks, ...auto.filter((task) => !jobSessions.has(task.sessionId))]
        .sort((left, right) => {
          const rank = (task) => {
            if (task.status !== 'running') return 3;
            if (task.job === true) return 0;
            return task.auto === true ? 2 : 1;
          };
          if (rank(left) !== rank(right)) return rank(left) - rank(right);
          return right.updatedAt - left.updatedAt;
        })
        .slice(0, 12);
      this.writeStatus(sessionId, merged);
      return { sessionId, now, tasks: merged };
    }

    /** Best-effort self-check file so the host half's view can be inspected offline. */
    writeStatus(sessionId, merged) {
      const stamp = Date.now();
      try {
        if (stamp - (this.statusAt ?? 0) < 1000) return;
        this.statusAt = stamp;
      } catch {
        return;
      }
      try {
        fs.writeFileSync(
          path.join(this.root, '.host-status.json'),
          JSON.stringify({
            at: stamp,
            sessionId,
            jobsSubscribed: this.jobsSubscribed === true,
            jobsService: this.jobs !== undefined,
            jobRows: this.jobRows.size,
            rows: merged.length,
            keys: merged.slice(0, 6).map((task) => task.key),
            probe: this.lastProbe ?? null
          })
        );
      } catch {
        /* status is diagnostic only */
      }
    }

    /**
     * Live sessions, discovered from `<home>/storages/session_projcache`. A
     * session counts as busy while `sessionStats.openStep` is set and the host
     * has rewritten the file recently; the row carries the conversation title,
     * its project directory and the current turn/step number.
     */
    scanSessions(now, covered) {
      const out = [];
      for (const dirent of readDir(this.sessionsRoot)) {
        if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
        const file = path.join(this.sessionsRoot, dirent.name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (now - stat.mtimeMs > SESSION_FRESH_MS) continue;
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue;
        }
        const rows = parsed?.record?.rows;
        if (rows === null || typeof rows !== 'object') continue;
        const val = (name) => (rows[name] !== null && typeof rows[name] === 'object' ? rows[name].val : undefined);
        const stats = val('sessionStats');
        const openStep = stats?.openStep;
        if (openStep === null || typeof openStep !== 'object') continue;
        const id = String(val('costUsage')?.sessionId ?? dirent.name.replace(/\.json$/, ''));
        if (covered.has(id)) continue;
        const cwd = typeof parsed?.record?.identity?.cwd === 'string' ? parsed.record.identity.cwd : '';
        const rawTitle = typeof val('title') === 'string' ? val('title').replace(/^\s*工作目录：.*?任务：/, '').trim() : '';
        const label = rawTitle.length > 0 ? rawTitle.slice(0, 48) : cwd.length > 0 ? path.basename(cwd) : id.slice(0, 12);
        const todos = todoProgress(val('todos'));
        const turn = finite(openStep.turn);
        const step = finite(openStep.step);
        const startedAt = finite(openStep.startTime) ?? now;
        const phase = turn !== undefined && step !== undefined ? '第 ' + turn + ' 轮 · 第 ' + step + ' 步' : '进行中';
        // A real denominator is better than an estimate: a todo list gives
        // done/total, otherwise the session's own average turn duration gives a
        // percentage that advances with the work instead of an endless animation.
        const turns = finite(stats.turns) ?? 0;
        const averageTurnMs = turns > 0 ? ((finite(stats.llmMs) ?? 0) + (finite(stats.toolMs) ?? 0)) / turns : 0;
        const averageSteps = turns > 0 ? (finite(stats.steps) ?? 0) / turns : 0;
        const elapsed = Math.max(0, now - startedAt);
        let percent = todos.total > 0 ? Math.round((todos.done / todos.total) * 100) : null;
        if (percent === null && (averageTurnMs >= 10000 || averageSteps >= 1)) {
          const byTime = averageTurnMs > 0 ? (elapsed / averageTurnMs) * 100 : 0;
          const byStep = step !== undefined && averageSteps >= 1 ? (step / averageSteps) * 100 : 0;
          percent = Math.min(99, Math.max(1, Math.round(Math.max(byTime, byStep))));
        }
        out.push({
          key: 'session:' + id,
          label,
          status: 'running',
          phase,
          step,
          percent,
          done: todos.done,
          total: todos.total,
          unit: todos.total > 0 ? '项' : 'count',
          speed: 0,
          eta: percent !== null && percent > 0 && averageTurnMs > 0 ? Math.round((averageTurnMs - elapsed) / 1000) : null,
          note: cwd,
          project: cwd,
          startedAt,
          updatedAt: now,
          auto: true,
          foreign: true,
          sessionId: id
        });
      }
      return out;
    }

    read(sessionId, now) {
      const dir = path.join(this.root, sessionId);
      const out = [];
      for (const dirent of readDir(dir)) {
        if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
        let record;
        try {
          record = JSON.parse(fs.readFileSync(path.join(dir, dirent.name), 'utf8'));
        } catch {
          continue;
        }
        if (record === null || typeof record !== 'object') continue;
        const status = typeof record.status === 'string' ? record.status : 'running';
        const updatedAt = finite(record.updatedAt) ?? finite(record.startedAt) ?? 0;
        const finishedAt = finite(record.finishedAt);
        const stale = now - updatedAt > STALE_MS;
        if (status === 'running' && stale) continue;
        if (status !== 'running' && now - (finishedAt ?? updatedAt) > KEEP_MS) continue;
        out.push({
          key: typeof record.key === 'string' && record.key.length > 0 ? record.key : dirent.name.replace(/\.json$/, ''),
          label: typeof record.label === 'string' && record.label.length > 0 ? record.label : '',
          status,
          phase: typeof record.phase === 'string' ? record.phase : '',
          done: finite(record.done) ?? 0,
          total: finite(record.total) ?? 0,
          unit: typeof record.unit === 'string' && record.unit.length > 0 ? record.unit : 'count',
          speed: finite(record.speed) ?? 0,
          eta: finite(record.eta) ?? null,
          note: typeof record.note === 'string' ? record.note : '',
          startedAt: finite(record.startedAt) ?? updatedAt,
          updatedAt,
          finishedAt
        });
      }
      out.sort((left, right) => {
        const live = (task) => (task.status === 'running' ? 0 : 1);
        if (live(left) !== live(right)) return live(left) - live(right);
        return right.updatedAt - left.updatedAt;
      });
      return out;
    }
  };
})();

export { AgentProgressService, AgentProgressService as default };
