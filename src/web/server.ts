import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connectCorrectionRunner } from "../correct/run.js";
import { createJournal } from "../journal/journal.js";
import { createFoodLogger } from "../log/logger.js";
import { PromptBook } from "../mlflow/prompts.js";
import { startMlflow } from "../mlflow/start.js";
import { mongoCatalog } from "../mcp/mongo.js";
import { createApp } from "./routes.js";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

const prompts = new PromptBook();
const mlflow = startMlflow({ prompts });
const logger = await createFoodLogger({ prompts }).catch(async (error: unknown) => {
  await mlflow.shutdown();
  throw error;
});
const journal = await createJournal().catch(async (error: unknown) => {
  await mlflow.shutdown();
  await logger.close();
  throw error;
});
const corrections = await connectCorrectionRunner({ logger, journal }).catch(async (error: unknown) => {
  await mlflow.shutdown();
  await logger.close();
  await journal.close();
  throw error;
});
const healthDb = logger.healthDb();
const app = createApp({
  logger,
  journal,
  corrections,
  prompts,
  ...(healthDb ? { data: mongoCatalog(healthDb) } : {}),
});
corrections.schedule();
await mlflow.ready;

const webDist = join(process.cwd(), "web/dist");
if (existsSync(join(webDist, "index.html"))) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/mcp") {
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
  await mlflow.shutdown();
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
