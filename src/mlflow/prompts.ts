import { createHash } from "node:crypto";
import { CATALOG_INSTRUCTIONS_TEMPLATE } from "../ask/catalog.js";
import { MATCH_SYSTEM_PROMPT } from "../log/match.js";
import { PARSE_SYSTEM_PROMPT } from "../log/parse.js";
import { PRODUCTION_ALIAS, type MlflowClient } from "./client.js";
import { formatPrompt } from "./format.js";

export const PROMPT = {
  parse: "taco.parse",
  match: "taco.match",
  chart: "taco.ask.chart",
  ask: "taco.ask",
} as const;

export type PromptName = (typeof PROMPT)[keyof typeof PROMPT];

export const ASK_INSTRUCTIONS_TEMPLATE = [
  "You answer questions about one person's private food log and journal in Taco.",
  "Use the read tools before you state a number. Do not invent meals, weights, symptoms, or totals.",
  "Answer with a chart whenever the data can be charted, even when the question does not ask for one.",
  "Use as little text as possible. Do not restate the chart in sentences or a list.",
  "The person's time zone is {{timeZone}}. The local date is {{today}}. Group calendar days in that time zone.",
  "food: {{food}}",
  "observations: {{observations}}",
  "kinds: {{kinds}}",
  "When you talk about macros, say Protein, Fat, Carbohydrate, and Fiber.",
  'Dates and ObjectIds in tool arguments use Extended JSON: {"$date":"<ISO-8601>"} and {"$oid":"<24 hex chars>"}.',
  "The show tool uses catalog {{catalogId}}.",
  "{{chartInstructions}}",
].join("\n");

export interface ResolvedPrompt {
  name: PromptName;
  text: string;
  version?: string;
  uri?: string;
}

export interface PromptTags {
  model: string;
  reasoningEffort: string;
}

const TEMPLATES: Record<PromptName, string> = {
  [PROMPT.parse]: PARSE_SYSTEM_PROMPT,
  [PROMPT.match]: MATCH_SYSTEM_PROMPT,
  [PROMPT.chart]: CATALOG_INSTRUCTIONS_TEMPLATE,
  [PROMPT.ask]: ASK_INSTRUCTIONS_TEMPLATE,
};

export function promptTemplate(name: PromptName): string {
  return TEMPLATES[name];
}

export function templateHash(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

/** Registers the code template when it differs from the latest version, then points production at it. */
export async function publishPrompt(
  client: Pick<MlflowClient, "latestPromptVersion" | "createPromptVersion" | "setAlias">,
  name: PromptName,
  tags: PromptTags,
): Promise<string> {
  const template = promptTemplate(name);
  const latest = await client.latestPromptVersion(name);
  const version =
    latest?.template === template
      ? latest.version
      : (
          await client.createPromptVersion({
            name,
            template,
            commitMessage: `template ${templateHash(template)}`,
            tags: { model: tags.model, reasoning_effort: tags.reasoningEffort },
          })
        ).version;
  await client.setAlias(name, PRODUCTION_ALIAS, version);
  return version;
}

export class PromptBook {
  private readonly versions = new Map<PromptName, string>();

  resolve(name: PromptName, variables?: Record<string, string>): ResolvedPrompt {
    const version = this.versions.get(name);
    return {
      name,
      text: formatPrompt(promptTemplate(name), variables),
      ...(version ? { version, uri: `prompts:/${name}/${version}` } : {}),
    };
  }

  remember(name: PromptName, version: string): void {
    this.versions.set(name, version);
  }

  async sync(client: MlflowClient, tagsFor: (name: PromptName) => PromptTags): Promise<void> {
    for (const name of Object.values(PROMPT)) {
      const version = await publishPrompt(client, name, tagsFor(name));
      this.remember(name, version);
    }
  }
}
