DEFINE INDEX IF NOT EXISTS outbox_sequence ON TABLE outbox FIELDS sequence
  UNIQUE;
