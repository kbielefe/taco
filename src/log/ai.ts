import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { FoodLogAiError, FoodLogConfigError } from "./errors.js";
import { MATCH_SYSTEM_PROMPT, SelectedMatchSchema, buildMatchUserPrompt } from "./match.js";
import { PARSE_SYSTEM_PROMPT, ParsedMealSchema, normalizeParsedMeal } from "./parse.js";
import { DEFAULT_FOOD_LOG_MODEL, type FoodLogAi, type ParsedMeal, type SelectMatchInput, type SelectedMatch } from "./types.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export interface XaiFoodLogAiOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  client?: OpenAI;
}

export class XaiFoodLogAi implements FoodLogAi {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: XaiFoodLogAiOptions = {}) {
    const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    if (!options.client && !apiKey) {
      throw new FoodLogConfigError("XAI_API_KEY is not set");
    }
    this.client =
      options.client ??
      new OpenAI({
        apiKey,
        baseURL: options.baseURL ?? DEFAULT_XAI_BASE_URL,
      });
    this.model = options.model ?? DEFAULT_FOOD_LOG_MODEL;
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
      const completion = await this.client.chat.completions.parse({
        model: this.model,
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
