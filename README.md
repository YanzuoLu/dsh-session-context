# dsh-session-context

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that injects the contents of configured files into the main agent's context when a session starts, and injects them again whenever they are missing: after compaction removes them, or in a resumed session that never received them (for example one migrated from Claude Code or Codex). It is the dsh counterpart of a Claude Code `SessionStart` hook (matcher `startup|clear|compact`) whose stdout becomes additional context.

## Why

dsh has no hook that runs at session start and again after compaction while also skipping subagents. `dsh-hooks-claude-code` runs `SessionStart` only for `startup` and `resume`, and it requires JSON output. `dsh-agent-instructions` re-enters context after compaction, but it only discovers `AGENTS.md` files from the workspace. This plugin injects any files you list, only into the agents you choose.

## Behavior

Before each model step, the plugin checks whether its context message is still in the agent's model-visible history.

| Situation | Result |
| --- | --- |
| New session, including `/new` in dsh-tui | Injected before the first prompt (`startup`) |
| Compaction removed the message | Injected again at the next step (`compact`) |
| Resumed session that still has the message | Nothing injected, so no duplicate |
| Resumed session that never had the message, including one migrated with `dsh-tui migrate` | Injected at the next step (`resume`) |
| Subagent from `subagent` (spawn) or a workflow | Nothing injected |
| Subagent from `subagent_fork` | Inherits the parent's message. It gets a one-time notice telling it to ignore that message |

The files are read again on every injection, so edits apply without a restart. A missing file produces one warning and is skipped. Each injected message is persisted as a `user/message` with source `{ kind: "session-context", form: "instructions", trigger }`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `files` | `[]` | Absolute paths (`~/` allowed), joined in order. |
| `sources` | `[startup, resume, compact]` | Which of `startup`, `resume`, and `compact` inject. Drop `resume` to leave sessions that predate the plugin, or were migrated from another agent, without the context. |
| `rootOnly` | `true` | Skip subagents (sessions with `delegationDepth > 0`). |
| `template` | `<session-context>\n{content}\n</session-context>` | Wrapper text. `{content}` is replaced by the file contents. |
| `subagentNotice` | see `index.js` | Notice for forked subagents that inherited the message. Set it to `''` to disable. |

## Install

```sh
dsh plugin --profile <profile> add github:YanzuoLu/dsh-session-context   # or a local path
```

The bundle mounts the plugin at the profile root with no files. Add the files in the profile's own `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: session-context
  config:
    files:
      - ~/.claude/orchestrator.md
```

Check the result with `dsh --profile <profile> --dump-config`.

## Compatibility

This plugin needs dsh `^0.2.0-rc.2`. It uses the `agent/pre-step` waterfall from `@deepseek-ai/dsh-agent`, `Session.deriveMessages()`, and the session header's `delegationDepth`.

## License

MIT
