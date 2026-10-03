import { describe, expect, it } from "vitest";
import { IS_PROMPT_TAG, MlflowClient, PROMPT_SOURCE, PROMPT_TEXT_TAG, PROMPT_TYPE_TAG, PRODUCTION_ALIAS } from "./client.js";
import { PROMPT, promptTemplate, publishPrompt } from "./prompts.js";

interface StoredVersion {
  version: string;
  template: string;
  description: string;
  tags: Array<{ key: string; value: string }>;
}

function registry() {
  const prompts = new Map<string, { versions: StoredVersion[]; alias?: string }>();
  let experimentId: string | undefined;
  const calls: string[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname;
    calls.push(`${method} ${path}`);

    if (method === "GET" && path.endsWith("/experiments/get-by-name")) {
      if (!experimentId || url.searchParams.get("experiment_name") !== "taco") {
        return json(404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "missing" });
      }
      return json(200, { experiment: { experiment_id: experimentId, name: "taco" } });
    }
    if (method === "POST" && path.endsWith("/experiments/create")) {
      experimentId = "7";
      return json(200, { experiment_id: experimentId });
    }
    if (method === "GET" && path.endsWith("/registered-models/get")) {
      const name = url.searchParams.get("name") ?? "";
      if (!prompts.has(name)) {
        return json(404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "missing" });
      }
      return json(200, { registered_model: { name } });
    }
    if (method === "POST" && path.endsWith("/registered-models/create")) {
      const name = String(body.name);
      prompts.set(name, { versions: [] });
      return json(200, { registered_model: { name } });
    }
    if (method === "GET" && path.endsWith("/model-versions/search")) {
      const filter = url.searchParams.get("filter") ?? "";
      const name = filter.match(/name = '([^']+)'/)?.[1] ?? "";
      // The server omits prompts unless the filter includes the prompt tag.
      const versions = filter.includes(`tag.\`${IS_PROMPT_TAG}\` = 'true'`) ? (prompts.get(name)?.versions ?? []) : [];
      return json(200, {
        model_versions: versions.map((version) => ({
          name,
          version: version.version,
          tags: version.tags,
        })),
      });
    }
    if (method === "POST" && path.endsWith("/model-versions/create")) {
      const name = String(body.name);
      const record = prompts.get(name);
      if (!record) {
        return json(404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "missing" });
      }
      const tags = body.tags as Array<{ key: string; value: string }>;
      const template = tags.find((tag) => tag.key === PROMPT_TEXT_TAG)?.value ?? "";
      const version = String(record.versions.length + 1);
      record.versions.push({ version, template, description: String(body.description), tags });
      return json(200, { model_version: { name, version, source: body.source, tags } });
    }
    if (method === "POST" && path.endsWith("/registered-models/alias")) {
      const name = String(body.name);
      const record = prompts.get(name);
      if (!record) {
        return json(404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "missing" });
      }
      record.alias = String(body.version);
      return json(200, {});
    }
    return json(500, { message: `unexpected ${method} ${path}` });
  };

  return { fetchImpl, prompts, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientFor(fetchImpl: typeof fetch): MlflowClient {
  return new MlflowClient({ trackingUri: "http://mlflow.test", fetch: fetchImpl });
}

describe("MLflow prompt registry", () => {
  it("creates version 1 and the production alias", async () => {
    const store = registry();
    const client = clientFor(store.fetchImpl);
    const version = await publishPrompt(client, PROMPT.parse, { model: "grok-4.7", reasoningEffort: "low" });
    expect(version).toBe("1");
    const stored = store.prompts.get(PROMPT.parse);
    expect(stored?.alias).toBe("1");
    expect(stored?.versions).toHaveLength(1);
    const tags = stored?.versions[0]?.tags ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: IS_PROMPT_TAG, value: "true" },
        { key: PROMPT_TEXT_TAG, value: promptTemplate(PROMPT.parse) },
        { key: PROMPT_TYPE_TAG, value: "text" },
        { key: "model", value: "grok-4.7" },
        { key: "reasoning_effort", value: "low" },
      ]),
    );
    expect(stored?.versions[0]?.description).toMatch(/^template [0-9a-f]{12}$/);
    const create = store.calls.filter((call) => call.endsWith("/model-versions/create"));
    expect(create).toHaveLength(1);
    expect(store.calls.some((call) => call.endsWith("/registered-models/alias"))).toBe(true);
  });

  it("does not create another version when the template is unchanged", async () => {
    const store = registry();
    const client = clientFor(store.fetchImpl);
    await publishPrompt(client, PROMPT.match, { model: "grok-4.7", reasoningEffort: "low" });
    const again = await publishPrompt(client, PROMPT.match, { model: "grok-4.7", reasoningEffort: "low" });
    expect(again).toBe("1");
    expect(store.prompts.get(PROMPT.match)?.versions).toHaveLength(1);
    expect(store.prompts.get(PROMPT.match)?.alias).toBe("1");
    expect(store.calls.filter((call) => call.endsWith("/model-versions/create"))).toHaveLength(1);
  });

  it("creates the next version and moves the alias when the template changes", async () => {
    const store = registry();
    const client = clientFor(store.fetchImpl);
    await publishPrompt(client, PROMPT.parse, { model: "grok-4.7", reasoningEffort: "low" });
    const stored = store.prompts.get(PROMPT.parse);
    if (!stored?.versions[0]) {
      throw new Error("missing version");
    }
    stored.versions[0].template = "older prompt";
    stored.versions[0].tags = stored.versions[0].tags.map((tag) =>
      tag.key === PROMPT_TEXT_TAG ? { key: tag.key, value: "older prompt" } : tag,
    );
    const version = await publishPrompt(client, PROMPT.parse, { model: "grok-4.7", reasoningEffort: "medium" });
    expect(version).toBe("2");
    expect(stored.alias).toBe("2");
    expect(stored.versions[1]?.template).toBe(promptTemplate(PROMPT.parse));
    expect(stored.versions).toHaveLength(2);
  });

  it("stores the prompt source the registry requires", async () => {
    const store = registry();
    const client = clientFor(store.fetchImpl);
    await publishPrompt(client, PROMPT.chart, { model: "grok-4.7", reasoningEffort: "medium" });
    const createCalls = store.calls.filter((call) => call === "POST /api/2.0/mlflow/model-versions/create");
    expect(createCalls).toHaveLength(1);
    expect(PROMPT_SOURCE).toBe("prompt-template");
    expect(PRODUCTION_ALIAS).toBe("production");
  });

  it("creates the taco experiment", async () => {
    const store = registry();
    const client = clientFor(store.fetchImpl);
    await expect(client.ensureExperiment("taco")).resolves.toBe("7");
    await expect(client.ensureExperiment("taco")).resolves.toBe("7");
    expect(store.calls.filter((call) => call.endsWith("/experiments/create"))).toHaveLength(1);
  });
});
