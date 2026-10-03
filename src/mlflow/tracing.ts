import { context, ROOT_CONTEXT, trace, type Span as OtelSpan } from "@opentelemetry/api";
import type { ResolvedPrompt } from "./prompts.js";

const LINKED_PROMPTS = "mlflow.linkedPrompts";
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
  inputs: unknown;
  links?: ResolvedPrompt[];
  /** Start a new trace. A correction fit uses this so it does not nest under the journal request. */
  root?: boolean;
}

export interface TraceHttpOptions {
  name: string;
  inputs: unknown;
  requestPreview: string;
  sessionId?: string;
  signal?: AbortSignal;
}

interface SpanLike {
  setOutputs(outputs: unknown): void;
  setAttribute(key: string, value: unknown): void;
}

interface RequestSpan extends SpanLike {
  _span?: OtelSpan;
  setStatus(status: string, description?: string): void;
  recordException(error: Error): void;
  end(): void;
}

let sdk: typeof import("@mlflow/core") | undefined;

export function tracingEnabled(): boolean {
  return sdk !== undefined;
}

/** Start tracing. The SDK is imported only after this is called, so tests do not start OpenTelemetry. */
export async function startTracing(trackingUri: string, experimentId: string): Promise<void> {
  sdk = await loadCore();
  sdk.init({ trackingUri, experimentId });
}

export async function flushTracing(): Promise<void> {
  if (!sdk) {
    return;
  }
  await sdk.flushTraces();
}

/** Clears the tracing flag. Tests use this so a later file does not export spans. */
export function disableTracing(): void {
  sdk = undefined;
}

export async function withMlflowSpan<T>(options: MlflowSpanOptions, fn: () => Promise<SpanResult<T>>): Promise<T> {
  if (!sdk) {
    return (await fn()).result;
  }
  const mlflow = sdk;
  const links = (options.links ?? [])
    .filter((link): link is ResolvedPrompt & { version: string } => typeof link.version === "string")
    .map((link) => ({ name: link.name, version: link.version }));
  const tags = links.length > 0 ? { [LINKED_PROMPTS]: JSON.stringify(links) } : undefined;
  const run = () =>
    mlflow.withSpan(
      async (span: SpanLike) => {
        if (tags) {
          mlflow.updateCurrentTrace({ tags });
          span.setAttribute(LINKED_PROMPTS, tags[LINKED_PROMPTS]);
        }
        const { result, outputs, usage } = await fn();
        span.setOutputs(outputs);
        if (usage) {
          span.setAttribute(mlflow.SpanAttributeKey.TOKEN_USAGE, usage);
        }
        if (options.spanType === "LLM") {
          span.setAttribute(mlflow.SpanAttributeKey.MESSAGE_FORMAT, "openai");
        }
        return result;
      },
      { name: options.name, spanType: mlflow.SpanType[options.spanType], inputs: options.inputs },
    );
  const start = () => (options.root ? context.with(ROOT_CONTEXT, run) : run());
  if (!tags) {
    return start();
  }
  return mlflow.tracingContext({ tags }, start);
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
 * streamed meal log or ask stays inside this trace.
 */
export async function traceHttp(options: TraceHttpOptions, handler: () => Promise<Response>): Promise<Response> {
  if (!sdk) {
    return handler();
  }
  const mlflow = sdk;
  const span = mlflow.startSpan({
    name: options.name,
    spanType: mlflow.SpanType.CHAIN,
    inputs: options.inputs,
  }) as RequestSpan;
  const otelSpan = span._span;
  if (!otelSpan) {
    return handler();
  }
  const parent = trace.setSpan(context.active(), otelSpan);
  return context.with(parent, async () => {
    mlflow.updateCurrentTrace({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      requestPreview: options.requestPreview,
    });
    let response: Response;
    try {
      response = await handler();
    } catch (error) {
      failSpan(span, error);
      throw error;
    }
    const held = holdUntilBody(response, options.signal);
    const active = context.active();
    let finished = false;
    const finish = (body: string, error?: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      context.with(active, () => {
        if (error) {
          failSpan(span, error);
          return;
        }
        const text = body.slice(0, PREVIEW_LIMIT);
        const preview = `${response.status} ${text}`.trim().slice(0, PREVIEW_LIMIT);
        mlflow.updateCurrentTrace({ responsePreview: preview });
        span.setOutputs({ status: response.status, body: text });
        span.end();
      });
    };
    void held.done.then(
      (body) => finish(body),
      (error: unknown) => finish("", error),
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

function drainPreview(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let preview = "";
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
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

function failSpan(span: RequestSpan, error: unknown): void {
  const message = error instanceof Error ? error.message : "Request failed";
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus("ERROR", message);
  span.end();
}

async function loadCore(): Promise<typeof import("@mlflow/core")> {
  return import("@mlflow/core");
}
