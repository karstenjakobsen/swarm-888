window.SwarmAPI = {
  async request(path, body) {
    const options =
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          };
    const response = await fetch("/api/" + path, options);
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(
        result.error || "The operator could not complete this request.",
      );
      error.status = response.status;
      throw error;
    }
    return result;
  },
  time(milliseconds) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(milliseconds);
  },
};
