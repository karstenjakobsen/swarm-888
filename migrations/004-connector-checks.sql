CREATE TABLE IF NOT EXISTS connector_checks (
 connectorId TEXT PRIMARY KEY REFERENCES connectors(id), snapshot TEXT NOT NULL
);
