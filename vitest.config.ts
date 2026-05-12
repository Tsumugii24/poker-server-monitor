import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/test-setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"]
  }
});
