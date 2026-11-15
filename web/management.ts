import type { Connector } from '../src/connectors/schemas';
export type { Connector } from '../src/connectors/schemas';
export const managementError = (error: unknown) => error instanceof Error ? error.message : 'Could not complete this action.';
export const shortCommit = (commit: string | null | undefined) => commit ? commit.slice(0, 10) : 'No commit yet';
export const connectionStatusLabel: Record<Connector['status'], string> = { untested: 'Not tested', connected: 'Test passed', error: 'Test failed' };
