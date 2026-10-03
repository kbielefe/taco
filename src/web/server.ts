import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connectCorrectionRunner } from "../correct/run.js";
import { createJournal } from "../journal/journal.js";
import { createFoodLogger } from "../log/logger.js";
import { mongoCatalog } from "../mcp/mongo.js";
import { alexaConfigured } from "../alexa/oauth.js";
import { googleConfigured } from "../auth/google.js";
import { MongoOauthStore } from "../auth/store.js";
import { createApp } from "./routes.js";

function fail(message: string): never {
  throw new Error(message);
}

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

const logger = await createFoodLogger();
const journal = await createJournal().catch(async (error: unknown) => {
  await logger.close();
  throw error;
});
const corrections = await connectCorrectionRunner({ logger, journal }).catch(async (error: unknown) => {
  await logger.close();
  await journal.close();
  throw error;
});
const healthDb = logger.healthDb();
const google = googleConfigured(process.env);
const alexa = alexaConfigured(process.env);
const oauth = google || alexa ? new MongoOauthStore(healthDb ?? fail("MONGODB_URI is required for login")) : undefined;
if (oauth) {
  await oauth.ensureIndexes();
}
const app = createApp({
  logger,
  journal,
  corrections,
  ...(healthDb ? { data: mongoCatalog(healthDb) } : {}),
  ...(oauth ? { login: { store: oauth, ...(google ? { google } : {}), ...(alexa ? { alexa } : {}) } } : {}),
});
corrections.schedule();

const webDist = join(process.cwd(), "web/dist");
if (existsSync(join(webDist, "index.html"))) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/mcp" || c.req.path.startsWith("/oauth")) {
      return next();
    }
    return serveStatic({ path: "./web/dist/index.html" })(c, next);
  });
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Food log: http://${hostname}:${info.port}`);
  if (healthDb) {
    console.log(`Data MCP: http://${hostname}:${info.port}/mcp`);
  }
});

async function shutdown() {
  server.close();
  await corrections.close();
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
