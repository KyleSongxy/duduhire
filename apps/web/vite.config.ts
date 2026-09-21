import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: env.DUDUHIRE_API_PROXY_TARGET || "http://localhost:8787",
          changeOrigin: false,
        },
      },
    },
    build: {
      target: "es2022",
    },
  };
});
