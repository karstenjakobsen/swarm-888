document.addEventListener("alpine:init", () => {
  Alpine.data("peerForm", () => ({
    name: "",
    url: "",
    token: "",
    inviteName: "",
    inviteToken: "",
    problem: "",
    busyPeer: false,
    async connect() {
      if (this.busyPeer) return;
      this.busyPeer = true;
      this.problem = "";
      try {
        await SwarmAPI.request("peers", {
          name: this.name,
          url: this.url,
          token: this.token,
        });
        this.name = "";
        this.url = "";
        this.token = "";
        this.$dispatch("peers-changed");
      } catch (e) {
        this.problem = e.message;
      } finally {
        this.busyPeer = false;
      }
    },
    async invite() {
      if (this.busyPeer) return;
      this.busyPeer = true;
      this.problem = "";
      try {
        const result = await SwarmAPI.request("invites", {
          name: this.inviteName,
        });
        this.inviteToken = result.token;
        this.inviteName = "";
        this.$dispatch("peers-changed");
      } catch (e) {
        this.problem = e.message;
      } finally {
        this.busyPeer = false;
      }
    },
  }));
});
