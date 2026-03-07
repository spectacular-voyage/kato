import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";
import { DEFAULT_KATO_WEB_PORT } from "@kato/shared";

export default defineConfig({
  plugins: [fresh()],
  server: {
    port: DEFAULT_KATO_WEB_PORT,
    strictPort: true,
  },
});
