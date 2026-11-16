ALTER TABLE conversations ADD COLUMN deletedAt TEXT;
CREATE INDEX visible_conversations_updated ON conversations(updatedAt DESC) WHERE deletedAt IS NULL;
CREATE INDEX runs_conversation_created ON runs(conversationId,createdAt);
CREATE INDEX runs_parent ON runs(parentRunId) WHERE parentRunId IS NOT NULL;
