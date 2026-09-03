# dsh-agent-hub · Group-Chat Multi-Agent Orchestration Console

> One group chat room = one autonomous AI collaboration team — decision, dispatch, verification, and iteration all happen in the room, visible and auditable.

**dsh-agent-hub** is an in-app plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that turns a chat room into a running collaboration workflow: put a goal in, get a deliverable out. A bundled backend ships with the plugin (auto-probe, auto-deps, silent windowless start) — zero external services, zero runtime npm dependencies.

## Highlights

- **Autonomous decision-making** — pick any member as the "orchestrator brain"; it runs round-based structured decisions (plan/dispatch/status/memory JSON) and keeps advancing round after round when "auto-approve continuous tasks" is on.
- **Multi-agent task dispatch** — `@member` mentions dispatch atomic SMART tasks to OpenAI-compatible API members (DeepSeek, Qwen, Kimi, GPT…), dependency-ordered, independent tasks in parallel.
- **Verification loop** — acceptance criteria checked per deliverable, judged by reproducibility; failures come back as one precise rework list; passing work is persisted to group memory.
- **Long-horizon iteration** — group memory survives across rounds and tasks, so the team learns; multi-round loops (requirements → design → build → integrate → verify → rework → ship) keep improving until the goal's definition-of-done is met.

## Install

```sh
dsh plugin --profile <profile> add dsh-agent-hub
```

Declares a `dsh.bundle` manifest — one command installs and auto-mounts.

## Quick start

1. Create a room.
2. **Invite a member** (side panel): fill `base_url / api_key / model` for an OpenAI-compatible API endpoint.
3. **Set the brain**: click "设为大脑" on a member.
4. **Send a goal**: "发给大脑" hands the whole requirement to the brain, which decomposes, dispatches, supervises, and verifies; or `@member` to dispatch directly.
5. Toggle "自动批准持续任务" to let the brain run rounds without per-round confirmation; you can always "叫停" or approve/reject a round.

See [README.md](README.md) (Chinese) for the full feature walkthrough and FAQ.
