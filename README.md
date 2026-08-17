# mini-deepseek-harness

A compact, plugin-based agent harness in TypeScript. Every capability is a plugin on a
[CORDIS](https://www.npmjs.com/package/cordis) kernel, every interaction is an append-only
session event, and chat is just one projection of that log — with Trajectory replay, tools,
skills, subagents, workflows, MCP, and web search out of the box.

> 中文文档：[README.zh.md](README.zh.md) · Modeled after
> [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) ("Everything is a Plugin").

## Highlights

- **Plugin-first** — a `profile.yml` assembles plugins into a CORDIS context; new capabilities never touch the agent loop.
- **Event-sourced sessions** — the append-only `SessionEvent` log is the single source of truth; persistence, resume, crash recovery, and the UI all project from it.
- **Trajectory** — every turn, tool call, and subagent hand-off is replayable and inspectable in the web client.
- **LLM seam** — OpenAI-compatible adapter (DeepSeek by default; Ollama/vLLM endpoints work too), with streaming.
- **Tools & skills** — bash and file read/write/edit tools; a skill registry with filesystem discovery and the upstream `SKILL.md` frontmatter contract.
- **Subagents & workflows** — named spawn/fork providers and a script-orchestration engine, exposed as delegatable tools.
- **MCP & web search** — external MCP servers (stdio) register their tools into the same tool registry; web search ships fake + DeepSeek providers.
- **Web client first** — HTTP/WebSocket RPC bridge with session list, composer, streaming messages, tool cards, and trajectory panel.

## Quick Start

Requires Node.js ≥ 22.19.0 and pnpm 11.

```sh
pnpm install
pnpm test        # full test suite (Vitest, node + jsdom workspaces)
pnpm typecheck   # full type check
```

Representative demos. Everything except `demo:real` (and the browser `demo:web`) runs with
**zero API key**, against a scripted fake LLM:

```sh
pnpm demo:session          # event log persistence, resume, crash recovery
pnpm demo:agent            # the agent loop
pnpm demo:tools --clean    # fake LLM drives real tools (read → edit → summarize)
pnpm demo:subagent --clean # delegation round-trip + workflow orchestration
pnpm demo:mcp --clean      # external MCP server tool discovery
```

For a real model, put `DEEPSEEK_API_KEY` in `.env` (or the environment) and run
`pnpm demo:real --ask "..."`, or `pnpm demo:web --clean` to chat in the browser.

## Packages

| Package | Purpose |
|---|---|
| [`packages/kernel`](packages/kernel) | Launcher: loads a `profile.yml` into a CORDIS context |
| [`packages/session`](packages/session) | Event vocabulary + append-only log + `SessionPersistence` seam (JSONL backend) |
| [`packages/test-support`](packages/test-support) | Shared test vocabulary: test contexts, service injection, event assertions, fake LLM |
| [`packages/llm`](packages/llm) | LLM seam + OpenAI-compatible adapter (DeepSeek default; Ollama/vLLM compatible) |
| [`packages/agent`](packages/agent) | The single agent loop — input → model → output, every action logged |
| [`packages/tools`](packages/tools) | Tools seam (registry + execution pipeline) + bash / file read·write·edit |
| [`packages/web`](packages/web) | Host: RPC bridge seam over HTTP/WebSocket + session façade |
| [`packages/client`](packages/client) | Client slot seam + UI plugins (session list, composer, streaming, tool cards) |
| [`packages/skill`](packages/skill) | Skills seam (registry + filesystem discovery) + skill tool |
| [`packages/subagent`](packages/subagent) | Subagents seam (named provider registry) + spawn/fork providers + delegation tool |
| [`packages/workflow`](packages/workflow) | Workflow engine seam + workflow tool (model-authored orchestration scripts) |
| [`packages/mcp`](packages/mcp) | MCP client bridge (stdio): external server tools join the tool registry |
| [`packages/web-search`](packages/web-search) | Web-search seam (provider registry + runtime selection) + fake/DeepSeek providers |
| [`packages/bundle-web`](packages/bundle-web) | Web profile: client shell + UI plugins assembled into a browser app |
| [`apps/web`](apps/web) | Web client shell (Vite entry) |

## Documentation

- Requirements (MVP, backlog, milestones, seams): [`docs/requirements.md`](docs/requirements.md)
- Per-milestone specs: [`docs/milestones/`](docs/milestones/README.md)
- Step-by-step build notes for each milestone: [`docs/tutorials/`](docs/tutorials/README.md)
- The full version of this document, in Chinese: [README.zh.md](README.zh.md)

## Status

MVP (M0–M5) and M6–M10 are **complete**:

| Milestone | Delivered |
|---|---|
| M0 | Scaffolding + test-support + minimal CORDIS bootstrap |
| M1 | Session event vocabulary + JSONL persistence + resume + crash recovery |
| M2 | LLM seam + fake LLM + agent loop |
| M3 | Tools seam + bash/fs tools + tool-call loop |
| M4 | Web: RPC bridge + session list + composer + streaming + tool cards |
| M5 | Simplified Trajectory view + skills subsystem (incl. skill self-bootstrap) |
| M6 | All own-seam registrations reversible: registration-as-effect + HMR-safety tests |
| M7 | Upstream skill system ported: `SKILL.md` frontmatter contract + fail-closed validation |
| M8 | Subagents seam + spawn/fork providers + WorkflowEngine orchestration + delegation/orchestration tools |
| M9 | mcp-client bridge: stdio transport + two-phase sync + disconnect revokes registrations |
| M10 | Web search in three layers: capability seam + runtime selection + fake/deepseek providers + `web_search` tool |

**Backlog**

- CLI client
- Approval stack
- Parallel tool scheduling
- Trajectory v2
- SQLite
- goal·plan·todo
- LSP
- Compaction
- settings-i18n
- Telemetry
- Dynamic plugin hot-reloading

- Backlog details: [`docs/requirements.md` §6](docs/requirements.md)

## Development

- TDD: `pnpm test` and `pnpm typecheck` are the merge gates ([`.agents/skills/tdd/SKILL.md`](.agents/skills/tdd/SKILL.md)).
- Decisions and progress snapshots: [`.agents/notes/`](.agents/notes/README.md).
