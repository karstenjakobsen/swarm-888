document.addEventListener("alpine:init", () => {
  Alpine.data("brainBrowser", () => ({
    table: "memory",
    rows: [],
    cursors: [null],
    nextCursor: null,
    pending: false,
    problem: "",
    version: 0,
    init() {
      this.load();
    },
    async load() {
      const version = ++this.version;
      const params = new URLSearchParams({ table: this.table });
      const cursor = this.cursors.at(-1);
      if (cursor !== null) params.set("before", cursor);
      this.pending = true;
      this.problem = "";
      try {
        const page = await SwarmAPI.request("brain?" + params);
        if (version !== this.version) return;
        this.rows = page.rows;
        this.nextCursor = page.next;
      } catch (e) {
        if (version === this.version) this.problem = e.message;
      } finally {
        if (version === this.version) this.pending = false;
      }
    },
    choose(table) {
      this.table = table;
      this.cursors = [null];
      this.newPage();
    },
    older() {
      this.cursors.push(this.nextCursor);
      this.newPage();
    },
    newer() {
      this.cursors.pop();
      this.newPage();
    },
    newPage() {
      this.rows = [];
      this.nextCursor = null;
      this.load();
    },
    workspaceName(id) {
      return this.projects.find((p) => p.id === id)?.name || id;
    },
    title(row) {
      if (this.table === "memory") return this.workspaceName(row.project);
      return row.prompt || row.message || row.name || row.directory || this.workspaceName(row.project);
    },
    stamp(row) {
      const time = row.created || row.at;
      return time ? SwarmAPI.time(time) : "";
    },
    fields(row) {
      return Object.entries(row)
        .filter(([name]) => name !== "record")
        .map(([name, value]) => ({ name, value: value ?? "NULL" }));
    },
  }));
});
