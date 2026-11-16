import type { Run } from '../shared.ts';

/** Database JSON/boolean encoding is private to persistence, not shared DTOs. */
export function storedRun(value:unknown):Run {
  const row=value as Record<string,unknown>;
  return {...row,requiredConnectorIds:typeof row.requiredConnectorIds==='string'?JSON.parse(row.requiredConnectorIds):row.requiredConnectorIds??[],grantedConnectorIds:typeof row.grantedConnectorIds==='string'?JSON.parse(row.grantedConnectorIds):row.grantedConnectorIds??[],requiredRoot:row.requiredRoot===true||row.requiredRoot===1,usage:typeof row.usage==='string'?JSON.parse(row.usage):row.usage} as Run;
}
