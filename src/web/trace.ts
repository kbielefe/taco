import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { requestInputs, requestPreview, shouldTraceRequest } from "../mlflow/http.js";
import { createSessionId, readSessionId, SESSION_COOKIE, sessionCookieOptions } from "../mlflow/session.js";
import { traceHttp, tracingEnabled } from "../mlflow/tracing.js";

export const traceRequest: MiddlewareHandler = async (c, next) => {
  if (!shouldTraceRequest(c.req.path) || !tracingEnabled()) {
    await next();
    return;
  }
  const existing = readSessionId(getCookie(c, SESSION_COOKIE));
  const sessionId = existing ?? createSessionId();
  if (!existing) {
    setCookie(c, SESSION_COOKIE, sessionId, sessionCookieOptions(new URL(c.req.url).protocol));
  }
  const body = await readJsonBody(c);
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const response = await traceHttp(
    {
      name: `${c.req.method} ${c.req.path}`,
      inputs: requestInputs(c.req.method, c.req.path, query, body),
      requestPreview: requestPreview(c.req.method, c.req.path, query, body),
      sessionId,
      signal: c.req.raw.signal,
    },
    async () => {
      await next();
      return c.res;
    },
  );
  // The route already finalized c.res. Assigning replaces it; a returned Response would be ignored.
  c.res = response;
};

async function readJsonBody(c: { req: { method: string; header: (name: string) => string | undefined; raw: Request } }): Promise<unknown> {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return undefined;
  }
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("json")) {
    return undefined;
  }
  try {
    const text = await c.req.raw.clone().text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
