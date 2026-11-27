# factory

Companion agent harness built over [`earendil-works/pi`](https://github.com/earendil-works/pi) (`v1.6.0`) and `@earendil-works/pi-durable`, with dual-model LFM3 routing (`llama-server --jinja` at `192.168.1.101:8080`) and a global SQLite-backed Self-Improvement Memory (SIM, arXiv:2611.18856).

## Quick Start

```bash
npm install
npm run build
npm test
node ./dist/bin/factory.js --list-models factory-llama
```

## Configuration (Environment Variables)

- `FACTORY_LLAMA_URL` (default: `http://192.168.1.101:8080/v1`)
- `FACTORY_LLAMA_API_KEY` (falls back to `LLAMA_SERVER_API_KEY` or `~/.pi/agent/models.json` `providers.desktop.apiKey`)
- `FACTORY_ORCHESTRATOR_MODEL` (default: `lfm-aa1` placeholder)
- `FACTORY_SUBAGENT_MODEL` (default: `lfm-aa1`)
- `FACTORY_SIM_DB_PATH` (default: `~/.pi/factory/sim.sqlite`)
- `FACTORY_SIM_IDLE_MS` (default: `300000` — 5 minutes)

## Commands

- `/factory-slots` — Inspect `Singleton` (1 slot) and `Instance` (3 slots) concurrency usage.
- `/factory-triage <snippet>` — Triage an error log or diff using `Instance`.
- `/sim [status|reflect]` — Inspect global SIM stats or trigger reflection + micro-evals manually.
