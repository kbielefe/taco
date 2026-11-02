import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { SERVICE, startTelemetry } from "../otel.js";
import type { ResolvedPrompt } from "./prompts.js";

const PREVIEW_LIMIT = 1_000;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface SpanResult<T> {
  result: T;
  outputs: unknown;
  usage?: TokenUsage;
}

export type MlflowSpanKind = "LLM" | "AGENT" | "CHAIN" | "TOOL" | "RETRIEVER";

export interface MlflowSpanOptions {
  name: string;
  spanType: MlflowSpanKind;
  /**
   * Accepted so call sites can keep their arguments. Not copied onto the span.
   * Traces go to Grafana Cloud, so prompts, meals, and journal text stay off.
   */
  inputs?: unknown;
  links?: ResolvedPrompt[];
  /** Model name for an LLM span. Recorded as gen_ai.request.model. */
  model?: string;
  /** Start a new trace. A correction fit uses this so it does not nest under the journal request. */
  root?: boolean;
}

export interface TraceHttpOptions {
  name: string;
  signal?: AbortSignal;
}

let enabled = false;
let shutdownImpl: (() => Promise<void>) | undefined;

export function tracingEnabled(): boolean {
  return enabled;
}

/** Prefix an operation. Traces share one MLflow experiment, and this service name stays on the resource. */
export function spanName(operation: string): string {
  const prefix = `${SERVICE} `;
  return operation.startsWith(prefix) ? operation : `${prefix}${operation}`;
}

/** Start export to Alloy. Vitest does not call this; tests install their own provider. */
export function startTracing(env: Record<string, string | undefined> = process.env): void {
  if (enabled || env.VITEST) return;
  const telemetry = startTelemetry(env);
  if (!telemetry) return;
  enabled = true;
  shutdownImpl = telemetry.shutdown;
}

/** Tests register a tracer provider, then turn the helpers on. */
export function enableTracing(shutdown: () => Promise<void>): void {
  enabled = true;
  shutdownImpl = shutdown;
}

export async function shutdownTracing(): Promise<void> {
  enabled = false;
  const shutdown = shutdownImpl;
  shutdownImpl = undefined;
  await shutdown?.();
}

/** Clears the tracing flag. Tests use this so a later file does not export spans. */
export async function disableTracing(): Promise<void> {
  await shutdownTracing();
  trace.disable();
  context.disable();
}

export async function withMlflowSpan<T>(options: MlflowSpanOptions, fn: () => Promise<SpanResult<T>>): Promise<T> {
  if (!enabled) {
    return (await fn()).result;
  }
  const attributes: Attributes = { "taco.span_type": options.spanType };
  if (options.spanType === "LLM") {
    attributes["gen_ai.operation.name"] = "chat";
    attributes["gen_ai.provider.name"] = "xai";
    if (options.model) attributes["gen_ai.request.model"] = options.model;
  }
  const run = () =>
    trace.getTracer(SERVICE).startActiveSpan(spanName(options.name), { attributes }, async (span) => {
      try {
        const { result, outputs, usage } = await fn();
        recordUsage(span, usage);
        recordSafe(span, outputs);
        return result;
      } catch (error) {
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  return options.root ? context.with(ROOT_CONTEXT, run) : run();
}

export async function withToolSpan<T>(
  name: string,
  inputs: unknown,
  run: () => Promise<T>,
  outputs: (result: T) => unknown,
): Promise<T> {
  return withMlflowSpan({ name, spanType: "TOOL", inputs }, async () => {
    const result = await run();
    return { result, outputs: outputs(result) };
  });
}

/**
 * One root span for an HTTP request. The response is returned as soon as the
 * handler produces it. The span stays open until the body has finished, so a
 * streamed meal log or ask stays inside this trace. The body text is not recorded.
 */
export async function traceHttp(options: TraceHttpOptions, handler: () => Promise<Response>): Promise<Response> {
  if (!enabled) {
    return handler();
  }
  const span = trace.getTracer(SERVICE).startSpan(spanName(options.name), {
    attributes: { "taco.span_type": "CHAIN", ...httpFields(options.name) },
  });
  const parent = trace.setSpan(context.active(), span);
  return context.with(parent, async () => {
    let response: Response;
    try {
      response = await handler();
    } catch (error) {
      recordError(span, error);
      span.end();
      throw error;
    }
    const held = holdUntilBody(response, options.signal);
    const active = context.active();
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      context.with(active, () => {
        if (error) {
          recordError(span, error);
          span.end();
          return;
        }
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      });
    };
    void held.done.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
    return held.response;
  });
}

/** Split a response so the caller can read it while `done` waits for the body to end. */
export function holdUntilBody(response: Response, signal?: AbortSignal): { response: Response; done: Promise<string> } {
  if (!response.body) {
    return { response, done: Promise.resolve("") };
  }
  const [clientBody, drainBody] = response.body.tee();
  return {
    response: new Response(clientBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    done: drainPreview(drainBody, signal),
  };
}

function recordUsage(span: Span, usage: TokenUsage | undefined): void {
  if (!usage) return;
  span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
  span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
  span.setAttribute("gen_ai.usage.total_tokens", usage.total_tokens);
}

/** Cache and ok are operational. Food, prompts, and answers are not. */
function recordSafe(span: Span, outputs: unknown): void {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return;
  const record = outputs as Record<string, unknown>;
  if (record.cache === "hit" || record.cache === "miss" || record.cache === "inflight") {
    span.setAttribute("taco.cache", record.cache);
  }
  if (typeof record.ok === "boolean") {
    span.setAttribute("taco.ok", record.ok);
  }
}

function httpFields(name: string): Attributes {
  const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\S+)$/.exec(name);
  const method = match?.[1];
  const path = match?.[2];
  if (!method || !path) return {};
  return { "http.request.method": method, "url.path": path };
}

function recordError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : "Request failed";
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 200) });
}

function drainPreview(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let preview = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(preview.slice(0, PREVIEW_LIMIT));
    };
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      finish();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const pump = async (): Promise<void> => {
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) {
            preview += decoder.decode();
            finish();
            return;
          }
          if (preview.length < PREVIEW_LIMIT) {
            preview += decoder.decode(value, { stream: true });
          }
        }
      } catch {
        finish();
      }
    };
    void pump();
  });
}
