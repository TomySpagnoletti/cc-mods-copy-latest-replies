import { expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

const TRANSCRIPT_PATH = '/Users/tomy/.claude/projects/-project/session.jsonl'

// A transcript as Claude Code writes it: a prompt sent from the prompt box,
// then two reply blocks, the second opened by a message from a subagent.
const TRANSCRIPT = [
  { type: 'user', uuid: 'a', parentUuid: null, origin: { kind: 'human' }, message: { content: 'question' } },
  { type: 'assistant', uuid: 'b', parentUuid: 'a', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Let me check.' }] } },
  { type: 'user', uuid: 'c', parentUuid: 'b', origin: { kind: 'peer' }, message: { content: 'Another Claude session sent a message: <agent-message>ok</agent-message>' } },
  { type: 'assistant', uuid: 'd', parentUuid: 'c', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here is the answer.' }] } },
]
  .map(row => JSON.stringify(row))
  .join('\n')
  .concat('\n')

const LINES = TRANSCRIPT.split('\n')
const COPIED = 'Let me check.\n\n---\n\nHere is the answer.'

// What the session holds in memory, which places the button.
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'question', toolUses: [] },
  { role: 'assistant', text: 'Let me check.', toolUses: [] },
  { role: 'assistant', text: 'Here is the answer.', toolUses: [] },
]

const reply = (text: string) => ({
  plugin: 'copy-latest-replies',
  component: 'AssistantMessage' as const,
  props: { text, isFirstOfReply: false },
})

// The shell commands the mod runs on the transcript, answered from memory.
function runOnTranscript(argv: readonly string[]): string {
  const [command, ...args] = argv
  if (command === 'find') return `${TRANSCRIPT_PATH}\n`
  if (command === 'wc') return `${LINES.length - 1} ${TRANSCRIPT_PATH}\n`
  if (command === 'grep') {
    const marker = args.at(-2) ?? ''
    return LINES.flatMap((line, i) => (line.includes(marker) ? [`${i + 1}:${marker}`] : [])).join('\n')
  }
  if (command === 'sed') {
    const [from = 1, to = 1] = (args[1] ?? '').replace('p', '').split(',').map(Number)
    return LINES.slice(from - 1, to).map(line => `${line}\n`).join('').replace(/\n+$/, '\n')
  }
  return ''
}

test('the button copies every reply block since the last sent prompt and plays its feedback', async ($, on) => {
  const clock = mock.clock(on)
  const copies: string[] = []

  // The engine's own drawing of a reply, standing in beneath the mod.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.id', () => ({ value: 'session' }))
  on('env.get', () => ({ value: '/Users/tomy' }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: runOnTranscript(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    copies.length = 0

    const earlier = await $.ui.mount({ ...reply('Let me check.'), surface })
    expect(await earlier.find({ key: 'copy' })).toBeUndefined()
    await earlier.unmount()

    const last = await $.ui.mount({ ...reply('Here is the answer.'), surface })
    expect((await last.find({ key: 'copy' }))?.text).toBe('Copy latest replies')

    await last.press({ key: 'copy' })
    expect(copies).toEqual([COPIED])

    // Faded in: the mark shows, and the button is still there, at its size.
    await clock.advance(500)
    expect(await last.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect(await last.find({ key: 'copy' })).toBeDefined()

    // A press during the feedback does not copy again.
    await last.press({ key: 'copy' })
    expect(copies).toEqual([COPIED])

    // Faded out: the plain button is back.
    await clock.advance(3000)
    expect(await last.find({ type: 'Text', text: '✓' })).toBeUndefined()
    expect((await last.find({ key: 'copy' }))?.text).toBe('Copy latest replies')
    await last.unmount()
  }
})
