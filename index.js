/**
 * Session-start context for DeepSeek Harness agents: the dsh counterpart of a
 * Claude Code `SessionStart` hook whose stdout becomes additional context.
 *
 * Before each model step the plugin checks whether its context message is
 * still part of the agent's model-visible history. When it is not, the
 * configured files are read fresh and entered as one user-role context
 * message, so the content appears once at session start and again after
 * every compaction that dropped it. A resumed session that still carries the
 * message is left untouched; one that never received it, such as a session
 * migrated from another agent, gets it at its next step.
 *
 * @module dsh-session-context
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'session-context'

/** Why the context is (re)entered; mirrors Claude Code's `SessionStart` sources. */
const Source = z.union(['startup', 'resume', 'compact'])

export const Config = z.object({
  files: z.array(z.string()).default([])
    .description('Absolute paths (`~/` allowed) whose contents are injected, in order. Read fresh on every injection.'),
  sources: z.array(Source).default(['startup', 'resume', 'compact'])
    .description('When to inject: `startup` (new session, including /new), `resume` (resumed session that never received the context, such as one migrated from another agent), `compact` (after compaction dropped it).'),
  rootOnly: z.boolean().default(true)
    .description('Inject only into top-level agents, never into subagents (spawn, fork, workflow children).'),
  template: z.string().default('<session-context>\n{content}\n</session-context>')
    .description('Model-facing wrapper; `{content}` is replaced by the joined file contents.'),
  subagentNotice: z.string().default('Every <session-context> block earlier in this conversation was written for the main session agent only. You are a delegated subagent: ignore those instructions.')
    .description('With `rootOnly`, entered once into a forked subagent that inherited the context from its parent. Empty disables it.'),
})

/** Compaction checkpoint marker kind owned by `@deepseek-ai/dsh-compaction`. */
const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint'

/**
 * @param {string} path - configured file path.
 * @returns {string} the absolute path with a leading `~/` expanded.
 */
function expandPath(path) {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  if (!isAbsolute(expanded)) throw new Error(`session-context: file path must be absolute: ${path}`)
  return expanded
}

/**
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - agent proposing a step.
 * @returns {boolean} whether the agent runs a top-level session rather than a delegated child.
 */
function isTopLevel(agent) {
  return (agent.session.header.delegationDepth ?? 0) === 0
}

/**
 * Classify why the context is missing from the model-visible history.
 * @param {readonly import('@deepseek-ai/dsh-llm').Message[]} history - derived model-visible messages.
 * @returns {'startup' | 'resume' | 'compact'} the start source this step corresponds to.
 */
function missingSource(history) {
  if (history.some((message) => message.source.kind === COMPACT_CHECKPOINT_KIND)) return 'compact'
  return history.some((message) => message.role !== 'system') ? 'resume' : 'startup'
}

export function apply(ctx, config) {
  const files = config.files.map(expandPath)
  const sources = new Set(config.sources)
  const warnedMissing = new Set()

  /** @returns {Promise<string>} joined contents of the configured files that exist. */
  async function readContent() {
    const parts = []
    for (const file of files) {
      try {
        parts.push((await readFile(file, 'utf8')).trim())
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (!warnedMissing.has(file)) ctx.logger.warn('session-context: %s does not exist; skipped', file)
        warnedMissing.add(file)
      }
    }
    return parts.filter(Boolean).join('\n\n')
  }

  /**
   * @param {string} text - model-facing text.
   * @param {object} source - source fields beside the plugin kind.
   * @returns {import('@deepseek-ai/dsh-session').UserMessage} an identified context message.
   */
  const contextMessage = (text, source) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, ...source },
  })

  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    // A step-1 wake with nothing to say is not a turn the model answers; wait for real input.
    if (decision.kind !== 'enter' || (step === 1 && decision.messages.length === 0)) return decision

    const history = agent.session.deriveMessages()
    const ours = (form) => history.some((message) => message.source.kind === name && message.source.form === form)

    if (config.rootOnly && !isTopLevel(agent)) {
      // A fork child inherits its parent's history, including the context; tell it once to disregard it.
      if (config.subagentNotice === '' || !ours('instructions') || ours('notice')) return decision
      const notice = contextMessage(config.subagentNotice, { form: 'notice', summary: 'Inherited session context does not apply to this subagent' })
      return { ...decision, messages: [notice, ...decision.messages] }
    }

    if (ours('instructions')) return decision
    const trigger = missingSource(history)
    if (!sources.has(trigger)) return decision
    const content = await readContent()
    if (content === '') return decision
    const message = contextMessage(config.template.replaceAll('{content}', content), { form: 'instructions', trigger })
    return { ...decision, messages: [message, ...decision.messages] }
  })
}
