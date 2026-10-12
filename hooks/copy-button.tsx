import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { FULL_LEVEL, type Feedback } from './feedback'

export const LABEL = 'Copy latest replies'

type Ui = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button'>

const MARK = { copied: '✓', failed: '✗' } as const
const MARK_COLOR = { copied: 'success', failed: 'error' } as const

// A translucent tint, growing with each level of the fade (hex alpha).
const TINT = { copied: '#2da44e', failed: '#cf222e' } as const
const TINT_ALPHA: readonly string[] = ['00', '10', '1c', '28', '34', '40']

// Fully shown, an opaque layer from the person's theme goes under the tint:
// it hides the label, since an app's native button ignores the color of its
// own text, and the theme's translucent colors would let it show through.
const BASE = 'inverseText'

/**
 * The copy button, or the feedback in its place. The feedback never changes
 * the button's size: the terminal centers the mark in the label's width, an
 * app keeps its native button and lays the feedback over it.
 */
export function CopyButton(props: {
  ui: Ui
  surface: RenderSurface
  feedback: Feedback | null
  onPress: () => void
}): RenderElement {
  const { ui, surface, feedback, onPress } = props
  const { Box, Text, Button } = ui

  if (feedback === null) {
    return <Button key="copy" label={LABEL} dimColor onPress={onPress} />
  }

  const mark = (
    <Text color={MARK_COLOR[feedback.kind]} bold>
      {MARK[feedback.kind]}
    </Text>
  )

  // A monospace grid: spaces around the mark take the label's exact width.
  if (surface === 'terminal') {
    const left = Math.floor((LABEL.length - 1) / 2)
    const right = LABEL.length - 1 - left
    return (
      <Button key="copy" onPress={onPress}>
        {' '.repeat(left)}
        {mark}
        {' '.repeat(right)}
      </Button>
    )
  }

  // The tint fades in over the label; once full, the opaque base hides the
  // label and the mark takes its place.
  const isFull = feedback.level >= FULL_LEVEL
  const tint = TINT[feedback.kind] + (TINT_ALPHA[Math.min(feedback.level, FULL_LEVEL)] ?? '00')

  return (
    <Box key="copy-slot" position="relative">
      <Button key="copy" label={LABEL} onPress={onPress} />
      <Box position="absolute" top={0} left={0} right={0} bottom={0} {...(isFull ? { backgroundColor: BASE } : {})}>
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          backgroundColor={tint}
          justifyContent="center"
          alignItems="center"
        >
          {isFull ? mark : null}
        </Box>
      </Box>
    </Box>
  )
}
