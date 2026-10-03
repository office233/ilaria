import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://swypik.com",
  output: "static",
  vite: {
    plugins: [tailwindcss()],
  },
});
