ALTER TABLE connectors ADD COLUMN packageId TEXT REFERENCES packages(id);
CREATE UNIQUE INDEX connectors_package ON connectors(packageId) WHERE packageId IS NOT NULL;
