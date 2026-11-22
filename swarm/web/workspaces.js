document.addEventListener("alpine:init", () => {
  Alpine.data("workspaceForm", () => ({
    creating: false,
    name: "",
    repository: "",
    ref: "",
    autoPublish: false,
    saving: false,
    problem: "",
    openForm() {
      this.creating = true;
      this.problem = "";
      this.$nextTick(() => this.$refs.name.focus());
    },
    closeForm() {
      this.creating = false;
    },
    async save() {
      if (this.saving) return;
      this.saving = true;
      this.problem = "";
      try {
        const project = await SwarmAPI.request("projects", {
          name: this.name,
          repository: this.repository,
          ref: this.ref,
          auto_publish: this.autoPublish,
        });
        this.name = "";
        this.repository = "";
        this.ref = "";
        this.autoPublish = false;
        this.creating = false;
        this.$dispatch("workspace-created", { id: project.id });
      } catch (e) {
        this.problem = e.message;
      } finally {
        this.saving = false;
      }
    },
  }));
});
