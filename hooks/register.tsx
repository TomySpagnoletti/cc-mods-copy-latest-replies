import type { EngineInterface, Register, RenderSurface, SessionMessage } from 'claude-code'

import { isLocalSurface, SYSTEM_CLIPBOARD_TOOLS } from './clipboard'
import { CopyButton } from './copy-button'
import { currentFeedback, endFeedback, type FeedbackKind, startFeedback, STEP_MS, stepFeedback } from './feedback'
import { parseRows, type Replies, repliesSinceLastPrompt, SENT_PROMPT_MARKER, sentPromptLines } from './transcript'

// Everything that calls `$` lives in this file: the engine follows `$` into
// functions declared here, never across an import.

const COMMAND = 'copy-latest-replies'

// A read through `$.process.run` returns at most 4 MiB: a transcript is read
// in ranges of lines, halved whenever one comes back cut short.
const FIRST_CHUNK_LINES = 2000

// The session's transcript file, as the engine hands it to its hook events.
let transcriptPath: string | null = null

// Whether Claude is working on a turn of the main conversation.
let isWorking = false

let feedbackTimer: { cancel: () => void } | null = null

// Subagents run turns of their own; only the main conversation's count.
const isMainLoop = (e: object): boolean => (e as { agentId?: string }).agentId === undefined

/** Claude's last message with text in it, the one the button sits under. */
function lastClaudeMessage(messages: readonly SessionMessage[]): string {
  return messages.findLast(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? ''
}

/** Whether a message as a surface draws it is the given stored message. */
function isSameMessage(drawn: string, stored: string): boolean {
  const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()
  const a = collapse(drawn)
  const b = collapse(stored)
  return a !== '' && b !== '' && (a === b || a.endsWith(b) || b.endsWith(a))
}

/** The transcript file: as the hook events named it, else found by session id. */
async function findTranscript($: EngineInterface): Promise<string | null> {
  if (transcriptPath !== null) return transcriptPath
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const sessionId = await $.session.id()
  const { stdout } = await $.process.run(['find', `${configDir}/projects`, '-maxdepth', '2', '-name', `${sessionId}.jsonl`])
  transcriptPath = stdout.split('\n').find(line => line.trim() !== '') ?? null
  return transcriptPath
}

/** The transcript from line `from` (1-based) to its end. */
async function readTranscriptFrom($: EngineInterface, path: string, from: number): Promise<string> {
  const { stdout } = await $.process.run(['wc', '-l', path])
  const lineCount = Number.parseInt(stdout.trim(), 10) + 1
  const chunks: string[] = []
  let start = from
  let size = FIRST_CHUNK_LINES
  while (start <= lineCount) {
    const end = start + size - 1
    const chunk = await $.process.run(['sed', '-n', `${start},${end}p`, path])
    if (chunk.isStdoutTruncated && size > 1) {
      size = Math.ceil(size / 2)
      continue
    }
    // A single line past 4 MiB holds a picture or a tool's output, never text to copy.
    if (!chunk.isStdoutTruncated) chunks.push(chunk.stdout)
    start = end + 1
  }
  return chunks.join('')
}

/**
 * What Claude wrote since the last prompt sent from the prompt box. Reads the
 * transcript from that prompt's line on; when the branch on screen goes back
 * further (a rewound conversation), from the prompt sent before it.
 */
async function readLatestReplies($: EngineInterface): Promise<Replies | null> {
  const path = await findTranscript($)
  if (path === null) return null
  const { stdout } = await $.process.run(['grep', '-n', '-o', '-F', SENT_PROMPT_MARKER, path])
  const promptLines = sentPromptLines(stdout)
  for (const from of [...promptLines.reverse(), 1]) {
    const search = repliesSinceLastPrompt(parseRows(await readTranscriptFrom($, path, from)))
    if (search.isFound) return search.replies
  }
  return null
}

/**
 * Puts `text` on the clipboard of the surface the person acted on, falling
 * back to the system clipboard when that surface is on this machine.
 */
async function copyToClipboard($: EngineInterface, text: string, surface?: RenderSurface): Promise<boolean> {
  const result = await $.ui.copy(surface === undefined ? { text } : { text, surface })
  if (result.isCopied) return true
  if (!isLocalSurface(surface)) return false
  for (const argv of SYSTEM_CLIPBOARD_TOOLS) {
    try {
      const { exitCode } = await $.process.run(argv, { stdin: text, timeoutMs: 5000 })
      if (exitCode === 0) return true
    } catch {
      // Not installed on this machine: try the next one.
    }
  }
  return false
}

async function copyLatestReplies($: EngineInterface, surface?: RenderSurface): Promise<boolean> {
  try {
    const replies = await readLatestReplies($)
    return replies !== null && replies.blocks > 0 && (await copyToClipboard($, replies.text, surface))
  } catch {
    return false
  }
}

function stopFeedback(): void {
  feedbackTimer?.cancel()
  feedbackTimer = null
  endFeedback()
}

/** Plays the feedback for `kind`, redrawing at each step until it ends. */
function playFeedback($: EngineInterface, kind: FeedbackKind): void {
  stopFeedback()
  startFeedback(kind)
  feedbackTimer = $.clock.every(STEP_MS, () => {
    if (!stepFeedback()) stopFeedback()
    $.ui.invalidate('ui.render')
  })
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Copy Claude's replies since your last message, without tool calls",
      immediate: true,
    })
    return next(e)
  })

  // Every hook event names the transcript file; keep the latest.
  on('classic.SessionStart', async ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (isMainLoop(e)) {
      isWorking = true
      stopFeedback()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (isMainLoop(e)) {
      isWorking = false
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isCopied = await copyLatestReplies($)
    return { text: isCopied ? '✓ Copied' : '✗ Nothing copied' }
  }).catch(() => ({ text: '✗ Nothing copied' }))

  // The button sits under Claude's last message, aligned left. Messages are
  // drawn on every surface, the mobile app included.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const message = await next(e)
    if (isWorking) return message
    if (!isSameMessage(e.props.text, lastClaudeMessage(await $.session.messages()))) return message

    const onPress = async () => {
      if (currentFeedback() !== null) return
      const isCopied = await copyLatestReplies($, e.surface)
      playFeedback($, isCopied ? 'copied' : 'failed')
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    return (
      <Box flexDirection="column">
        {message}
        <Box flexDirection="row" justifyContent="flex-start">
          {CopyButton({ ui, surface: e.surface, feedback: currentFeedback(), onPress })}
        </Box>
      </Box>
    )
  })
}
