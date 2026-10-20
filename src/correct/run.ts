import { observationWeightKg, type WeightObservation } from "../energy/recommend.js";
import { withMlflowSpan } from "../mlflow/tracing.js";
import { readBodyProfile } from "../energy/profile.js";
import type { Journal } from "../journal/journal.js";
import type { FoodLogger } from "../log/logger.js";
import { scaleItem, servingsOf } from "../log/servings.js";
import { buildEnergyWindows } from "./windows.js";
import { fitEnergyWindows, type CorrectionFit } from "./fit.js";
import { openCorrectionStore, type CorrectionStore, type StoredCorrection } from "./store.js";
import type { LoggedMeal } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FitHistory {
  meals: LoggedMeal[];
  observations: WeightObservation[];
}

export interface WeightView {
  observation: { at: Date; values: { fieldId: string; value: unknown }[] };
  kind: { label: string; fields: WeightObservation["fields"] };
}

export interface CorrectionRunner {
  schedule(input?: { timeZone?: string }): void;
  current(): Promise<CorrectionFit | null>;
  pending(): boolean;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface CorrectionRunnerOptions {
  store: CorrectionStore;
  load: () => Promise<FitHistory>;
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
  closeStore?: () => Promise<void>;
}

export function toWeightObservation(view: WeightView): WeightObservation {
  return {
    at: view.observation.at,
    kindLabel: view.kind.label,
    fields: view.kind.fields,
    values: view.observation.values,
  };
}

export function isWeighIn(view: WeightView): boolean {
  return observationWeightKg(toWeightObservation(view)) !== undefined;
}

export function createCorrectionRunner(options: CorrectionRunnerOptions): CorrectionRunner {
  const env = options.env ?? process.env;
  const onError = options.onError ?? ((error: unknown) => {
    console.error(error);
  });
  let depth = 0;
  let tail: Promise<void> = Promise.resolve();

  const report = (error: unknown): void => {
    try {
      onError(error);
    } catch (observerError) {
      console.error(observerError);
    }
  };

  const run = async (requested: string | undefined): Promise<void> => {
    await withMlflowSpan(
      { name: "fit corrections", spanType: "CHAIN", inputs: { timeZone: requested }, root: true },
      async () => {
        const existing = await options.store.read();
        const profile = readBodyProfile(env, new Date());
        if (!profile.ok) {
          report(profile.message);
          return { result: undefined, outputs: { skipped: profile.message } };
        }
        const timeZone = chooseTimeZone(requested, existing?.timeZone);
        const history = await options.load();
        const windows = buildEnergyWindows({
          profile: profile.profile,
          meals: history.meals,
          observations: history.observations,
          timeZone,
        });
        const fit = fitEnergyWindows(windows);
        const stored: StoredCorrection = { updatedAt: new Date(), timeZone, fit };
        await options.store.save(stored);
        return { result: undefined, outputs: { timeZone, windows: windows.length } };
      },
    );
  };

  return {
    schedule(input) {
      depth += 1;
      const opened = new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      tail = tail
        .then(() => opened)
        .then(() => run(input?.timeZone))
        .catch((error: unknown) => {
          report(error);
        })
        .finally(() => {
          depth -= 1;
        });
    },
    async current() {
      const stored = await options.store.read();
      return stored?.fit ?? null;
    },
    pending() {
      return depth > 0;
    },
    whenIdle() {
      return tail;
    },
    async close() {
      await tail;
      await options.closeStore?.();
    },
  };
}

export async function connectCorrectionRunner(options: {
  logger: FoodLogger;
  journal: Journal;
  env?: NodeJS.ProcessEnv;
  mongoUri?: string;
}): Promise<CorrectionRunner> {
  const uri = options.mongoUri ?? process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }
  const opened = await openCorrectionStore(uri);
  return createCorrectionRunner({
    store: opened.store,
    load: () => loadHistory(options.logger, options.journal),
    env: options.env,
    closeStore: opened.close,
  });
}

export async function loadHistory(logger: FoodLogger, journal: Journal, now = new Date()): Promise<FitHistory> {
  const from = new Date(0);
  const to = new Date(now.getTime() + DAY_MS);
  const [meals, observations] = await Promise.all([logger.list(from, to), journal.list(from, to)]);
  return {
    meals: meals.map((meal) => ({
      eatenAt: meal.eatenAt,
      items: meal.items.map((item) => {
        const eaten = scaleItem(item, servingsOf(meal));
        return {
          name: eaten.name,
          dataType: eaten.dataType,
          grams: eaten.grams,
          servingDescription: eaten.servingDescription,
          macros: eaten.macros,
        };
      }),
    })),
    observations: observations.map((view) => toWeightObservation(view)),
  };
}

function chooseTimeZone(requested: string | undefined, stored: string | undefined): string {
  if (requested && validTimeZone(requested)) {
    return requested;
  }
  if (stored && validTimeZone(stored)) {
    return stored;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
