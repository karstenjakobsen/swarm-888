export type OperatorMode = 'demo' | 'live'

// Called only by Next.js server components and route handlers.
export function operatorMode(): OperatorMode {
  const mode = process.env.OPERATOR_MODE ?? 'demo'
  if (mode === 'demo' || mode === 'live') return mode
  throw new Error('OPERATOR_MODE must be demo or live')
}
