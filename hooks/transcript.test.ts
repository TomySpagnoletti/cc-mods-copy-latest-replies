import { describe, expect, test } from 'claude-code/testing'

import { isSentPrompt, parseRows, repliesSinceLastPrompt, type Row, sentPromptLines } from './transcript'

// Rows shaped as Claude Code writes them, reduced to the fields that matter.
type Fields = Record<string, unknown>

let next = 0
const chain = (rows: Fields[], parent: string | null = null): Row[] =>
  rows.map(fields => {
    const uuid = `u${++next}`
    const row = { parentUuid: parent, ...fields, uuid } as Row
    parent = uuid
    return row
  })

const sent = (text: string): Fields => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } })
const claude = (text: string): Fields => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
})
const thinking = (text: string): Fields => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: text, signature: 'sig' }] },
})
const toolCall = (id: string): Fields => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash' }] },
})
const toolResult = (id: string): Fields => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'output' }] },
  toolUseResult: { stdout: 'output' },
})
const notification = (): Fields => ({
  type: 'user',
  origin: { kind: 'task-notification' },
  message: { content: '<task-notification>done</task-notification>' },
})
const subagentMessage = (): Fields => ({
  type: 'user',
  isMeta: true,
  origin: { kind: 'peer' },
  message: { content: 'Another Claude session sent a message: <agent-message>ok</agent-message>' },
})

const POSTGRES = { header: 'PostgreSQL', question: 'Move to 18?' }
const BUN = { header: 'Bun', question: 'Check the signature?' }
const ask = (id: string, questions = [POSTGRES]): Fields => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] },
})
const answer = (id: string, answers: Record<string, string>, questions = [POSTGRES]): Fields => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'The user answered' }] },
  toolUseResult: { questions, answers },
})

const repliesOf = (rows: Row[]) => {
  const search = repliesSinceLastPrompt(rows)
  if (!search.isFound) throw new Error('replies not found')
  return search.replies
}

describe('isSentPrompt', () => {
  test('is a prompt sent from the prompt box, at a turn start or queued during one', async () => {
    expect(isSentPrompt(sent('hi') as Row)).toBe(true)
    expect(isSentPrompt({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' } } })).toBe(true)
  })

  test('is not anything the engine or an answer brought in', async () => {
    expect(isSentPrompt(notification() as Row)).toBe(false)
    expect(isSentPrompt(subagentMessage() as Row)).toBe(false)
    expect(isSentPrompt(answer('q', { 'Move to 18?': 'Client 18' }) as Row)).toBe(false)
    expect(isSentPrompt({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'task-notification' } } })).toBe(false)
    expect(isSentPrompt({ ...sent('hi'), isSidechain: true } as Row)).toBe(false)
  })
})

describe('repliesSinceLastPrompt', () => {
  test("copies Claude's text since the last sent prompt, without it and without tools", async () => {
    const replies = repliesOf(
      chain([sent('old'), claude('old answer'), sent('new'), claude('Let me check.'), toolCall('t1'), toolResult('t1'), claude('Done.')]),
    )
    expect(replies.text).toBe('Let me check.\n\nDone.')
    expect(replies.blocks).toBe(1)
  })

  test('opens a new block at each message from a subagent, as the app does', async () => {
    const replies = repliesOf(chain([sent('go'), claude('Started.'), subagentMessage(), claude('Verified.')]))
    expect(replies.text).toBe('Started.\n\n---\n\nVerified.')
    expect(replies.blocks).toBe(2)
  })

  test('opens a new block at any other incoming message, whatever its kind', async () => {
    const message = { type: 'user', origin: { kind: 'channel' }, message: { content: 'A message from elsewhere' } }
    expect(repliesOf(chain([sent('go'), claude('Started.'), message, claude('Answered.')])).text).toBe('Started.\n\n---\n\nAnswered.')
  })

  test('keeps a row that is not a message inside the block', async () => {
    const skillText = { type: 'user', isMeta: true, message: { content: 'Base directory for this skill: …' } }
    expect(repliesOf(chain([sent('go'), claude('Loading the skill.'), skillText, claude('Done.')])).text).toBe(
      'Loading the skill.\n\nDone.',
    )
  })

  test('copies the thinking the app shows, and skips the thinking it does not keep', async () => {
    const replies = repliesOf(chain([sent('go'), thinking('Checking the policy first.'), thinking(''), claude('The policy is right.')]))
    expect(replies.text).toBe('Checking the policy first.\n\nThe policy is right.')
  })

  test('keeps a task notification inside the block, as the app does', async () => {
    const replies = repliesOf(chain([sent('go'), claude('Started.'), notification(), claude('Waiting.')]))
    expect(replies.text).toBe('Started.\n\nWaiting.')
    expect(replies.blocks).toBe(1)
  })

  test('copies each question asked and the answer given, set apart by rules', async () => {
    const replies = repliesOf(
      chain([
        sent('go'),
        claude('Two choices first.'),
        ask('q1', [POSTGRES, BUN]),
        answer('q1', { 'Move to 18?': 'Client 18', 'Check the signature?': 'Check' }, [POSTGRES, BUN]),
        claude('Noted.'),
      ]),
    )
    expect(replies.text).toBe(
      [
        'Two choices first.',
        'Q: [PostgreSQL] Move to 18?\nA: Client 18',
        'Q: [Bun] Check the signature?\nA: Check',
        'Noted.',
      ].join('\n\n---\n\n'),
    )
    expect(replies.blocks).toBe(1)
  })

  test('copies a declined question as declined', async () => {
    const declined = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'The user rejected the tool use' }] },
      toolUseResult: 'User rejected tool use',
    }
    expect(repliesOf(chain([sent('go'), ask('q1'), declined])).text).toBe('Q: [PostgreSQL] Move to 18?\nA: (declined)')
  })

  test('crosses a compaction, which stays inside the block', async () => {
    const before = chain([sent('go'), claude('Before the compaction.')])
    const boundary: Row = { type: 'system', uuid: 'boundary', parentUuid: null, logicalParentUuid: before.at(-1)?.uuid ?? null }
    const after = chain(
      [{ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }, claude('After the compaction.')],
      'boundary',
    )
    expect(repliesOf([...before, boundary, ...after]).text).toBe('Before the compaction.\n\nAfter the compaction.')
  })

  test('stops at a prompt queued while Claude was working', async () => {
    const queued = { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' } } }
    expect(repliesOf(chain([sent('go'), claude('First.'), queued, claude('Second.')])).text).toBe('Second.')
  })

  test('leaves out an abandoned branch', async () => {
    const [prompt, kept] = chain([sent('go'), claude('Kept.')])
    const abandoned = chain([claude('Abandoned.')], prompt?.uuid)
    const latest = chain([claude('Latest.')], kept?.uuid)
    expect(repliesOf([prompt!, kept!, ...abandoned, ...latest]).text).toBe('Kept.\n\nLatest.')
  })

  test('asks for earlier lines when the branch goes on before them', async () => {
    const [, ...afterThePrompt] = chain([sent('go'), claude('Reply.')])
    expect(repliesSinceLastPrompt(afterThePrompt).isFound).toBe(false)
  })
})

describe('reading the transcript', () => {
  test('parses its rows, skipping a line cut short', async () => {
    expect(parseRows('{"type":"user"}\n{"type":"assi\n\n{"type":"assistant"}\n')).toEqual([{ type: 'user' }, { type: 'assistant' }])
  })

  test('reads the sent prompts’ line numbers from grep', async () => {
    expect(sentPromptLines('12:"origin":{"kind":"human"}\n12069:"origin":{"kind":"human"}\n')).toEqual([12, 12069])
  })
})
