import { useEffect, useState } from 'react';

/** Keep the running release visible without interrupting work during deployment. */
export function ReleaseCommit() {
  const [commit, setCommit] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let pending: AbortController | undefined;
    const refresh = async () => {
      if (document.hidden) return;
      pending?.abort();
      const request = new AbortController();
      pending = request;
      try {
        const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) return;
        const value = await response.json();
        if (alive && pending === request && typeof value?.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit)) setCommit(value.commit);
      } catch { /* Keep the last known release while the server restarts or reconnects. */ }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { alive = false; pending?.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); };
  }, []);
  return commit ? <span className="release-commit" title={commit}>Commit <code>{commit.slice(0, 7)}</code></span> : null;
}
