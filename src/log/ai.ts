import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { FoodLogAiError, FoodLogConfigError } from "./errors.js";
import { MATCH_SYSTEM_PROMPT, SelectedMatchSchema, buildMatchUserPrompt } from "./match.js";
import { PARSE_SYSTEM_PROMPT, ParsedMealSchema, normalizeParsedMeal } from "./parse.js";
import { DEFAULT_FOOD_LOG_MODEL, type FoodLogAi, type ParsedMeal, type SelectMatchInput, type SelectedMatch } from "./types.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type XaiReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface XaiFoodLogAiOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  reasoningEffort?: string;
  client?: OpenAI;
}

export function readReasoningEffort(explicit?: string): XaiReasoningEffort {
  const raw = (explicit ?? process.env.XAI_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT).trim();
  const value = raw === "" ? DEFAULT_REASONING_EFFORT : raw;
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new FoodLogConfigError(
      `XAI_REASONING_EFFORT must be one of: ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  return value as XaiReasoningEffort;
}

/** grok-4.5, grok-4.6, and grok-4.7 always reason. Other models do not take this field. */
export function modelUsesReasoningEffort(model: string): boolean {
  return /^grok-4\.(5|6|7)(?:$|[^0-9])/.test(model);
}

export class XaiFoodLogAi implements FoodLogAi {
  private client: OpenAI | undefined;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly reasoningEffort: XaiReasoningEffort;

  constructor(options: XaiFoodLogAiOptions = {}) {
    this.client = options.client;
    this.apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.baseURL = options.baseURL ?? DEFAULT_XAI_BASE_URL;
    this.model = options.model ?? DEFAULT_FOOD_LOG_MODEL;
    this.reasoningEffort = readReasoningEffort(options.reasoningEffort);
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
    const parsed = await this.parse(ParsedMealSchema, "parsed_meal", PARSE_SYSTEM_PROMPT, query);
    return normalizeParsedMeal(parsed);
  }

  async selectMatch(input: SelectMatchInput): Promise<SelectedMatch> {
    return this.parse(SelectedMatchSchema, "selected_match", MATCH_SYSTEM_PROMPT, buildMatchUserPrompt(input));
  }

  private async parse<S extends z.ZodType>(
    schema: S,
    name: string,
    system: string,
    user: string,
  ): Promise<z.output<S>> {
    try {
      const completion = await this.getClient().chat.completions.parse({
        model: this.model,
        ...(modelUsesReasoningEffort(this.model) ? { reasoning_effort: this.reasoningEffort } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: zodResponseFormat(schema, name),
      });
      const parsed = completion.choices[0]?.message.parsed;
      if (parsed === null || parsed === undefined) {
        throw new FoodLogAiError("Model returned no structured output");
      }
      return schema.parse(parsed);
    } catch (error) {
      if (error instanceof FoodLogAiError || error instanceof FoodLogConfigError) {
        throw error;
      }
      throw new FoodLogAiError("Food log AI request failed", { cause: error });
    }
  }
}
