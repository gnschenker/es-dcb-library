// Global setup for integration tests — populated by T-08
// Stub so vitest.config.ts globalSetup reference resolves at scaffolding stage

export async function setup(): Promise<void> {
  // T-08 will implement: start PostgreSQL testcontainer, set TEST_DATABASE_URL
}

export async function teardown(): Promise<void> {
  // T-08 will implement: stop the container
}
