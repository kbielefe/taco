import type { ResolvedPrompt } from "./prompts.js";

const LINKED_PROMPTS = "mlflow.linkedPrompts";

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

export interface MlflowSpanOptions {
  name: string;
  spanType: "LLM" | "AGENT";
  inputs: unknown;
  links?: ResolvedPrompt[];
}

interface SpanLike {
  setOutputs(outputs: unknown): void;
  setAttribute(key: string, value: unknown): void;
}

let started = false;

export function tracingEnabled(): boolean {
  return started;
}

/** Start tracing. The SDK is imported only after this is called, so tests do not start OpenTelemetry. */
export async function startTracing(trackingUri: string, experimentId: string): Promise<void> {
  const mlflow = await loadCore();
  mlflow.init({ trackingUri, experimentId });
  started = true;
}

export async function flushTracing(): Promise<void> {
  if (!started) {
    return;
  }
  const mlflow = await loadCore();
  await mlflow.flushTraces();
}

export async function withMlflowSpan<T>(options: MlflowSpanOptions, fn: () => Promise<SpanResult<T>>): Promise<T> {
  if (!started) {
    return (await fn()).result;
  }
  const mlflow = await loadCore();
  const links = (options.links ?? [])
    .filter((link): link is ResolvedPrompt & { version: string } => typeof link.version === "string")
    .map((link) => ({ name: link.name, version: link.version }));
  const tags = links.length > 0 ? { [LINKED_PROMPTS]: JSON.stringify(links) } : undefined;
  const spanType = options.spanType === "LLM" ? mlflow.SpanType.LLM : mlflow.SpanType.AGENT;
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
      { name: options.name, spanType, inputs: options.inputs },
    );
  if (!tags) {
    return run();
  }
  return mlflow.tracingContext({ tags }, run);
}

async function loadCore(): Promise<typeof import("@mlflow/core")> {
  return import("@mlflow/core");
}
