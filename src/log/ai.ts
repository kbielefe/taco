import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { PROMPT, PromptBook } from "../mlflow/prompts.js";
import { withMlflowSpan, type TokenUsage } from "../mlflow/tracing.js";
import { FoodLogAiError, FoodLogConfigError } from "./errors.js";
import { SelectedMatchSchema, buildMatchUserPrompt } from "./match.js";
import { ParsedMealSchema, normalizeParsedMeal } from "./parse.js";
import { DEFAULT_FOOD_LOG_MODEL, type FoodLogAi, type ParsedMeal, type SelectMatchInput, type SelectedMatch } from "./types.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_REASONING_EFFORT = "low";
const DEFAULT_ASK_REASONING_EFFORT = "medium";
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type XaiReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface XaiFoodLogAiOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  reasoningEffort?: string;
  client?: OpenAI;
  prompts?: PromptBook;
}

export function readReasoningEffort(explicit?: string): XaiReasoningEffort {
  return parseReasoningEffort(
    explicit ?? process.env.XAI_REASONING_EFFORT,
    DEFAULT_REASONING_EFFORT,
    "XAI_REASONING_EFFORT",
  );
}

/** Ask uses its own effort. An unset value stays medium and does not follow XAI_REASONING_EFFORT. */
export function readAskReasoningEffort(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): XaiReasoningEffort {
  return parseReasoningEffort(
    explicit ?? env.XAI_ASK_REASONING_EFFORT,
    DEFAULT_ASK_REASONING_EFFORT,
    "XAI_ASK_REASONING_EFFORT",
  );
}

function parseReasoningEffort(
  raw: string | undefined,
  fallback: XaiReasoningEffort,
  name: string,
): XaiReasoningEffort {
  const trimmed = (raw ?? "").trim();
  const value = trimmed === "" ? fallback : trimmed;
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new FoodLogConfigError(`${name} must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }
  return value as XaiReasoningEffort;
}

export class XaiFoodLogAi implements FoodLogAi {
  private client: OpenAI | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly reasoningEffort: XaiReasoningEffort;
  private readonly prompts: PromptBook;

  constructor(options: XaiFoodLogAiOptions = {}) {
    this.client = options.client;
    this.apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.baseURL = options.baseURL ?? DEFAULT_XAI_BASE_URL;
    this.model = options.model ?? DEFAULT_FOOD_LOG_MODEL;
    this.reasoningEffort = readReasoningEffort(options.reasoningEffort);
    this.prompts = options.prompts ?? new PromptBook();
  }

  private getClient(): OpenAI {
    if (this.client) {
      return this.client;
    }
    if (!this.apiKey) {
      throw new FoodLogConfigError("XAI_API_KEY is not set");
    }
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });
    return this.client;
  }

  async parseQuery(query: string): Promise<ParsedMeal> {
    const prompt = this.prompts.resolve(PROMPT.parse);
    return withMlflowSpan(
      {
        name: "parse meal",
        spanType: "LLM",
        inputs: { messages: messages(prompt.text, query) },
        links: [prompt],
      },
      async () => {
        const parsed = await this.complete(ParsedMealSchema, "parsed_meal", prompt.text, query);
        const meal = normalizeParsedMeal(parsed.value);
        return { result: meal, outputs: meal, ...(parsed.usage ? { usage: parsed.usage } : {}) };
      },
    );
  }

  async selectMatch(input: SelectMatchInput): Promise<SelectedMatch> {
    const prompt = this.prompts.resolve(PROMPT.match);
    const user = buildMatchUserPrompt(input);
    return withMlflowSpan(
      {
        name: "select match",
        spanType: "LLM",
        inputs: { messages: messages(prompt.text, user) },
        links: [prompt],
      },
      async () => {
        const parsed = await this.complete(SelectedMatchSchema, "selected_match", prompt.text, user);
        return { result: parsed.value, outputs: parsed.value, ...(parsed.usage ? { usage: parsed.usage } : {}) };
      },
    );
  }

  private async complete<S extends z.ZodType>(
    schema: S,
    name: string,
    system: string,
    user: string,
  ): Promise<{ value: z.output<S>; usage?: TokenUsage }> {
    try {
      const completion = await this.getClient().chat.completions.parse({
        model: this.model,
        reasoning_effort: this.reasoningEffort,
        messages: messages(system, user),
        response_format: zodResponseFormat(schema, name),
      });
      const parsed = completion.choices[0]?.message.parsed;
      if (parsed === null || parsed === undefined) {
        throw new FoodLogAiError("Model returned no structured output");
      }
      const usage = chatUsage(completion.usage);
      return { value: schema.parse(parsed), ...(usage ? { usage } : {}) };
    } catch (error) {
      if (error instanceof FoodLogAiError || error instanceof FoodLogConfigError) {
        throw error;
      }
      throw new FoodLogAiError("Food log AI request failed", { cause: error });
    }
  }
}

function messages(system: string, user: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function chatUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined): TokenUsage | undefined {
  if (!usage || usage.prompt_tokens === undefined || usage.completion_tokens === undefined) {
    return undefined;
  }
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}
