import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/global/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
