document.addEventListener("alpine:init", () => {
  Alpine.data("dashboard", () => ({
    operator: "Local operator",
    projectId: sessionStorage.getItem("workspace") || "inbox",
    projects: [],
    peers: [],
    jobs: [],
    catalog: [],
    sharedCatalog: null,
    active: [],
    capacity: 0,
    queued: 0,
    selectedTab: "runs",
    selectedRun: "",
    detail: null,
    prompt: "",
    target: "",
    operatorKey: "",
    authenticated: false,
    loading: true,
    busy: false,
    pendingRequest: null,
    error: "",
    timer: null,
    connected: false,
    pollVersion: 0,
    async init() {
      const hash = new URLSearchParams(location.hash.slice(1));
      if (hash.has("token")) {
        const token = hash.get("token");
        history.replaceState(null, "", location.pathname);
        try {
          await SwarmAPI.request("session", { token });
        } catch (e) {
          this.error = e.message;
        }
      }
      await this.refresh();
      this.timer = setInterval(() => {
        if (!document.hidden && this.authenticated) this.refresh();
      }, 2000);
    },
    destroy() {
      clearInterval(this.timer);
    },
    async signIn() {
      try {
        await SwarmAPI.request("session", { token: this.operatorKey.trim() });
        this.operatorKey = "";
        this.error = "";
        await this.refresh();
      } catch (e) {
        this.error = e.message;
      }
    },
    async refresh() {
      const version = ++this.pollVersion;
      try {
        const state = await SwarmAPI.request(
          "state?project=" + encodeURIComponent(this.projectId),
        );
        if (version !== this.pollVersion) return;
        Object.assign(this, state);
        this.connected = true;
        this.authenticated = true;
        if (this.selectedRun) await this.loadDetail(this.selectedRun);
      } catch (e) {
        if (version !== this.pollVersion) return;
        this.connected = false;
        if (e.status === 401) this.authenticated = false;
        else if (e.status === 404 && this.projectId !== "inbox")
          return this.selectProject("inbox");
        else this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    get project() {
      return (
        this.projects.find((p) => p.id === this.projectId) || {
          name: "Workspace",
        }
      );
    },
    get workspaces() {
      return this.projects.filter((p) => p.id !== this.sharedCatalog?.id);
    },
    get workers() {
      return Array.from({ length: this.capacity }, (_, i) => {
        const id = "worker-" + String(i + 1).padStart(2, "0");
        return { id, run: this.active.find((r) => r.worker === id) };
      });
    },
    get activeCount() {
      return this.active.length;
    },
    get sharedRevision() {
      const { branch, revision } = this.sharedCatalog;
      return revision
        ? branch + " · " + revision.slice(0, 12)
        : branch + " · Awaiting sync";
    },
    get showWorkspaceCatalog() {
      return (
        !this.sharedCatalog ||
        (this.projectId !== this.sharedCatalog.id &&
          (this.project.repo || this.catalog.length > 0))
      );
    },
    get slotLabel() {
      return this.activeCount + " of " + this.capacity + " active";
    },
    get viewTitle() {
      return {
        runs: "Run desk",
        brain: "Brain",
        catalog: "Catalog",
        workers: "Worker pool",
        peers: "Peer operators",
      }[this.selectedTab];
    },
    get emptyRuns() {
      return this.jobs.length === 0;
    },
    get submitDisabled() {
      return this.busy || !this.prompt.trim();
    },
    get runSummary() {
      return this.jobs.length === 1
        ? "1 recent run"
        : this.jobs.length + " recent runs";
    },
    tab(name) {
      this.selectedTab = name;
      this.error = "";
    },
    navClass(name) {
      return this.selectedTab === name ? "nav chosen" : "nav";
    },
    projectClass(id) {
      return this.projectId === id ? "project chosen-project" : "project";
    },
    stateClass(state) {
      return "state " + state;
    },
    when(value) {
      return SwarmAPI.time(value);
    },
    jobTitle(job) {
      return job.prompt;
    },
    workerLabel(job) {
      return job.worker || "Awaiting assignment";
    },
    workerStatus(worker) {
      return worker.run ? "Working" : "Idle";
    },
    workerActivity(worker) {
      return worker.run ? worker.run.activity : "Ready for a task";
    },
    async selectProject(id) {
      this.projectId = id;
      sessionStorage.setItem("workspace", id);
      this.selectedRun = "";
      this.detail = null;
      this.jobs = [];
      this.catalog = [];
      this.prompt = "";
      this.tab("runs");
      await this.refresh();
    },
    async newRun() {
      if (this.submitDisabled) return;
      this.busy = true;
      this.error = "";
      const draft = {
        project: this.projectId,
        prompt: this.prompt.trim(),
        target: this.target,
      };
      const key = JSON.stringify(draft);
      if (this.pendingRequest?.key !== key)
        this.pendingRequest = { key, id: crypto.randomUUID() };
      try {
        const run = await SwarmAPI.request("runs", {
          ...draft,
          request_id: this.pendingRequest.id,
        });
        this.prompt = "";
        this.pendingRequest = null;
        this.selectedRun = run.id;
        await this.refresh();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
    async inspect(id) {
      if (this.selectedRun === id) {
        this.selectedRun = "";
        this.detail = null;
        return;
      }
      this.selectedRun = id;
      this.detail = null;
      try {
        await this.loadDetail(id);
      } catch (e) {
        this.error = e.message;
      }
    },
    async loadDetail(id) {
      const data = await SwarmAPI.request("runs/" + id);
      if (this.selectedRun === id) this.detail = data;
    },
    showDetail(id) {
      return this.selectedRun === id && this.detail !== null;
    },
    async catalogAction(kind, projectId = this.projectId) {
      this.busy = true;
      this.error = "";
      try {
        const job = await SwarmAPI.request("runs", {
          project: projectId,
          kind,
          request_id: crypto.randomUUID(),
        });
        if (projectId !== this.projectId) await this.selectProject(projectId);
        this.selectedRun = job.id;
        this.tab("runs");
        await this.refresh();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },
  }));
});
