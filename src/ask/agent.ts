import OpenAI from "openai";
import type { DataCatalog } from "../mcp/catalog.js";
import { collectionDescription } from "../mcp/schema.js";
import { callTool, listTools } from "../mcp/tools.js";
import { readAskReasoningEffort } from "../log/ai.js";
import { DEFAULT_FOOD_LOG_MODEL } from "../log/types.js";
import { CATALOG_ID, CATALOG_INSTRUCTIONS, MAX_POINTS, MAX_SERIES } from "./catalog.js";
import { AskConfigError, AskFailedError } from "./errors.js";
import { PROMPT, PromptBook } from "../mlflow/prompts.js";
import { withMlflowSpan, type TokenUsage } from "../mlflow/tracing.js";
import type { AskTurn } from "./request.js";
import { validateA2ui, type A2uiMessage } from "./validate.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const MAX_ROUNDS = 8;

export type AskEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "a2ui"; message: A2uiMessage };

export interface AskModel {
  create(request: { instructions: string; input: unknown[] }): Promise<{ output: unknown[]; usage?: TokenUsage }>;
}

export interface RunAskOptions {
  question: string;
  timeZone: string;
  today: string;
  history: AskTurn[];
  data: DataCatalog;
  model: AskModel;
  emit: (event: AskEvent) => Promise<void>;
  prompts?: PromptBook;
}

interface ToolCall {
  name: string;
  callId: string;
  arguments: string;
}

const DATA_TOOLS = new Set(["list-collections", "collection-schema", "find", "aggregate", "count"]);

const ASK_TOOLS = [
  ...listTools()
    .filter((tool) => DATA_TOOLS.has(tool.name))
    .map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    })),
  {
    type: "function" as const,
    name: "show",
    description: `${CATALOG_INSTRUCTIONS} Pass the two A2UI messages as messages.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        messages: {
          type: "array",
          description: "createSurface, then updateComponents.",
          items: { type: "object" },
        },
      },
      required: ["messages"],
    },
    strict: false,
  },
];

export function createXaiAskModel(options: { env?: NodeJS.ProcessEnv; client?: OpenAI } = {}): AskModel {
  const env = options.env ?? process.env;
  const effort = readAskReasoningEffort(undefined, env);
  const apiKey = env.XAI_API_KEY;
  if (!options.client && !apiKey) {
    throw new AskConfigError("Couldn't ask that. Set XAI_API_KEY in .env.");
  }
  const client =
    options.client ??
    new OpenAI({
      apiKey,
      baseURL: DEFAULT_XAI_BASE_URL,
      timeout: 90_000,
      maxRetries: 0,
    });
  return {
    async create(request) {
      const response = await client.responses.create({
        model: DEFAULT_FOOD_LOG_MODEL,
        instructions: request.instructions,
        input: request.input as OpenAI.Responses.ResponseInput,
        tools: ASK_TOOLS,
        reasoning: { effort },
        store: false,
      });
      const usage = responseUsage(response.usage);
      return { output: [...response.output], ...(usage ? { usage } : {}) };
    },
  };
}

function responseUsage(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined): TokenUsage | undefined {
  if (!usage || usage.input_tokens === undefined || usage.output_tokens === undefined) {
    return undefined;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
  };
}

export async function runAsk(options: RunAskOptions): Promise<void> {
  const prompts = options.prompts ?? new PromptBook();
  const { text: instructions, links } = buildInstructions(prompts, options.timeZone, options.today);
  let input: unknown[] = [
    ...options.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: options.question },
  ];
  let answer = "";
  let shown = false;

  await withMlflowSpan(
    {
      name: "ask",
      spanType: "AGENT",
      inputs: { question: options.question, timeZone: options.timeZone, today: options.today },
      links,
    },
    async () => {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (await oneRound()) {
          return { result: undefined, outputs: { answer, shown } };
        }
      }
      await finish(options.emit, answer, shown);
      return { result: undefined, outputs: { answer, shown } };
    },
  );

  async function oneRound(): Promise<boolean> {
    let output: unknown[];
    try {
      const created = await withMlflowSpan(
        { name: "ask model", spanType: "LLM", inputs: { instructions, input }, links },
        async () => {
          const response = await options.model.create({ instructions, input });
          return { result: response, outputs: response.output, ...(response.usage ? { usage: response.usage } : {}) };
        },
      );
      output = created.output;
    } catch (error) {
      if (error instanceof AskFailedError || error instanceof AskConfigError) {
        throw error;
      }
      throw new AskFailedError("Couldn't answer that. Try again in a moment.", { cause: error });
    }
    if (!Array.isArray(output)) {
      throw new AskFailedError();
    }
    const text = readText(output);
    if (text) {
      answer = text;
    }
    const calls = readCalls(output);
    if (calls.length === 0) {
      await finish(options.emit, answer, shown);
      return true;
    }
    const results: unknown[] = [];
    for (const call of calls) {
      const outputText = await runCall(call, options, shown, () => {
        shown = true;
      });
      results.push({ type: "function_call_output", call_id: call.callId, output: outputText });
    }
    input = [...output, ...results];
    return false;
  }
}

async function finish(emit: RunAskOptions["emit"], answer: string, shown: boolean): Promise<void> {
  if (!answer && !shown) {
    throw new AskFailedError();
  }
  if (answer) {
    await emit({ type: "text", text: answer });
  }
}

async function runCall(
  call: ToolCall,
  options: RunAskOptions,
  alreadyShown: boolean,
  onShown: () => void,
): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments) as unknown;
  } catch {
    return "The tool arguments were not valid JSON.";
  }
  if (call.name === "show") {
    return showSurface(args, options.emit, alreadyShown, onShown);
  }
  const status = statusFor(call.name, args);
  if (status) {
    await options.emit({ type: "status", message: status });
  }
  if (!DATA_TOOLS.has(call.name)) {
    return `Unknown tool ${call.name}.`;
  }
  const result = await callTool(call.name, args, options.data);
  return result.content[0].text;
}

function showSurface(
  args: unknown,
  emit: RunAskOptions["emit"],
  alreadyShown: boolean,
  onShown: () => void,
): Promise<string> | string {
  if (!args || typeof args !== "object" || Array.isArray(args) || !("messages" in args)) {
    return "Pass messages, an array of two A2UI messages.";
  }
  const validated = validateA2ui((args as { messages?: unknown }).messages);
  if (!validated.ok) {
    return validated.message;
  }
  if (alreadyShown) {
    return "A surface is already shown. Answer in prose.";
  }
  onShown();
  return emitMessages(validated.messages, emit);
}

async function emitMessages(messages: A2uiMessage[], emit: RunAskOptions["emit"]): Promise<string> {
  for (const message of messages) {
    await emit({ type: "a2ui", message });
  }
  return "Shown.";
}

function buildInstructions(
  prompts: PromptBook,
  timeZone: string,
  today: string,
): { text: string; links: ReturnType<PromptBook["resolve"]>[] } {
  const chart = prompts.resolve(PROMPT.chart, {
    catalogId: CATALOG_ID,
    maxSeries: String(MAX_SERIES),
    maxPoints: String(MAX_POINTS),
  });
  const ask = prompts.resolve(PROMPT.ask, {
    timeZone,
    today,
    food: collectionDescription("food"),
    observations: collectionDescription("observations"),
    kinds: collectionDescription("kinds"),
    catalogId: CATALOG_ID,
    chartInstructions: chart.text,
  });
  return { text: ask.text, links: [ask, chart] };
}

function statusFor(name: string, args: unknown): string | undefined {
  if (name === "list-collections" || name === "collection-schema") {
    return "Checking how the data is stored.";
  }
  const collection =
    args && typeof args === "object" && !Array.isArray(args) && "collection" in args
      ? (args as { collection?: unknown }).collection
      : undefined;
  if (collection === "food") {
    return "Looking up meals.";
  }
  if (collection === "observations") {
    return "Looking up the journal.";
  }
  if (collection === "kinds") {
    return "Looking up journal fields.";
  }
  if (name === "find" || name === "aggregate" || name === "count") {
    return "Looking up your data.";
  }
  return undefined;
}

function readCalls(output: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.call_id !== "string") {
      throw new AskFailedError();
    }
    const raw = record.arguments;
    const argumentsText = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
    calls.push({ name: record.name, callId: record.call_id, arguments: argumentsText });
  }
  return calls;
}

function readText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "output_text" && typeof record.text === "string") {
        parts.push(record.text);
      }
    }
  }
  return parts.join("\n").trim();
}
