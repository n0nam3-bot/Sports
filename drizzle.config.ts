import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Default config used by `npx drizzle-kit push` on your own machine.
// Point it at your hosted Postgres by exporting DATABASE_URL first.
// (The sandbox automation uses the explicit drizzle.config.json instead.)
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});
