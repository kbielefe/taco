import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { beginGoogleLogin, finishGoogleLogin, type GoogleConfig } from "../auth/google.js";
import { createSession, readSession, SESSION_COOKIE, sessionCookie } from "../auth/session.js";
import type { OauthStore } from "../auth/store.js";
import {
  amazonRedirectAllowed,
  createLinkCode,
  exchangeLinkCode,
  redeemAuthorizationCode,
  redeemRefreshToken,
  secretsMatch,
  type AlexaClientConfig,
} from "../alexa/oauth.js";

export interface LoginDeps {
  google?: GoogleConfig;
  alexa?: AlexaClientConfig;
  store: OauthStore;
  fetchImpl?: typeof fetch;
}

export function publicPath(path: string, method: string): boolean {
  if (method === "GET" && (path === "/api/health" || path === "/login" || path === "/oauth/google/callback")) {
    return true;
  }
  if (path === "/oauth/authorize" || path === "/taco_icon.svg" || path === "/background.jpg" || path.startsWith("/assets/")) {
    return true;
  }
  if (method === "POST" && (path === "/oauth/token" || path === "/api/alexa")) {
    return true;
  }
  return false;
}

export function mountLogin(hono: Hono, deps: LoginDeps | undefined, alexaEnabled: boolean): void {
  hono.use("*", async (c, next) => {
    if (!deps?.google) {
      return next();
    }
    if (publicPath(c.req.path, c.req.method)) {
      return next();
    }
    const session = await readSession(deps.store, getCookie(c, SESSION_COOKIE));
    if (session) {
      return next();
    }
    if (c.req.path.startsWith("/api") || c.req.path === "/mcp") {
      return c.json({ error: { message: "Sign in." } }, 401);
    }
    return c.redirect("/login");
  });

  hono.get("/api/session", async (c) => {
    if (!deps?.google) {
      return c.json({ auth: false, alexa: alexaEnabled });
    }
    const session = await readSession(deps.store, getCookie(c, SESSION_COOKIE));
    if (!session?.email) {
      return c.json({ error: { message: "Sign in." } }, 401);
    }
    return c.json({ auth: true, email: session.email, alexa: alexaEnabled });
  });

  if (!deps?.google) {
    return;
  }
  const google = deps.google;

  hono.get("/login", async (c) => {
    const redirectUri = callbackUrl(c);
    const url = await beginGoogleLogin(deps.store, google, redirectUri);
    return c.redirect(url);
  });

  hono.get("/oauth/google/callback", async (c) => {
    const result = await finishGoogleLogin({
      store: deps.store,
      config: google,
      code: c.req.query("code") ?? "",
      state: c.req.query("state") ?? "",
      redirectUri: callbackUrl(c),
      fetchImpl: deps.fetchImpl,
    });
    if (!result.ok) {
      return c.text(result.message, 403);
    }
    const id = await createSession(deps.store, result.email);
    c.header("Set-Cookie", sessionCookie(id, new URL(c.req.url).protocol === "https:"));
    return c.redirect("/");
  });

  hono.get("/api/alexa/link-code", async (c) => {
    if (!deps.alexa) {
      return c.json({ error: { message: "Alexa is not configured." } }, 404);
    }
    const session = await readSession(deps.store, getCookie(c, SESSION_COOKIE));
    if (!session?.email) {
      return c.json({ error: { message: "Sign in." } }, 401);
    }
    const code = await createLinkCode(deps.store, session.email);
    return c.json({ code });
  });

  mountAlexaOAuth(hono, deps);
}

function mountAlexaOAuth(hono: Hono, deps: LoginDeps): void {
  hono.get("/oauth/authorize", (c) => {
    if (!deps.alexa) {
      return c.text("Alexa is not configured.", 404);
    }
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const state = c.req.query("state") ?? "";
    const clientId = c.req.query("client_id") ?? "";
    if (c.req.query("response_type") !== "code" || clientId !== deps.alexa.clientId || !amazonRedirectAllowed(redirectUri)) {
      return c.text("That Alexa link request is not valid.", 400);
    }
    return c.html(authorizePage(clientId, redirectUri, state));
  });

  hono.post("/oauth/authorize", async (c) => {
    if (!deps.alexa) {
      return c.text("Alexa is not configured.", 404);
    }
    const form = await c.req.parseBody();
    const redirectUri = stringField(form.redirect_uri);
    const state = stringField(form.state);
    const clientId = stringField(form.client_id);
    const linkCode = stringField(form.code);
    if (clientId !== deps.alexa.clientId || !amazonRedirectAllowed(redirectUri)) {
      return c.text("That Alexa link request is not valid.", 400);
    }
    const code = await exchangeLinkCode({ store: deps.store, linkCode, clientId, redirectUri });
    if (!code) {
      return c.html(authorizePage(clientId, redirectUri, state, "That code is expired or wrong."), 400);
    }
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    return c.redirect(target.toString());
  });

  hono.post("/oauth/token", async (c) => {
    if (!deps.alexa) {
      return c.json({ error: "invalid_client" }, 401);
    }
    const form = await c.req.parseBody();
    const basic = basicClient(c.req.header("authorization"));
    const clientId = stringField(form.client_id) || basic.id;
    const clientSecret = stringField(form.client_secret) || basic.secret;
    if (!secretsMatch(clientId, deps.alexa.clientId) || !secretsMatch(clientSecret, deps.alexa.clientSecret)) {
      return c.json({ error: "invalid_client" }, 401);
    }
    const grant = stringField(form.grant_type);
    const tokens =
      grant === "authorization_code"
        ? await redeemAuthorizationCode({
            store: deps.store,
            code: stringField(form.code),
            clientId,
            redirectUri: stringField(form.redirect_uri),
          })
        : grant === "refresh_token"
          ? await redeemRefreshToken({ store: deps.store, refreshToken: stringField(form.refresh_token), clientId })
          : undefined;
    if (!tokens) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    return c.json(tokens);
  });
}

function callbackUrl(c: Context): string {
  return new URL("/oauth/google/callback", c.req.url).href;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function basicClient(header: string | undefined): { id: string; secret: string } {
  if (!header?.startsWith("Basic ")) {
    return { id: "", secret: "" };
  }
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) {
    return { id: "", secret: "" };
  }
  return { id: decoded.slice(0, split), secret: decoded.slice(split + 1) };
}

function authorizePage(clientId: string, redirectUri: string, state: string, error?: string): string {
  const message = error ? `<p>${escapeHtml(error)}</p>` : "<p>Enter the code from the Taco website.</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link Taco</title></head>
<body>
  <h1>Link Taco to Alexa</h1>
  ${message}
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <label>Code <input name="code" autocomplete="one-time-code" required></label>
    <button type="submit">Link</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
