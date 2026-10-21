/**
 * dsh-agent-progress — web half.
 *
 * A draggable, collapsible task strip. Collapsed it is one line: dot, task
 * name, percent and a flat track. Expanded it lists every task in the session,
 * each with its own progress track and detail line.
 *
 * Palette is restricted to the five colours the user supplied — no invented
 * dark panel, no black shadow:
 *   #21467A (studio blue)  #C71F2D (danger red)  #D45814 (persian orange)
 *   #DBA972 (autumn gold)  #f4f5f7 (white)
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-progress',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const POLL_ACTIVE_MS = 800;
    const POLL_IDLE_MS = 4000;
    /** A finished row stays on screen this long after it finished. */
    const DONE_LINGER_MS = 6000;
    /** A brand-new row is kept out of the overall average for this long, so the number does not lurch. */
    const FADE_MS = 2000;
    const STYLE_ID = 'dsh-agent-progress-style';
    const POS_KEY = 'dsh-agent-progress:pos';
    const OPEN_KEY = 'dsh-agent-progress:expanded';

    const BLUE = '#21467A';
    const RED = '#C71F2D';
    const ORANGE = '#D45814';
    const GOLD = '#DBA972';
    const WHITE = '#f4f5f7';

    let connection = null;

    const CSS = `
    .ap-root{position:fixed;z-index:70;pointer-events:auto;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    .ap-card{pointer-events:auto;background:${WHITE};border:1px solid ${BLUE};border-radius:8px;padding:8px 10px;color:${BLUE};cursor:grab;user-select:none;touch-action:none}
    .ap-card.ap-dragging{cursor:grabbing}
    .ap-line{display:flex;align-items:center;gap:8px}
    .ap-dot{width:6px;height:6px;border-radius:1px;flex:none;background:${ORANGE}}
    .ap-dot.ap-idle{background:${GOLD}}
    .ap-dot.ap-done{background:${GOLD}}
    .ap-dot.ap-failed{background:${RED}}
    .ap-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.1px}
    .ap-meta{flex:none;color:${BLUE};font-variant-numeric:tabular-nums;white-space:nowrap}
    .ap-toggle{flex:none;background:none;border:0;padding:0 2px;margin:0;color:${BLUE};font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
    .ap-toggle:focus-visible{outline:1px solid ${BLUE};outline-offset:2px}
    .ap-track{position:relative;margin-top:7px;height:4px;border-radius:2px;background:${GOLD};overflow:hidden}
    .ap-fill{position:absolute;inset:0 auto 0 0;border-radius:2px;background:${BLUE};transition:width .3s ease}
    .ap-fill.ap-failed{background:${RED}}
    .ap-list{margin-top:8px;border-top:1px solid ${GOLD};padding-top:2px}
    .ap-item{padding:6px 0 2px;border-bottom:1px solid ${GOLD}}
    .ap-item:last-child{border-bottom:0;padding-bottom:0}
    .ap-note{margin-top:4px;color:${BLUE};font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    `;

    function injectStyles() {
      try {
        if (document.getElementById(STYLE_ID) !== null) return () => {};
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          try {
            style.remove();
          } catch {
            /* page teardown */
          }
        };
      } catch {
        return () => {};
      }
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const total = Math.round(ms / 1000);
      if (total < 60) return total + ' 秒';
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes < 60) return seconds === 0 ? minutes + ' 分' : minutes + ' 分 ' + seconds + ' 秒';
      const hours = Math.floor(minutes / 60);
      return hours + ' 时 ' + (minutes % 60) + ' 分';
    }

    /** Compact description of what sits under the pointer, sent with the next poll. */
    function describeHit(event) {
      const out = { x: event.clientX, y: event.clientY };
      try {
        const top = document.elementFromPoint(event.clientX, event.clientY);
        if (top !== null) {
          out.top = top.tagName + '.' + String(top.className ?? '').slice(0, 60);
        }
        const target = event.target;
        if (target !== null && target !== undefined) {
          out.target = String(target.tagName ?? '') + '.' + String(target.className ?? '').slice(0, 60);
        }
      } catch {
        /* no DOM */
      }
      return out;
    }

    async function pull(sessionId, probe) {
      if (connection === null || typeof sessionId !== 'string' || sessionId.length === 0) return null;
      try {
        const request = { sessionId, global: true };
        if (probe !== null && probe !== undefined) request.probe = probe;
        const result = await connection.rpc.call('/api', 'agentProgress/state', {
          args: { request }
        });
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        return null;
      } catch {
        return null;
      }
    }

    /** Pick the row worth showing: the newest running one, else a just-finished one. */
    function pick(tasks, now) {
      if (!Array.isArray(tasks) || tasks.length === 0) return null;
      const running = tasks.filter((task) => task.status === 'running');
      if (running.length > 0) return running[0];
      const settled = tasks.filter((task) => endedAt(task, now));
      return settled.length > 0 ? settled[0] : null;
    }

    function endedAt(task) {
      return typeof task.finishedAt === 'number' ? task.finishedAt : task.updatedAt;
    }

    function isFreshEnd(task, now) {
      const ended = endedAt(task);
      return typeof ended === 'number' && now - ended < DONE_LINGER_MS;
    }

    function rowsFor(tasks, now) {
      const running = tasks.filter((task) => task.status === 'running');
      const finished = tasks.filter((task) => task.status !== 'running' && isFreshEnd(task, now));
      return [...running, ...finished];
    }

    function percentOf(task) {
      const explicit = Number(task.percent);
      if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, Math.round(explicit)));
      const total = Number(task.total) || 0;
      if (total <= 0) return null;
      const done = Number(task.done) || 0;
      return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    }

    /**
     * Collapse every running row into one "overall" reading for the collapsed bar.
     * Weighted by `total` when a row has one (a 500-file download counts far more
     * than a 3-step task), otherwise one unit each. Failed rows never pull the
     * average down; they only show up in the counters.
     */
    function aggregate(rows, now) {
      const running = rows.filter((task) => task.status === 'running');
      const settled = rows.filter((task) => task.status !== 'running' && isFreshEnd(task, now));
      const done = settled.filter((task) => task.status !== 'failed').length;
      const failed = settled.filter((task) => task.status === 'failed').length;
      if (running.length === 0) return null;
      const settledIn = running.filter((task) => {
        const startedAt = Number(task.startedAt);
        return !Number.isFinite(startedAt) || startedAt <= 0 || now - startedAt >= FADE_MS;
      });
      const counted = settledIn.length > 0 ? settledIn : running;
      let weight = 0;
      let sum = 0;
      for (const task of counted) {
        const pct = percentOf(task);
        const w = Number(task.total) > 0 ? Number(task.total) : 1;
        weight += w;
        sum += (pct === null ? 0 : pct) * w;
      }
      const percent = weight > 0 ? Math.max(0, Math.min(100, Math.round(sum / weight))) : null;
      return { count: running.length, counted: counted.length, percent, done, failed };
    }

    function metaOf(task, now) {
      const total = Number(task.total) || 0;
      const done = Number(task.done) || 0;
      const running = task.status === 'running';
      const pct = percentOf(task);
      const parts = [];
      if (pct !== null) parts.push(pct + '%');
      if (total > 0) parts.push(done + '/' + total + (typeof task.unit === 'string' ? ' ' + task.unit : ''));
      if (total <= 0 && running && Number.isFinite(Number(task.step))) parts.push('第 ' + Number(task.step) + ' 步');
      if (running && Number(task.eta) > 0) parts.push('剩 ' + formatDuration(Number(task.eta) * 1000));
      if (!running) parts.push(task.status === 'failed' ? '失败' : '完成');
      return parts.join(' · ');
    }

    /** Last path segment, used to name the project an auto-discovered session belongs to. */
    function projectName(project) {
      if (typeof project !== 'string' || project.length === 0) return '';
      const segments = project.split(/[\\/]/).filter((part) => part.length > 0);
      return segments.length > 0 ? segments[segments.length - 1] : '';
    }

    function noteOf(task) {
      const parts = [];
      const project = projectName(task.project);
      if (project.length > 0) parts.push(project);
      if (task.foreign === true) parts.push('其他会话');
      if (typeof task.phase === 'string' && task.phase.length > 0) parts.push(task.phase);
      const speed = Number(task.speed);
      if (Number.isFinite(speed) && speed > 0) {
        const unit = typeof task.unit === 'string' && task.unit.length > 0 ? task.unit : '项';
        parts.push(speed.toFixed(2) + ' ' + unit + '/秒');
      }
      const startedAt = Number(task.startedAt);
      if (task.status === 'running' && Number.isFinite(startedAt) && startedAt > 0) {
        parts.push('已用 ' + formatDuration(Math.max(0, Date.now() - startedAt)));
      }
      return parts.join(' · ');
    }

    function statusClass(status) {
      if (status === 'failed') return ' ap-failed';
      if (status === 'done') return ' ap-done';
      return '';
    }

    function Track(props) {
      const explicit = props.percent;
      const pct = typeof explicit === 'number' && Number.isFinite(explicit) ? Math.max(0, Math.min(100, Math.round(explicit))) : percentOf(props.task);
      const cls = 'ap-fill' + statusClass(props.task.status);
      return h('div', { className: 'ap-track' },
        h('div', { className: cls, style: { width: (pct === null ? 0 : pct) + '%' } })
      );
    }

    function readPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (raw === null) return null;
        const value = JSON.parse(raw);
        if (value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y)) {
          return { x: Math.round(value.x), y: Math.round(value.y) };
        }
        return null;
      } catch {
        return null;
      }
    }

    function savePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        /* storage unavailable */
      }
    }

    function readExpanded() {
      try {
        return window.localStorage.getItem(OPEN_KEY) === '1';
      } catch {
        return false;
      }
    }

    function saveExpanded(open) {
      try {
        window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
    }

    function AgentProgressBar(props) {
      const sessionId = props.sessionId;
      const [tasks, setTasks] = React.useState([]);
      const [now, setNow] = React.useState(() => Date.now());
      const [pos, setPos] = React.useState(readPos);
      const [expanded, setExpanded] = React.useState(readExpanded);
      const [dragging, setDragging] = React.useState(false);
      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const probeRef = React.useRef(null);
      const handlersRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          const value = await pull(sessionId, probeRef.current);
          if (!alive) return;
          const next = value !== null && Array.isArray(value.tasks) ? value.tasks : [];
          setTasks(next);
          const active = next.some((task) => task.status === 'running');
          timer = setTimeout(tick, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        };
        tick();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [sessionId]);

      React.useEffect(() => {
        if (tasks.length === 0) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [tasks.length]);

      const primary = pick(tasks, now);
      const idle = primary === null;

      const rows = rowsFor(tasks, now);

      const clamp = (next) => {
        const element = rootRef.current;
        const width = element !== null ? element.offsetWidth : 420;
        const height = element !== null ? element.offsetHeight : 60;
        const maxX = Math.max(8, window.innerWidth - width - 8);
        const maxY = Math.max(8, window.innerHeight - height - 8);
        return {
          x: Math.min(Math.max(8, next.x), maxX),
          y: Math.min(Math.max(8, next.y), maxY)
        };
      };

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        try {
          if (target !== null && typeof target.closest === 'function' && target.closest('[data-ap-nodrag]') !== null) return;
        } catch {
          /* detached node */
        }
        const element = rootRef.current;
        if (element === null) return;
        probeRef.current = describeHit(event);
        const rect = element.getBoundingClientRect();
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        setPos(clamp({ x: rect.left, y: rect.top }));
        setDragging(true);
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          /* pointer capture unsupported */
        }
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        setPos(clamp({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }));
      };

      const endDrag = (event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        dragRef.current = null;
        setDragging(false);
        const element = rootRef.current;
        if (element !== null) {
          const rect = element.getBoundingClientRect();
          const next = clamp({ x: rect.left, y: rect.top });
          setPos(next);
          savePos(next);
        }
        try {
          if (element !== null && event.pointerId !== undefined) element.releasePointerCapture(event.pointerId);
        } catch {
          /* pointer capture unsupported */
        }
      };

      const toggle = () => {
        const next = !expanded;
        setExpanded(next);
        saveExpanded(next);
      };

      handlersRef.current = { onPointerDown, onPointerMove, endDrag, toggle };

      /**
       * Native listeners instead of React props: a plugin slot can be re-rendered
       * by the host in ways that drop synthetic handlers, and pointer capture must
       * survive those re-renders. The ref always points at the latest closures.
       */
      React.useEffect(() => {
        const element = rootRef.current;
        if (element === null) return undefined;
        const call = (name) => (event) => {
          const current = handlersRef.current;
          if (current !== null && typeof current[name] === 'function') current[name](event);
        };
        const down = call('onPointerDown');
        const move = call('onPointerMove');
        const up = call('endDrag');
        const click = (event) => {
          const target = event.target;
          let hit = false;
          try {
            hit = target !== null && typeof target.closest === 'function' && target.closest('.ap-toggle') !== null;
          } catch {
            hit = false;
          }
          if (!hit) return;
          event.preventDefault();
          event.stopPropagation();
          const current = handlersRef.current;
          if (current !== null) current.toggle();
        };
        element.addEventListener('pointerdown', down);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        element.addEventListener('click', click, true);
        return () => {
          element.removeEventListener('pointerdown', down);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          element.removeEventListener('click', click, true);
        };
      }, []);

      const style = pos === null
        ? { left: '50%', top: 72, transform: 'translateX(-50%)', width: 'min(460px,calc(100vw - 48px))' }
        : { left: pos.x, top: pos.y, width: 'min(460px,calc(100vw - 48px))' };

      const primaryMeta = idle ? '空闲' : metaOf(primary, now);
      const inFlight = rows.filter((task) => task.status === 'running').length;
      const toggleVisible = rows.length > 0;

      /** Collapsed bar shows the aggregate when several tasks run at once. */
      const overall = aggregate(rows, now);
      const multi = overall !== null && overall.count > 1;
      const dotClass = idle
        ? ' ap-idle'
        : multi
          ? (overall.failed > 0 ? ' ap-failed' : '')
          : statusClass(primary.status);
      const labelText = idle
        ? '无任务'
        : multi
          ? '总进度 · ' + overall.count + ' 个任务'
          : String(primary.label ?? '执行中');
      const overallMeta = (() => {
        if (overall === null) return '';
        const parts = [];
        if (overall.percent !== null) parts.push(overall.percent + '%');
        if (overall.done > 0) parts.push('✓' + overall.done);
        if (overall.failed > 0) parts.push('✗' + overall.failed);
        return parts.join(' · ');
      })();
      const metaText = idle
        ? (rows.length > 0 ? '最近 ' + rows.length + ' 项已结束' : '空闲')
        : expanded
          ? (inFlight > 0 ? inFlight + ' 项进行中 · 共 ' + rows.length + ' 项' : '共 ' + rows.length + ' 项')
          : multi
            ? overallMeta
            : primaryMeta;

      return h('div', {
        className: 'ap-root',
        ref: rootRef,
        style,
        role: 'status',
        'aria-live': 'polite'
      },
        h('div', { className: 'ap-card' + (dragging ? ' ap-dragging' : '') },
          h('div', { className: 'ap-line' },
            h('span', { className: 'ap-dot' + dotClass }),
            h('span', { className: 'ap-label', title: idle ? '' : (multi ? labelText : String(primary.label ?? '')) }, labelText),
            h('span', { className: 'ap-meta' }, metaText),
            toggleVisible
              ? h('button', {
                className: 'ap-toggle',
                type: 'button',
                'data-ap-nodrag': 'true',
                'aria-expanded': expanded
              }, expanded ? '收起' : '展开')
              : null
          ),
          idle
            ? null
            : expanded
              ? h('div', { className: 'ap-list' },
                rows.map((task) => h('div', { className: 'ap-item', key: String(task.key ?? task.label) },
                  h('div', { className: 'ap-line' },
                    h('span', { className: 'ap-dot' + statusClass(task.status) }),
                    h('span', { className: 'ap-label', title: String(task.label ?? '') }, String(task.label ?? '')),
                    h('span', { className: 'ap-meta' }, metaOf(task, now))
                  ),
                  h(Track, { task }),
                  noteOf(task).length > 0 ? h('div', { className: 'ap-note' }, noteOf(task)) : null
                ))
              )
              : h(Track, { task: primary, percent: multi ? overall.percent : undefined })
        )
      );
    }

    const inject = ['slots', 'connection', 'sessions'];

    function apply(ctx) {
      connection = ctx.connection ?? null;
      ctx.effect(() => injectStyles(), 'dsh-agent-progress: styles');
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'agent-progress',
        order: 22
      }, AgentProgressBar));
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Pure helpers, exported so the test file can exercise the maths without a DOM. */
    exports.__test = { aggregate, percentOf, rowsFor, isFreshEnd };
    return module.exports;
  }
});
