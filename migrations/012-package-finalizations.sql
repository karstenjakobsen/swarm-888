CREATE TABLE package_finalizations (
 runId TEXT NOT NULL REFERENCES runs(id), packageId TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','committed','aborted')),
 commitSha TEXT, error TEXT, updatedAt TEXT NOT NULL,
 PRIMARY KEY(runId,packageId)
);
CREATE INDEX package_finalizations_pending ON package_finalizations(state,runId);
