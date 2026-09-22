import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Several modules read API keys as a top-level `const` at import
    // time (e.g. `new OpenAI(...)`, HUNTER_API_KEY), which runs before
    // any per-test vi.stubEnv — these dummy values just need to exist
    // so those modules can load; real network calls are always mocked.
    env: {
      HUNTER_API_KEY: "test-hunter-key",
      OPENAI_API_KEY: "test-openai-key",
      RESEND_API_KEY: "test-resend-key",
    },
  },
});
