import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { shouldTraceRequest } from "../mlflow/http.js";
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
  const response = await traceHttp(
    {
      name: `${c.req.method} ${c.req.path}`,
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
