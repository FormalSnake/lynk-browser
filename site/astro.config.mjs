// @ts-check
import { defineConfig } from "astro/config";

import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://lynk.formalsnake.dev",
  integrations: [react()],
  server: {
    allowedHosts: [".ts.net"],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
