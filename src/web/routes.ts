import { Hono } from "hono";
import { stream } from "hono/streaming";
import { FoodLogAiError, FoodLogConfigError, FoodLogMatchError } from "../log/errors.js";
import type { FoodLogger } from "../log/logger.js";
import { sumMacros } from "../log/nutrients.js";
import { parseIsoDate, serializeMeal } from "./serialize.js";

function publicErrorMessage(error: unknown): { message: string; status: 400 | 422 | 500 | 503 } {
  if (error instanceof FoodLogConfigError && /query is required/i.test(error.message)) {
    return { message: "Enter what you ate", status: 400 };
  }
  if (error instanceof FoodLogConfigError && /XAI_API_KEY/i.test(error.message)) {
    return { message: "Couldn't look that up. Set XAI_API_KEY in .env.", status: 503 };
  }
  if (error instanceof FoodLogMatchError) {
    return { message: "Couldn't match that meal. Try a simpler description.", status: 422 };
  }
  if (error instanceof FoodLogAiError) {
    return { message: "Couldn't understand that meal. Try again in a moment.", status: 422 };
  }
  return { message: "Something went wrong. Try again.", status: 500 };
}

export function createApp(logger: FoodLogger): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    console.error(error);
    const mapped = publicErrorMessage(error);
    return c.json({ error: { message: mapped.message } }, mapped.status);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/meals", async (c) => {
    const from = parseIsoDate(c.req.query("from"));
    const to = parseIsoDate(c.req.query("to"));
    if (!from || !to) {
      return c.json({ error: { message: "from and to are required ISO dates" } }, 400);
    }
    const meals = await logger.list(from, to);
    return c.json({
      meals: meals.map(serializeMeal),
      totals: sumMacros(meals.map((meal) => meal.macros)),
    });
  });

  app.post("/api/meals", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Enter what you ate" } }, 400);
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const query = typeof record.query === "string" ? record.query : "";
    const eatenAt = typeof record.eatenAt === "string" ? parseIsoDate(record.eatenAt) : undefined;
    const logOptions = eatenAt ? { eatenAt } : {};

    if (!wantsProgressStream(c.req.header("accept"))) {
      try {
        const entry = await logger.log(query, logOptions);
        return c.json(serializeMeal(entry), 201);
      } catch (error) {
        const mapped = publicErrorMessage(error);
        if (mapped.status === 500) {
          throw error;
        }
        return c.json({ error: { message: mapped.message } }, mapped.status);
      }
    }

    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (out) => {
      try {
        const entry = await logger.log(query, {
          ...logOptions,
          onProgress: async (message) => {
            await out.writeln(JSON.stringify({ type: "progress", message }));
          },
        });
        await out.writeln(JSON.stringify({ type: "result", meal: serializeMeal(entry) }));
      } catch (error) {
        const mapped = publicErrorMessage(error);
        if (mapped.status === 500) {
          console.error(error);
        }
        await out.writeln(JSON.stringify({ type: "error", error: { message: mapped.message }, status: mapped.status }));
      }
    });
  });

  app.delete("/api/meals/:id", async (c) => {
    const deleted = await logger.delete(c.req.param("id"));
    if (!deleted) {
      return c.body(null, 404);
    }
    return c.body(null, 204);
  });

  app.get("/api/suggestions", async (c) => {
    const suggestions = await logger.suggest(c.req.query("q") ?? "");
    return c.json({ suggestions });
  });

  return app;
}

function wantsProgressStream(accept: string | undefined): boolean {
  return (accept ?? "").includes("application/x-ndjson");
}
