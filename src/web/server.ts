import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createJournal } from "../journal/journal.js";
import { createFoodLogger } from "../log/logger.js";
import { createApp } from "./routes.js";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

const logger = await createFoodLogger();
const journal = await createJournal().catch(async (error: unknown) => {
  await logger.close();
  throw error;
});
const app = createApp({ logger, journal });

const webDist = join(process.cwd(), "web/dist");
if (existsSync(join(webDist, "index.html"))) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) {
      return next();
    }
    return serveStatic({ path: "./web/dist/index.html" })(c, next);
  });
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Food log: http://${hostname}:${info.port}`);
});

async function shutdown() {
  server.close();
  await logger.close();
  await journal.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
