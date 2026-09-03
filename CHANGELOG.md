# Changelog

## v0.1.5 (2026-08-24)
- docs: comprehensive README (features, architecture, install, usage, FAQ).

## v0.1.4 (2026-08-22)
- **fully windowless backend**: uvicorn now runs via `pythonw.exe` + `CREATE_NO_WINDOW` — no CMD window can ever appear (also kills leftover visible processes).
- host spawns `start.py` with `pythonw` on Windows.

## v0.1.3
- host: prefer `pythonw.exe` when resolving the Python interpreter (Windows).

## v0.1.2
- host: backend startup probe retry raised to ~90s (covers first-run venv + dependency install).
- `start.py`: self-detaches into a windowless background process; venv/pip subprocesses get `CREATE_NO_WINDOW`.

## v0.1.1
- **`dsh.bundle` manifest** (`cordis.patch.yml` ships in the package) → `dsh plugin add dsh-agent-hub` installs and auto-mounts in one command.

## v0.1.0 (2026-08-21)
- First public release: group-chat multi-agent orchestration console for DSH.
- Autonomous decision-making (orchestrator brain + round-based JSON decisions + auto-approve continuous tasks).
- `@member` task dispatch, atomic SMART task decomposition, parallel execution.
- Verification loop (reproducible acceptance, one-shot rework lists) and group memory across rounds/tasks.
- Bundled backend (auto venv + deps + start, zero runtime npm dependencies); OpenAI-compatible API members.
