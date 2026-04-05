# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Runtime abstraction, network/proxy checks |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/debug-discord` | Debug Discord integration issues — thread routing, channel registration, message delivery |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npx vitest run       # Run all tests
./container/build.sh # Rebuild agent container
```

### Testing Requirements

Every implementation change MUST include tests. Run `npx vitest run` after changes to verify.

- **Unit tests**: Add to the corresponding `*.test.ts` file next to the source (e.g., `group-queue.ts` → `group-queue.test.ts`). Test edge cases, not just the happy path.
- **Integration tests**: For cross-module behavior or end-to-end scenarios, create a `*-integration.test.ts` file (e.g., `thread-integration.test.ts`). These wire up real modules (DB, GroupQueue) together to replay user scenarios and prevent regressions.
- **Test patterns**: Use `vi.useFakeTimers()` for async/timer-based code. Use `_initTestDatabase()` from `db.ts` for in-memory SQLite. Use `vi.fn()` completion callbacks for controlled async flow. See existing tests for examples.
- **Build check**: Always run `npm run build` after changes to catch type errors.
- The 1 pre-existing failure in `container-runtime.test.ts` (requires copilot-api proxy) is expected in dev environments.

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
sudo systemctl start nanoclaw
sudo systemctl stop nanoclaw
sudo systemctl restart nanoclaw
```

## Logging

In production (systemd), logs write to `data/nanoclaw.log` (JSON format, no sudo needed).
In dev (`npm run dev`), logs go to the console via pino-pretty.

```bash
tail -f data/nanoclaw.log                     # raw JSON
tail -f data/nanoclaw.log | npx pino-pretty   # human-readable
```

## Network Isolation

Agent containers run on an isolated Docker network (`nanoclaw-net`) with no host access.
The only service reachable from inside an agent container is the `copilot-api` proxy.

```
┌─────────────────────────────────────┐
│           nanoclaw-net              │
│  ┌──────────────────┐  ┌──────────┐ │
│  │ agent container   │→ │copilot-  │ │
│  │ (no host access)  │  │api :4141 │ │
│  └──────────────────┘  └──────────┘ │
└─────────────────────────────────────┘
```

### Systemd services (all system-level, in `/etc/systemd/system/`)

| Service | What it runs | Purpose |
|---------|-------------|---------|
| `nanoclaw.service` | `node dist/index.js` | The bot. Depends on `copilot-api.service` + `docker.service` |
| `copilot-api.service` | Docker container `copilot-api` on `nanoclaw-net` | API proxy for agent containers. Builds image from `~/git/copilot-api`, mounts `copilot-data/` volume |
| `host-copilot-api.service` | `bun run ./src/main.ts start` (bare process) | API proxy on localhost for host-side use (Claude Code, etc.). Independent of nanoclaw |

Boot order: `docker.service` → `copilot-api.service` (network + container) → `nanoclaw.service`

### Key env vars (`.env` and `data/env/env`)

- `ANTHROPIC_BASE_URL=http://copilot-api:4141` — agents resolve via Docker DNS on `nanoclaw-net`
- Host-side tools use `http://localhost:4141` from the bare `host-copilot-api` process

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
