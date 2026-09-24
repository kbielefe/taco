import type { DataCatalog } from "./catalog.js";
import { callTool, listTools } from "./tools.js";

const SERVER_NAME = "health-tracker";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const INSTRUCTIONS = [
  "Read-only access to the health database, in the style of the MongoDB MCP server's read tools.",
  "Collections are food (logged meals), observations (journal entries), and kinds (the journal schema those entries point at).",
  "food: eatenAt, query, description, macros {caloriesKcal, proteinG, fatG, carbG, fiberG}, items[] {name, fdcId, description, dataType, grams, servingDescription, macros}, createdAt. macros are the logged amounts.",
  "observations: at, kindId, values[] {fieldId, value}, createdAt. kinds: label, nameKey, fields[] {id, label, type, unit?, options?}, createdAt. values[].fieldId matches fields[].id.",
  'Dates and ObjectIds are Extended JSON: {"$date":"<ISO-8601>"} and {"$oid":"<24 hex chars>"}.',
  "Writes, joins to other collections ($lookup, $unionWith, $graphLookup, $out, $merge), and server-side JavaScript ($where, $function, $accumulator) are rejected.",
].join(" ");

export async function handleMcpRequest(request: Request, catalog: DataCatalog): Promise<Response> {
  if (!originAllowed(request)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)) {
    return rpcResponse(null, { code: -32600, message: `Unsupported MCP-Protocol-Version ${protocolHeader}.` }, 400, false);
  }
  const accept = request.headers.get("accept");
  if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream")) {
    return new Response("Accept must include application/json or text/event-stream", { status: 406 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcResponse(null, { code: -32700, message: "Parse error" }, 400, false);
  }
  if (Array.isArray(body) || !isRecord(body) || body.jsonrpc !== "2.0") {
    return rpcResponse(null, { code: -32600, message: "Invalid Request" }, 400, false);
  }
  if (typeof body.method !== "string") {
    if ("result" in body || "error" in body) {
      return new Response(null, { status: 202 });
    }
    return rpcResponse(null, { code: -32600, message: "Invalid Request" }, 400, false);
  }

  const id = body.id;
  const hasId = Object.prototype.hasOwnProperty.call(body, "id");
  if (!hasId) {
    return new Response(null, { status: 202 });
  }

  const sse = accept !== null && accept.includes("text/event-stream") && !accept.includes("application/json");
  try {
    const result = await dispatch(body.method, body.params, catalog);
    return rpcResponse(id, result, 200, sse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const code = error instanceof McpMethodError ? error.code : -32603;
    return rpcResponse(id, { code, message }, 200, sse);
  }
}

class McpMethodError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "McpMethodError";
  }
}

async function dispatch(method: string, params: unknown, catalog: DataCatalog): Promise<unknown> {
  switch (method) {
    case "initialize":
      return initializeResult(params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: listTools() };
    case "tools/call":
      return callNamedTool(params, catalog);
    default:
      throw new McpMethodError(`Method not found: ${method}`, -32601);
  }
}

function initializeResult(params: unknown): unknown {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  const protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

async function callNamedTool(params: unknown, catalog: DataCatalog): Promise<unknown> {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new McpMethodError("tools/call requires a tool name.", -32602);
  }
  return callTool(params.name, params.arguments, catalog);
}

function rpcResponse(id: unknown, payload: unknown, status: number, sse: boolean): Response {
  const error = isErrorPayload(payload);
  const message = {
    jsonrpc: "2.0",
    id,
    ...(error ? { error: payload } : { result: payload }),
  };
  if (sse) {
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json(message, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isErrorPayload(payload: unknown): payload is { code: number; message: string } {
  return isRecord(payload) && typeof payload.code === "number" && typeof payload.message === "string" && !("content" in payload);
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const hostHeader = request.headers.get("host");
  if (!hostHeader) {
    return isLoopback(originHost);
  }
  const hostName = hostHeader
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "");
  if (isLoopback(hostName)) {
    return isLoopback(originHost);
  }
  return originHost === hostName;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
