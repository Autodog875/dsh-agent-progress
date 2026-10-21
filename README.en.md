# dsh-agent-progress

A persistent, flat progress bar for the **DeepSeek Harness** web GUI: what the current conversation is doing, which step it is on, and how far the other conversations are.

No cartoon ball, no emoji, no spinner. One line, five colours, real numbers.

## Features

- **Always visible** — shows `无任务` (idle) when nothing is running.
- **Determinate** — percentage comes from a real `done/total`, from the session's todo list, or from that session's own average steps/turn and duration; it never runs an endless loading animation.
- **All conversations** — every session the host is mid-step on is discovered automatically, with title, project directory, `turn/step` and elapsed time.
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
  └─ scans <DSH_HOME>/storages/session_projcache/sessions/*.json
        openStep != null + file rewritten within 2 min  =>  session is working
```

## Tests

```bash
node test/preflight.mjs
node test/state-check.mjs
```

## Compatibility

DSH 0.2.x (desktop / web), Node.js ≥ 20 for the CLI. Peers: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-typert-protocol`.

## Limitations

- Sessions only appear while they are actually working; an idle session with a detached background job is invisible to the host and therefore to this plugin.
- Without a todo list or a `total`, the percentage is an estimate.
- Everything is read from local files under `<DSH_HOME>`; nothing is sent anywhere.

## License

MIT
