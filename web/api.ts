let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.method && options.method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...options.headers },
  });
  let body: any;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/session') window.dispatchEvent(new Event('operator:unauthorized'));
    const error = body?.message || body?.error;
    throw new Error(typeof error === 'string' ? error : error?.message || (error ? JSON.stringify(error) : `Request failed (${response.status})`));
  }
  return body as T;
}
export function post<T = unknown>(path: string, body: unknown = {}) { return api<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
export function asList(value: any): any[] { return Array.isArray(value) ? value : value?.entries || value?.skills || value?.items || value?.results || value?.artifacts || []; }
