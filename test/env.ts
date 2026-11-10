// Imported first by tests that touch storage: db.ts opens its database at import time,
// and each test file runs in its own process, so every file gets a private in-memory store.
process.env.DB_PATH = ":memory:";
