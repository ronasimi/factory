# factory

Companion agent harness built over [`earendil-works/pi`](https://github.com/earendil-works/pi) (`v1.6.0`) and `@earendil-works/pi-durable`, with dual-model LFM3 routing (`llama-server --jinja` at `192.168.1.101:8080`) and a global SQLite-backed Self-Improvement Memory (SIM, arXiv:2611.18856).

## Quick Start

```bash
# Conflict-free install (isolated from stock `pi` binary and ~/.pi):
bash scripts/install.sh

# Or build a portable installer tarball:
npm run bundle
```

### Default Install Paths (No Stock `pi` Conflicts)

- Launcher binary: `~/.local/bin/factory` (`FACTORY_BIN_DIR`)
- Application bundle: `~/.local/share/factory` (`FACTORY_INSTALL_DIR`)
- SIM & factory state: `~/.factory` (`FACTORY_STATE_DIR`)
- Uninstall: `bash scripts/uninstall.sh` (add `--purge-state` to remove `~/.factory`)

## Configuration (Environment Variables)

- `FACTORY_LLAMA_URL` (default: `http://192.168.1.101:8080/v1`)
- `FACTORY_LLAMA_API_KEY` (falls back to `LLAMA_SERVER_API_KEY` or `~/.pi/agent/models.json` `providers.desktop.apiKey`)
- `FACTORY_ORCHESTRATOR_MODEL` (default: `lfm-aa1` placeholder)
- `FACTORY_SUBAGENT_MODEL` (default: `lfm-aa1`)
- `FACTORY_SIM_DB_PATH` (default: `~/.factory/sim.sqlite`)
- `FACTORY_SIM_IDLE_MS` (default: `300000` — 5 minutes)

## Bundled Addons & UI Plugins

- `pi-durable-subagents` — Persistent subagents routed to `Instance` (`lfm-aa1`, max 3 slots).
- `pi-web-access` — `web_search` and `fetch_content`.
- `@yorch/pi-statusbar` — Theme-aware footer status bar.
- `@nbafrank/pi-tks` — Live TPS + TTFT meter for local models.

## Commands

- `/factory-slots` — Inspect `Singleton` (1 slot) and `Instance` (3 slots) concurrency usage.
- `/factory-triage <snippet>` — Triage an error log or diff using `Instance`.
- `/sim [status|reflect]` — Inspect global SIM stats or trigger reflection + micro-evals manually.
