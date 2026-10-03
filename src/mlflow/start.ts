import { readAskReasoningEffort, readReasoningEffort } from "../log/ai.js";
import { DEFAULT_FOOD_LOG_MODEL } from "../log/types.js";
import { MlflowClient } from "./client.js";
import { PROMPT, PromptBook, type PromptName, type PromptTags } from "./prompts.js";
import { flushTracing, startTracing } from "./tracing.js";

const SYNC_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 5_000;
const EXPERIMENT = "taco";

export interface MlflowHandle {
  prompts: PromptBook;
  /** Resolves after the first sync attempt, whether or not the server was reachable. */
  ready: Promise<void>;
  shutdown(): Promise<void>;
}

export function startMlflow(options: { env?: NodeJS.ProcessEnv; prompts?: PromptBook } = {}): MlflowHandle {
  const env = options.env ?? process.env;
  const prompts = options.prompts ?? new PromptBook();
  const trackingUri = env.MLFLOW_TRACKING_URI?.trim() ?? "";
  if (!trackingUri || env.VITEST) {
    return { prompts, ready: Promise.resolve(), shutdown: async () => {} };
  }

  const stop = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let logged = false;
  let tracing = false;

  const attempt = async (): Promise<void> => {
    const client = new MlflowClient({
      trackingUri,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
    });
    const experimentId = await client.ensureExperiment(EXPERIMENT);
    if (!tracing) {
      await startTracing(trackingUri, experimentId);
      tracing = true;
    }
    await prompts.sync(client, (name) => tagsFor(name, env));
  };

  const ready = (async () => {
    try {
      await attempt();
    } catch (error) {
      if (stopped) {
        return;
      }
      if (!logged) {
        console.error("MLflow prompt sync failed. Using the prompts in source.", error);
        logged = true;
      }
      retry = setTimeout(() => {
        if (stopped) {
          return;
        }
        void attempt().catch(() => {
          // The first failure was already logged. The app keeps the in-code prompts.
        });
      }, RETRY_DELAY_MS);
    }
  })();

  return {
    prompts,
    ready,
    shutdown: async () => {
      stopped = true;
      stop.abort();
      if (retry) {
        clearTimeout(retry);
      }
      await flushTracing();
    },
  };
}

function tagsFor(name: PromptName, env: NodeJS.ProcessEnv): PromptTags {
  const ask = name === PROMPT.ask || name === PROMPT.chart;
  const reasoningEffort = ask
    ? readAskReasoningEffort(env.XAI_ASK_REASONING_EFFORT ?? "", env)
    : readReasoningEffort(env.XAI_REASONING_EFFORT ?? "");
  return { model: DEFAULT_FOOD_LOG_MODEL, reasoningEffort };
}
