# dsh-agent-progress

A persistent, flat progress bar for the **DeepSeek Harness** web GUI: what the current conversation is doing, which step it is on, and how far the other conversations are.

No cartoon ball, no emoji, no spinner. One line, five colours, real numbers.

## Features

- **Always visible** — shows `无任务` (idle) when nothing is running.
- **Determinate** — percentage comes from a real `done/total`, from the session's todo list, or from that session's own average steps/turn and duration; it never runs an endless loading animation.
- **All conversations** — every session the host is mid-step on is discovered automatically, with title, project directory, `turn/step` and elapsed time.
- **Background jobs** — the host's `ctx.jobs` event stream is subscribed: background commands, subagents and long tasks appear the moment they register, across every conversation, and show how they ended.
- **Draggable & collapsible** — position and open state persist in `localStorage`.
- **Zero dependencies** — host half reads files, web half uses React plus the services the host already injects.

## Install

Install `dsh-agent-progress` from the DSH plugin market and enable it, then refresh the page.

For local development:

```bash
pnpm add "link:/path/to/dsh-agent-progress" --dir <DSH_HOME>/profiles/desktop
```

then toggle it on in the market (the market owns the `bundles` list).

## Report exact progress

```bash
node bin/ap.mjs set --key download --label "Download" --total 500 --done 0
node bin/ap.mjs set --key download --done 137 --speed 3.2 --eta 120
node bin/ap.mjs done --key download
node bin/ap.mjs fail --key download --note "sha256 mismatch"
node bin/ap.mjs hold --key download --seconds 600
node bin/ap.mjs clear
```

Records live in `<DSH_HOME>/agent-progress/<sessionId>/<key>.json` and are mirrored to every session folder by default (`--local` disables that). A `running` record needs a heartbeat every 15 s.

## How it works

```
web (lib/client.js)  → slot conversation.session.header.actions
                     → rpc /api agentProgress/state { sessionId, global: true }

host (lib/index.js)  AgentProgressService
  ├─ reads <DSH_HOME>/agent-progress/<sessionId>/*.json
  ├─ subscribes ctx.jobs.events (process-wide, every session)
  │     registered / progress / settled  =>  background-job rows
  └─ scans <DSH_HOME>/storages/session_projcache/sessions/*.json
        openStep != null + file rewritten within 2 min  =>  session is working
```

## Tests

```bash
node test/preflight.mjs
node test/state-check.mjs
node test/jobs-check.mjs
```

## Compatibility

DSH 0.2.x (desktop / web), Node.js ≥ 20 for the CLI. Peers: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-typert-protocol`.

## Limitations

- Background jobs are discovered from the host's in-process job registry: anything registered after the plugin loads is always visible, anything already running is picked up by the first poll through `jobs.list(sessionId)`. The registry itself does not survive a restart.
- Without a todo list, a `total`, or a producer-published progress line, the percentage is an estimate.
- Everything is read from local files under `<DSH_HOME>`; nothing is sent anywhere.

## License

MIT
