import { NodeSDK } from "@opentelemetry/sdk-node";

const HTTP_PROTOCOLS = new Set(["http/protobuf", "http"]);

export const SERVICE = "taco";

export interface TelemetryTarget {
  serviceName: string;
  endpoint: string;
  protocol: string;
}

let started = false;
let shutdownFn: (() => Promise<void>) | undefined;

/**
 * Point unset OpenTelemetry settings at Alloy's OTLP HTTP receiver.
 * `OTEL_SDK_DISABLED=true` leaves telemetry off. An explicit endpoint is kept.
 * The default host is 127.0.0.1. A container must set `host.containers.internal` itself.
 */
export function resolveTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
): TelemetryTarget | undefined {
  if (env.OTEL_SDK_DISABLED === "true" || env.VITEST) return undefined;
  const protocol = (env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf").trim() || "http/protobuf";
  if (!HTTP_PROTOCOLS.has(protocol) && protocol !== "grpc") return undefined;
  env.OTEL_SERVICE_NAME ??= SERVICE;
  env.OTEL_EXPORTER_OTLP_PROTOCOL ??= protocol;
  env.OTEL_TRACES_SAMPLER ??= "parentbased_always_on";
  if (protocol === "grpc") env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4317";
  else env.OTEL_EXPORTER_OTLP_ENDPOINT ??= "http://127.0.0.1:4318";
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT.trim();
  if (endpoint === "") return undefined;
  return { serviceName: env.OTEL_SERVICE_NAME, endpoint, protocol };
}

/** Start OTLP export. Safe to call once. No automatic HTTP instrumentation, so request bodies stay off the trace. */
export function startTelemetry(
  env: Record<string, string | undefined> = process.env,
): { shutdown: () => Promise<void> } | undefined {
  if (started) return shutdownFn ? { shutdown: shutdownFn } : undefined;
  const target = resolveTelemetryEnv(env);
  if (!target) {
    console.log("OpenTelemetry off");
    return undefined;
  }
  const sdk = new NodeSDK({ instrumentations: [] });
  sdk.start();
  started = true;
  shutdownFn = () => sdk.shutdown();
  console.log(`OpenTelemetry on (${target.serviceName} → ${target.endpoint})`);
  return { shutdown: shutdownFn };
}
