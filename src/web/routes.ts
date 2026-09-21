import { Hono } from "hono";
import { stream } from "hono/streaming";
import { JournalConflictError, JournalNotFoundError, JournalValidationError } from "../journal/errors.js";
import type { Journal } from "../journal/journal.js";
import { FoodLogAiError, FoodLogConfigError, FoodLogMatchError } from "../log/errors.js";
import type { FoodLogger } from "../log/logger.js";
import { sumMacros } from "../log/nutrients.js";
import { parseIsoDate, serializeKind, serializeMeal, serializeObservation } from "./serialize.js";

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

export interface AppDeps {
  logger: FoodLogger;
  journal: Journal;
}

export function createApp({ logger, journal }: AppDeps): Hono {
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

  app.get("/api/journal/kinds", async (c) => {
    const kinds = await journal.kinds();
    return c.json({ kinds: kinds.map(serializeKind) });
  });

  app.post("/api/journal/kinds/:id", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return c.json({ error: { message: "Nothing to add." } }, 400);
    }
    try {
      await journal.append(c.req.param("id"), { addFields: body.addFields, addOptions: body.addOptions });
      const kinds = await journal.kinds();
      const view = kinds.find((item) => item.kind._id.toHexString() === c.req.param("id"));
      if (!view) {
        return c.json({ error: { message: "That kind wasn't found." } }, 404);
      }
      return c.json(serializeKind(view));
    } catch (error) {
      const mapped = journalHttpError(error);
      if (!mapped) {
        throw error;
      }
      return c.json({ error: { message: mapped.message } }, mapped.status);
    }
  });

  app.get("/api/journal", async (c) => {
    const from = parseIsoDate(c.req.query("from"));
    const to = parseIsoDate(c.req.query("to"));
    if (!from || !to) {
      return c.json({ error: { message: "from and to are required ISO dates" } }, 400);
    }
    const observations = await journal.list(from, to);
    return c.json({ observations: observations.map(serializeObservation) });
  });

  app.post("/api/journal", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return c.json({ error: { message: "Choose what you're recording." } }, 400);
    }
    let at: Date | undefined;
    if (body.at !== undefined) {
      if (typeof body.at !== "string") {
        return c.json({ error: { message: "That time isn't valid." } }, 400);
      }
      at = parseIsoDate(body.at);
      if (!at) {
        return c.json({ error: { message: "That time isn't valid." } }, 400);
      }
    }
    const kindId = typeof body.kindId === "string" && body.kindId ? body.kindId : undefined;
    const kind = kindId ? undefined : readKind(body.kind);
    try {
      const view = await journal.log({
        ...(kindId ? { kindId } : {}),
        ...(kind ? { kind } : {}),
        ...(at ? { at } : {}),
        values: body.values,
      });
      return c.json(serializeObservation(view), 201);
    } catch (error) {
      const mapped = journalHttpError(error);
      if (!mapped) {
        throw error;
      }
      return c.json({ error: { message: mapped.message } }, mapped.status);
    }
  });

  app.delete("/api/journal/:id", async (c) => {
    const deleted = await journal.delete(c.req.param("id"));
    if (!deleted) {
      return c.body(null, 404);
    }
    return c.body(null, 204);
  });

  return app;
}

function journalHttpError(error: unknown): { message: string; status: 400 | 404 | 409 } | undefined {
  if (error instanceof JournalValidationError) {
    return { message: error.message, status: 400 };
  }
  if (error instanceof JournalNotFoundError) {
    return { message: error.message, status: 404 };
  }
  if (error instanceof JournalConflictError) {
    return { message: error.message, status: 409 };
  }
  return undefined;
}

function readKind(raw: unknown): { label: unknown; fields: unknown } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return { label: record.label, fields: record.fields };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return undefined;
    }
    return body as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function wantsProgressStream(accept: string | undefined): boolean {
  return (accept ?? "").includes("application/x-ndjson");
}
