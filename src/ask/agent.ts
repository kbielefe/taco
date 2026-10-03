import OpenAI from "openai";
import type { DataCatalog } from "../mcp/catalog.js";
import { collectionDescription } from "../mcp/schema.js";
import { callTool, listTools } from "../mcp/tools.js";
import { readAskReasoningEffort } from "../log/ai.js";
import { DEFAULT_FOOD_LOG_MODEL } from "../log/types.js";
import { CATALOG_ID, CATALOG_INSTRUCTIONS } from "./catalog.js";
import { AskConfigError, AskFailedError } from "./errors.js";
import type { AskTurn } from "./request.js";
import { validateA2ui, type A2uiMessage } from "./validate.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const MAX_ROUNDS = 8;

export type AskEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "a2ui"; message: A2uiMessage };

export interface AskModel {
  create(request: { instructions: string; input: unknown[] }): Promise<{ output: unknown[] }>;
}

export interface RunAskOptions {
  question: string;
  timeZone: string;
  today: string;
  history: AskTurn[];
  data: DataCatalog;
  model: AskModel;
  emit: (event: AskEvent) => Promise<void>;
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
      return { output: [...response.output] };
    },
  };
}

export async function runAsk(options: RunAskOptions): Promise<void> {
  const instructions = buildInstructions(options.timeZone, options.today);
  let input: unknown[] = [
    ...options.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: options.question },
  ];
  let answer = "";
  let shown = false;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let output: unknown[];
    try {
      output = (await options.model.create({ instructions, input })).output;
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
      return;
    }
    const results: unknown[] = [];
    for (const call of calls) {
      const outputText = await runCall(call, options, shown, () => {
        shown = true;
      });
      results.push({ type: "function_call_output", call_id: call.callId, output: outputText });
    }
    input = [...output, ...results];
  }
  await finish(options.emit, answer, shown);
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

function buildInstructions(timeZone: string, today: string): string {
  return [
    "You answer questions about one person's private food log and journal in Taco.",
    "Use the read tools before you state a number. Do not invent meals, weights, symptoms, or totals.",
    "Answer with a chart whenever the data can be charted, even when the question does not ask for one.",
    "Use as little text as possible. Do not restate the chart in sentences or a list.",
    `The person's time zone is ${timeZone}. The local date is ${today}. Group calendar days in that time zone.`,
    `food: ${collectionDescription("food")}`,
    `observations: ${collectionDescription("observations")}`,
    `kinds: ${collectionDescription("kinds")}`,
    "When you talk about macros, say Protein, Fat, Carbohydrate, and Fiber.",
    'Dates and ObjectIds in tool arguments use Extended JSON: {"$date":"<ISO-8601>"} and {"$oid":"<24 hex chars>"}.',
    `The show tool uses catalog ${CATALOG_ID}.`,
    CATALOG_INSTRUCTIONS,
  ].join("\n");
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
