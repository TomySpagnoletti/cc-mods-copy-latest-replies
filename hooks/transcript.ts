// Reads a Claude Code session transcript (one JSON row per line) and gathers
// what Claude wrote since the last prompt the person sent from the prompt box.
//
// A prompt sent from the prompt box is the only row the engine marks with the
// origin `{ kind: "human" }`: a user row when it starts a turn, a
// `queued_command` attachment when it was sent while Claude was working.
// Task notifications, messages from subagents, compaction summaries and
// answers to Claude's questions all carry another origin, or none.

/** The exact text of that origin in a transcript line. */
export const SENT_PROMPT_MARKER = '"origin":{"kind":"human"}'


// The copied text is the app's reply blocks, one per native copy button, and
// the questions Claude asked with the answers given. Blocks are separated by a
// markdown rule; so is each question, from its neighbors.
const RULE = '\n\n---\n\n'
const PARAGRAPH = '\n\n'

type Origin = { kind?: string }

type ContentBlock = {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  tool_use_id?: string
  input?: { questions?: Question[] }
}

type Question = { question?: string; header?: string }

/** One transcript row, reduced to the fields read here. */
export type Row = {
  type?: string
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  isSidechain?: boolean
  origin?: Origin
  message?: { model?: string; content?: string | ContentBlock[] }
  toolUseResult?: unknown
  attachment?: { type?: string; origin?: Origin }
}

export type Replies = {
  /** What to copy: the blocks, oldest first, with their questions. */
  text: string
  /** How many reply blocks there are, as many as the app's copy buttons. */
  blocks: number
}

export type RepliesSearch =
  | { isFound: true; replies: Replies }
  /** The branch goes on before the rows given: read from an earlier line. */
  | { isFound: false }

/** Parses the rows of a transcript, skipping lines that are not JSON. */
export function parseRows(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line) as Row)
    } catch {
      // A line cut short while the engine was writing it.
    }
  }
  return rows
}

/** Whether a row is a prompt the person sent from the prompt box. */
export function isSentPrompt(row: Row): boolean {
  if (row.isSidechain === true) return false
  if (row.type === 'user') return row.origin?.kind === 'human'
  return row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.origin?.kind === 'human'
}

const blocksOf = (row: Row): ContentBlock[] => (Array.isArray(row.message?.content) ? row.message.content : [])

const isToolResult = (row: Row): boolean => blocksOf(row).some(block => block.type === 'tool_result')

// Messages that reach the session show inside the reply block in progress
// when they are task notifications ("4 background tasks completed"). Any
// other incoming message, such as one from a subagent ("Message from
// subagent", "Received a message"), opens a new reply block with its own copy
// button. Rows without an origin (a compaction summary, a skill's text, an
// image caption) are not messages and stay in the block too.
const IN_BLOCK_ORIGINS: readonly string[] = ['task-notification']

const opensBlock = (row: Row): boolean =>
  row.type === 'user' &&
  !isToolResult(row) &&
  row.origin?.kind !== undefined &&
  !IN_BLOCK_ORIGINS.includes(row.origin.kind)

/**
 * The rows of the conversation on screen, oldest first, after the last
 * prompt the person sent. Follows each row's parent from the newest one, so
 * an abandoned branch is left out, and crosses a compaction through its
 * logical parent.
 */
function rowsSinceLastPrompt(rows: readonly Row[]): Row[] | null {
  const byUuid = new Map<string, Row>()
  for (const row of rows) if (row.uuid !== undefined) byUuid.set(row.uuid, row)

  const branch: Row[] = []
  let row = rows.findLast(candidate => candidate.uuid !== undefined && candidate.isSidechain !== true)
  while (row !== undefined) {
    if (isSentPrompt(row)) return branch.reverse()
    branch.push(row)
    const parent = row.parentUuid ?? row.logicalParentUuid ?? null
    if (parent === null) return branch.reverse()
    row = byUuid.get(parent)
    if (row === undefined) return null
  }
  return branch.reverse()
}

/** `Q: [header] question` and `A: answer`, one pair per question asked. */
function questionPairs(asked: readonly Question[], toolUseResult: unknown): string[] {
  const answers =
    typeof toolUseResult === 'object' && toolUseResult !== null
      ? (toolUseResult as { answers?: Record<string, string> }).answers
      : undefined
  // A string result, or none, means the person declined the questions.
  const isDeclined = answers === undefined
  return asked.map(({ question = '', header }) => {
    const q = header === undefined ? question : `[${header}] ${question}`
    const a = isDeclined ? '(declined)' : (answers[question] ?? '(no answer)')
    return `Q: ${q}\nA: ${a}`
  })
}

// What the walk over the branch produces: text, or a markdown rule.
type Part = string | typeof RULE

/** Joins the parts: a rule where one stands, a blank line elsewhere. */
function render(parts: readonly Part[]): string {
  let text = ''
  let isRuleDue = false
  for (const part of parts) {
    if (part === RULE) {
      isRuleDue = text !== ''
      continue
    }
    if (text !== '') text += isRuleDue ? RULE : PARAGRAPH
    text += part
    isRuleDue = false
  }
  return text
}

/**
 * What Claude wrote since the last prompt the person sent, block by block as
 * the app shows them: the text of Claude's messages, the thinking it shows,
 * and the questions Claude asked with the answers given. Tool calls and their
 * results are left out.
 */
export function repliesSinceLastPrompt(rows: readonly Row[]): RepliesSearch {
  const branch = rowsSinceLastPrompt(rows)
  if (branch === null) return { isFound: false }

  const askedQuestions = new Map<string, Question[]>()
  const parts: Part[] = []
  let blocks = 0
  let isBlockOpen = false
  const write = (part: string) => {
    if (!isBlockOpen) blocks += 1
    isBlockOpen = true
    parts.push(part)
  }

  for (const row of branch) {
    if (row.type === 'assistant' && row.message?.model !== '<synthetic>') {
      for (const block of blocksOf(row)) {
        // The app shows Claude's thinking when the transcript keeps its text.
        const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : undefined
        if (text?.trim()) write(text.trim())
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && block.id !== undefined) {
          askedQuestions.set(block.id, block.input?.questions ?? [])
        }
      }
    } else if (opensBlock(row)) {
      parts.push(RULE)
      isBlockOpen = false
    } else if (row.type === 'user') {
      for (const block of blocksOf(row)) {
        const asked = block.tool_use_id === undefined ? undefined : askedQuestions.get(block.tool_use_id)
        if (asked === undefined) continue
        for (const pair of questionPairs(asked, row.toolUseResult)) {
          parts.push(RULE)
          write(pair)
          parts.push(RULE)
        }
      }
    }
  }

  return { isFound: true, replies: { text: render(parts), blocks } }
}

/** Line numbers (1-based) of the sent prompts, from `grep -n -o` output. */
export function sentPromptLines(grepOutput: string): number[] {
  return grepOutput
    .split('\n')
    .map(line => Number.parseInt(line, 10))
    .filter(line => Number.isInteger(line) && line > 0)
}
