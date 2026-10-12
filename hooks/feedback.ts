export type FeedbackKind = 'copied' | 'failed'

/** The feedback on screen: what it reports and how far it has faded in. */
export type Feedback = {
  kind: FeedbackKind
  /** From 1 to FULL_LEVEL while fading in, holding, then fading out. */
  level: number
}

/** The level at which the feedback is fully shown. */
export const FULL_LEVEL = 5

/** One level per step: a site redraws at most ten times a second. */
export const STEP_MS = 100

const HOLD_STEPS = 18

// Fade in (0.5 s), hold, fade out (0.4 s): about 2.7 seconds in all.
const LEVELS: readonly number[] = [
  ...Array.from({ length: FULL_LEVEL }, (_, i) => i + 1),
  ...Array.from({ length: HOLD_STEPS }, () => FULL_LEVEL),
  ...Array.from({ length: FULL_LEVEL - 1 }, (_, i) => FULL_LEVEL - 1 - i),
]

let current: Feedback | null = null
let step = 0

/** The feedback on screen, or null when the button shows. */
export function currentFeedback(): Feedback | null {
  return current
}

/** Starts the feedback for `kind` at its first level. */
export function startFeedback(kind: FeedbackKind): void {
  step = 0
  current = { kind, level: LEVELS[0] ?? FULL_LEVEL }
}

/** Moves the feedback one step on; false once it has ended. */
export function stepFeedback(): boolean {
  if (current === null) return false
  step += 1
  const level = LEVELS[step]
  current = level === undefined ? null : { kind: current.kind, level }
  return current !== null
}

/** Ends the feedback at once. */
export function endFeedback(): void {
  current = null
}
