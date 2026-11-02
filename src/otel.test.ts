import { describe, expect, it } from "vitest";
import { resolveTelemetryEnv, SERVICE } from "./otel.js";

function env(values: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...values };
}

describe("resolveTelemetryEnv", () => {
  it("points an empty environment at Alloy over HTTP", () => {
    const values = env();
    const target = resolveTelemetryEnv(values);
    expect(target).toEqual({
      serviceName: SERVICE,
      endpoint: "http://127.0.0.1:4318",
      protocol: "http/protobuf",
    });
    expect(values.OTEL_TRACES_SAMPLER).toBe("parentbased_always_on");
  });

  it("keeps an explicit endpoint and fills the sampler", () => {
    const values = env({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://host.containers.internal:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_SERVICE_NAME: "taco",
    });
    expect(resolveTelemetryEnv(values)?.endpoint).toBe("http://host.containers.internal:4318");
    expect(values.OTEL_TRACES_SAMPLER).toBe("parentbased_always_on");
  });

  it("stays off when the SDK is disabled or Vitest is running", () => {
    expect(resolveTelemetryEnv(env({ OTEL_SDK_DISABLED: "true" }))).toBeUndefined();
    expect(resolveTelemetryEnv(env({ VITEST: "true" }))).toBeUndefined();
  });

  it("rejects a protocol this process does not speak", () => {
    const values = env({ OTEL_EXPORTER_OTLP_PROTOCOL: "websocket" });
    expect(resolveTelemetryEnv(values)).toBeUndefined();
    expect(values.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });
});
