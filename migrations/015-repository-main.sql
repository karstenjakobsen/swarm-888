ALTER TABLE repositories ADD COLUMN syncMode TEXT NOT NULL DEFAULT 'legacy' CHECK(syncMode IN ('legacy','main'));
