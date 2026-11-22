export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function dayClock(iso: string, now = Date.now()) {
  const d = new Date(iso)
  const days = Math.floor((now - d.getTime()) / 86_400_000)
  if (days >= 2) return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}`
  return clock(iso)
}

export function duration(fromIso: string, to = Date.now()) {
  const mins = Math.max(0, Math.round((to - new Date(fromIso).getTime()) / 60_000))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}
