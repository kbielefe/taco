const API = "/api/2.0/mlflow";

export const IS_PROMPT_TAG = "mlflow.prompt.is_prompt";
export const PROMPT_TEXT_TAG = "mlflow.prompt.text";
export const PROMPT_TYPE_TAG = "_mlflow_prompt_type";
export const PROMPT_SOURCE = "prompt-template";
export const PRODUCTION_ALIAS = "production";

export class MlflowRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "MlflowRequestError";
  }
}

export interface PromptVersionRecord {
  version: string;
  template: string;
}

export interface CreatePromptVersionInput {
  name: string;
  template: string;
  commitMessage: string;
  tags: Record<string, string>;
}

interface Tag {
  key: string;
  value: string;
}

export interface MlflowClientOptions {
  trackingUri: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class MlflowClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly signal: AbortSignal | undefined;

  constructor(options: MlflowClientOptions) {
    this.origin = options.trackingUri.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.signal = options.signal;
  }

  async ensureExperiment(name: string): Promise<string> {
    const existing = await this.call("GET", `${API}/experiments/get-by-name`, { experiment_name: name });
    if (existing.status === 200) {
      return experimentId(existing.body);
    }
    if (!isMissing(existing.status, existing.body)) {
      throw requestError("Could not read the MLflow experiment", existing);
    }
    const created = await this.call("POST", `${API}/experiments/create`, { name });
    if (created.status === 200) {
      return experimentId(created.body);
    }
    if (errorCode(created.body) === "RESOURCE_ALREADY_EXISTS") {
      const again = await this.call("GET", `${API}/experiments/get-by-name`, { experiment_name: name });
      if (again.status === 200) {
        return experimentId(again.body);
      }
      throw requestError("Could not read the MLflow experiment", again);
    }
    throw requestError("Could not create the MLflow experiment", created);
  }

  async latestPromptVersion(name: string): Promise<PromptVersionRecord | null> {
    // Model search hides prompts unless the filter asks for the prompt tag.
    const listed = await this.call("GET", `${API}/model-versions/search`, {
      filter: `name = '${name}' AND tag.\`${IS_PROMPT_TAG}\` = 'true'`,
      max_results: "1000",
    });
    if (isMissing(listed.status, listed.body)) {
      return null;
    }
    if (listed.status !== 200) {
      throw requestError(`Could not list versions of ${name}`, listed);
    }
    return latestVersion(listed.body);
  }

  async createPromptVersion(input: CreatePromptVersionInput): Promise<PromptVersionRecord> {
    await this.ensurePrompt(input.name);
    const created = await this.call("POST", `${API}/model-versions/create`, {
      name: input.name,
      source: PROMPT_SOURCE,
      description: input.commitMessage,
      tags: promptTags(input.template, input.tags),
    });
    if (created.status !== 200) {
      throw requestError(`Could not register ${input.name}`, created);
    }
    const version = modelVersion(created.body);
    if (!version) {
      throw new MlflowRequestError(`MLflow returned no version for ${input.name}`, created.status);
    }
    return { version, template: input.template };
  }

  async setAlias(name: string, alias: string, version: string): Promise<void> {
    const response = await this.call("POST", `${API}/registered-models/alias`, { name, alias, version });
    if (response.status !== 200) {
      throw requestError(`Could not set alias ${alias} on ${name}`, response);
    }
  }

  private async ensurePrompt(name: string): Promise<void> {
    const existing = await this.call("GET", `${API}/registered-models/get`, { name });
    if (existing.status === 200) {
      return;
    }
    if (!isMissing(existing.status, existing.body)) {
      throw requestError(`Could not read prompt ${name}`, existing);
    }
    const created = await this.call("POST", `${API}/registered-models/create`, {
      name,
      tags: [{ key: IS_PROMPT_TAG, value: "true" }],
    });
    if (created.status === 200 || errorCode(created.body) === "RESOURCE_ALREADY_EXISTS") {
      return;
    }
    throw requestError(`Could not create prompt ${name}`, created);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, `${this.origin}/`);
    let payload: string | undefined;
    if (body && method === "GET") {
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    } else if (method === "POST") {
      payload = JSON.stringify(body ?? {});
    }
    const response = await this.fetchImpl(url, {
      method,
      ...(payload ? { headers: { "content-type": "application/json" } } : {}),
      ...(payload ? { body: payload } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { message: text };
      }
    }
    return { status: response.status, body: parsed };
  }
}

function promptTags(template: string, tags: Record<string, string>): Tag[] {
  const reserved = new Set([IS_PROMPT_TAG, PROMPT_TEXT_TAG, PROMPT_TYPE_TAG]);
  const extra = Object.entries(tags)
    .filter(([key]) => !reserved.has(key))
    .map(([key, value]) => ({ key, value }));
  return [
    { key: IS_PROMPT_TAG, value: "true" },
    { key: PROMPT_TEXT_TAG, value: template },
    { key: PROMPT_TYPE_TAG, value: "text" },
    ...extra,
  ];
}

function latestVersion(body: unknown): PromptVersionRecord | null {
  const versions = readArray(body, "model_versions");
  let best: PromptVersionRecord | undefined;
  let bestNumber = -1;
  for (const entry of versions) {
    const version = readString(entry, "version");
    const template = tagValue(entry, PROMPT_TEXT_TAG);
    const number = version ? Number(version) : Number.NaN;
    if (!version || template === undefined || !Number.isInteger(number)) {
      continue;
    }
    if (number > bestNumber) {
      bestNumber = number;
      best = { version, template };
    }
  }
  return best ?? null;
}

function modelVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("model_version" in body)) {
    return undefined;
  }
  return readString((body as { model_version?: unknown }).model_version, "version");
}

function experimentId(body: unknown): string {
  if (body && typeof body === "object") {
    if ("experiment_id" in body && typeof (body as { experiment_id?: unknown }).experiment_id === "string") {
      return (body as { experiment_id: string }).experiment_id;
    }
    if ("experiment" in body) {
      const id = readString((body as { experiment?: unknown }).experiment, "experiment_id");
      if (id) {
        return id;
      }
    }
  }
  throw new MlflowRequestError("MLflow returned no experiment id", 200);
}

function tagValue(entry: unknown, key: string): string | undefined {
  if (!entry || typeof entry !== "object" || !("tags" in entry)) {
    return undefined;
  }
  const tags = (entry as { tags?: unknown }).tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (readString(tag, "key") === key) {
        return readString(tag, "value");
      }
    }
    return undefined;
  }
  if (tags && typeof tags === "object" && key in tags) {
    const value = (tags as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function readArray(body: unknown, key: string): unknown[] {
  if (!body || typeof body !== "object" || !(key in body)) {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function errorCode(body: unknown): string | undefined {
  return readString(body, "error_code");
}

function isMissing(status: number, body: unknown): boolean {
  return status === 404 || errorCode(body) === "RESOURCE_DOES_NOT_EXIST";
}

function requestError(message: string, response: { status: number; body: unknown }): MlflowRequestError {
  const detail = readString(response.body, "message");
  return new MlflowRequestError(detail ? `${message}: ${detail}` : message, response.status, errorCode(response.body));
}
