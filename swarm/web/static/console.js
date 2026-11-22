document.addEventListener("alpine:init", () => {
  Alpine.data("disclosure", () => ({ open: false, toggle() { this.open = !this.open } }))
})
document.addEventListener("DOMContentLoaded", () => {
  const view = document.querySelector("#console")
  const task = view?.dataset.task
  if (!task) return
  const feed = document.querySelector("#feed")
  const snapshotCursor = Number(view.dataset.eventCursor)
  const source = new EventSource("/activity?task=" + encodeURIComponent(task))
  const connection = document.querySelector("#connection")
  source.onopen = () => { connection.textContent = "Connected" }
  source.onerror = () => { connection.textContent = "Reconnecting…" }
  source.onmessage = message => {
    const row = JSON.parse(message.data)
    if (row.task !== task) return
    const details = document.createElement("details")
    const summary = document.createElement("summary")
    const pre = document.createElement("pre")
    summary.textContent = new Date(row.at * 1000).toLocaleTimeString() + "  " + row.kind + (row.data.tool ? " · " + row.data.tool : "")
    pre.textContent = JSON.stringify(row.data, null, 2)
    details.append(summary, pre)
    feed.append(details)
    const rev = row.data.revision || row.data.result?.revision
    if (typeof rev === "string" && /^[a-f0-9]{64}$/.test(rev)) {
      const link = document.createElement("a")
      link.href = "/artifacts/" + rev
      link.textContent = "Revision artifact"
      details.append(link)
    }
    if (["operator.message","owner.followup","question","run.failed","codex.error"].includes(row.kind)) {
      const text = document.createElement("p")
      text.className = "reply"
      text.textContent = row.data.text || row.data.error || row.data.message
      document.querySelector("#messages").append(text)
    }
    // Historical activity is replayed in full. The rendered task already includes its status.
    if (row.id <= snapshotCursor) return
    if (row.kind === "run.started") document.querySelector("#status").textContent = "running"
    if (row.kind === "credential.required") {
      document.querySelector("#credential-destination").textContent = row.data.destination
    }
    if (row.kind === "run.status") {
      document.querySelector("#status").textContent = row.data.status
      document.querySelector("#credential").hidden = row.data.status !== "credential"
    }
  }
})
