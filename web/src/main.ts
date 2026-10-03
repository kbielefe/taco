import {
  deleteMeal,
  fetchEnergy,
  fetchMeals,
  fetchSuggestions,
  logMeal,
  type EnergyRecommendation,
  type Macros,
  type Meal,
} from "./api.js";
import { mountCombobox } from "./combobox.js";
import { mountJournal } from "./journal.js";
import { emptyMacros, formatGrams, formatKcal, sumMacros } from "./macros.js";
import { renderMeal } from "./meals.js";
import { watchChanges } from "./sync.js";
import { formatDay, localDayRange } from "./time.js";
import "./styles.css";

function required<T extends Element>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const viewFood = required(document.querySelector<HTMLElement>("#view-food"), "view-food");
const viewJournal = required(document.querySelector<HTMLElement>("#view-journal"), "view-journal");
const viewLinks = [...document.querySelectorAll<HTMLAnchorElement>(".views a")];

const nodes = {
  dateLabel: required(document.querySelector<HTMLHeadingElement>("#date-label"), "date-label"),
  totalKcal: required(document.querySelector<HTMLSpanElement>("#total-kcal"), "total-kcal"),
  totalProtein: required(document.querySelector<HTMLSpanElement>("#total-protein"), "total-protein"),
  totalFat: required(document.querySelector<HTMLSpanElement>("#total-fat"), "total-fat"),
  totalCarb: required(document.querySelector<HTMLSpanElement>("#total-carb"), "total-carb"),
  totalFiber: required(document.querySelector<HTMLSpanElement>("#total-fiber"), "total-fiber"),
  calorieTarget: required(document.querySelector<HTMLParagraphElement>("#calorie-target"), "calorie-target"),
  calorieWhy: required(document.querySelector<HTMLButtonElement>("#calorie-why"), "calorie-why"),
  calorieNote: required(document.querySelector<HTMLParagraphElement>("#calorie-target-note"), "calorie-target-note"),
  form: required(document.querySelector<HTMLFormElement>("#log-form"), "log-form"),
  input: required(document.querySelector<HTMLInputElement>("#meal"), "meal"),
  listbox: required(document.querySelector<HTMLUListElement>("#suggestions"), "suggestions"),
  logButton: required(document.querySelector<HTMLButtonElement>("#log-button"), "log-button"),
  errorEl: required(document.querySelector<HTMLParagraphElement>("#meal-error"), "meal-error"),
  statusEl: required(document.querySelector<HTMLParagraphElement>("#meal-status"), "meal-status"),
  emptyEl: required(document.querySelector<HTMLParagraphElement>("#empty"), "empty"),
  mealsEl: required(document.querySelector<HTMLOListElement>("#meals"), "meals"),
};

const CORRECTION_RETRY_MS = 1000;

let meals: Meal[] = [];
let recommendation: EnergyRecommendation | undefined;
let recommendationProblem: string | undefined;
let mealsReady = false;
let logging = false;
let foodDirty = false;

function shownMacros(meal: Meal): Macros {
  return meal.adjusted ?? meal.macros;
}

function eatenKcal(): number {
  return sumMacros(meals.map(shownMacros)).caloriesKcal;
}

function paintTotals(macros: Macros): void {
  nodes.totalKcal.textContent = formatKcal(macros.caloriesKcal);
  nodes.totalProtein.textContent = formatGrams(macros.proteinG);
  nodes.totalFat.textContent = formatGrams(macros.fatG);
  nodes.totalCarb.textContent = formatGrams(macros.carbG);
  nodes.totalFiber.textContent = formatGrams(macros.fiberG);
  paintRecommendation(macros.caloriesKcal);
}

function paintRecommendation(eatenKcal: number): void {
  if (recommendationProblem) {
    nodes.calorieTarget.hidden = true;
    nodes.calorieTarget.textContent = "";
    setRecommendationReason(recommendationProblem, true);
    return;
  }
  if (!recommendation) {
    nodes.calorieTarget.hidden = true;
    setRecommendationReason("", false);
    return;
  }
  const minKcal = recommendation.minKcal ?? recommendation.kcal;
  const maxKcal = recommendation.maxKcal ?? recommendation.kcal;
  if (minKcal === null || maxKcal === null) {
    nodes.calorieTarget.hidden = true;
    nodes.calorieTarget.textContent = "";
    setRecommendationReason(recommendation.message, true);
  } else {
    nodes.calorieTarget.hidden = false;
    nodes.calorieTarget.textContent = recommendationLine(minKcal, maxKcal, eatenKcal);
    setRecommendationReason(recommendation.message, false);
  }
}

function setRecommendationReason(message: string, open: boolean): void {
  const shown = message !== "";
  nodes.calorieNote.textContent = message;
  if (!shown) {
    nodes.calorieWhy.hidden = true;
    nodes.calorieWhy.setAttribute("aria-expanded", "false");
    nodes.calorieNote.hidden = true;
    return;
  }
  if (open) {
    nodes.calorieWhy.hidden = true;
    nodes.calorieWhy.setAttribute("aria-expanded", "false");
    nodes.calorieNote.hidden = false;
    return;
  }
  nodes.calorieWhy.hidden = false;
  const expanded = nodes.calorieWhy.getAttribute("aria-expanded") === "true";
  nodes.calorieNote.hidden = !expanded;
}

nodes.calorieWhy.addEventListener("click", () => {
  const expanded = nodes.calorieWhy.getAttribute("aria-expanded") === "true";
  nodes.calorieWhy.setAttribute("aria-expanded", expanded ? "false" : "true");
  nodes.calorieNote.hidden = expanded || nodes.calorieNote.textContent === "";
});

function recommendationLine(minKcal: number, maxKcal: number, eaten: number): string {
  const range =
    minKcal === maxKcal ? formatKcal(maxKcal) : `${formatKcal(minKcal)} to ${formatKcal(maxKcal)}`;
  if (eaten <= 0) {
    return `Recommended ${range} kcal`;
  }
  if (eaten > maxKcal) {
    return `Recommended ${range} kcal · ${formatKcal(eaten - maxKcal)} over`;
  }
  if (minKcal !== maxKcal && eaten < minKcal) {
    return `Recommended ${range} kcal · ${formatKcal(minKcal - eaten)} to ${formatKcal(maxKcal - eaten)} left`;
  }
  return `Recommended ${range} kcal · ${formatKcal(maxKcal - eaten)} left`;
}

function paintList(): void {
  nodes.mealsEl.replaceChildren();
  for (const meal of meals) {
    nodes.mealsEl.append(renderMeal(meal, handleDelete));
  }
  const empty = meals.length === 0;
  nodes.emptyEl.hidden = !empty;
  nodes.mealsEl.hidden = empty;
  paintTotals(sumMacros(meals.map(shownMacros)));
}

function setError(message: string | undefined): void {
  if (!message) {
    nodes.errorEl.hidden = true;
    nodes.errorEl.textContent = "";
    nodes.input.removeAttribute("aria-invalid");
    nodes.input.setAttribute("aria-describedby", "meal-hint");
    return;
  }
  nodes.errorEl.hidden = false;
  nodes.errorEl.textContent = message;
  nodes.input.setAttribute("aria-invalid", "true");
  nodes.input.setAttribute("aria-describedby", "meal-hint meal-error");
}

function setBusy(busy: boolean): void {
  nodes.logButton.disabled = busy;
  nodes.input.toggleAttribute("aria-busy", busy);
  nodes.statusEl.textContent = busy ? "Looking up nutrition…" : "";
}

async function handleDelete(meal: Meal, row: HTMLLIElement): Promise<void> {
  const index = meals.findIndex((item) => item.id === meal.id);
  if (index === -1) {
    return;
  }
  const snapshot = meals.slice();
  meals = meals.filter((item) => item.id !== meal.id);
  row.remove();
  const empty = meals.length === 0;
  nodes.emptyEl.hidden = !empty;
  nodes.mealsEl.hidden = empty;
  paintTotals(sumMacros(meals.map(shownMacros)));
  try {
    await deleteMeal(meal.id);
  } catch (error) {
    meals = snapshot;
    paintList();
    setError(error instanceof Error ? error.message : "Couldn't delete that meal.");
    nodes.input.focus();
  }
}

const combobox = mountCombobox({
  input: nodes.input,
  list: nodes.listbox,
  fetchItems: fetchSuggestions,
  onSelect: (item) => {
    nodes.input.value = item.query;
    nodes.form.requestSubmit();
  },
});

nodes.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = nodes.input.value.trim();
  if (query === "") {
    setError("Enter what you ate");
    nodes.input.focus();
    return;
  }
  setError(undefined);
  combobox.close();
  setBusy(true);
  logging = true;
  try {
    const meal = await logMeal(query, {
      onProgress: (message) => {
        nodes.statusEl.textContent = message;
      },
    });
    meals = [meal, ...meals.filter((item) => item.id !== meal.id)];
    paintList();
    nodes.input.value = "";
  } catch (error) {
    setError(error instanceof Error ? error.message : "Couldn't log that meal.");
  } finally {
    logging = false;
    setBusy(false);
    nodes.input.focus();
    if (foodDirty) {
      foodDirty = false;
      reloadFood();
    }
  }
});

function viewFromPath(path: string): "food" | "journal" {
  return path === "/journal" ? "journal" : "food";
}

function show(view: "food" | "journal"): void {
  viewFood.hidden = view !== "food";
  viewJournal.hidden = view !== "journal";
  document.title = view === "journal" ? "Taco · Journal" : "Taco · Food";
  for (const link of viewLinks) {
    if (link.dataset.view === view) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  if (view === "food" && mealsReady) {
    void reloadFood();
  }
  if (view === "journal") {
    void journal.load();
  }
}

for (const link of viewLinks) {
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const url = new URL(link.href);
    if (url.origin !== location.origin) {
      return;
    }
    event.preventDefault();
    const view = link.dataset.view === "journal" ? "journal" : "food";
    if (location.pathname !== url.pathname) {
      history.pushState({}, "", url.pathname);
    }
    show(view);
  });
}

window.addEventListener("popstate", () => {
  if (location.pathname !== "/" && location.pathname !== "/journal") {
    history.replaceState({}, "", "/");
  }
  show(viewFromPath(location.pathname));
});

async function refreshEnergy(): Promise<void> {
  try {
    const { from } = localDayRange();
    recommendation = await fetchEnergy(from);
    recommendationProblem = undefined;
  } catch (error) {
    recommendation = undefined;
    recommendationProblem = error instanceof Error ? error.message : "Couldn't load a calorie recommendation.";
  }
  paintRecommendation(eatenKcal());
}

async function loadMeals(allowRetry = true): Promise<void> {
  const { from, to } = localDayRange();
  const result = await fetchMeals(from, to);
  meals = result.meals;
  paintList();
  if (result.correctionPending && allowRetry) {
    window.setTimeout(() => {
      void loadMeals(false).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : "Couldn't load today's meals.");
      });
    }, CORRECTION_RETRY_MS);
  }
}

function reloadFood(): void {
  void loadMeals().catch((error: unknown) => {
    setError(error instanceof Error ? error.message : "Couldn't load today's meals.");
  });
  void refreshEnergy();
}

async function load(): Promise<void> {
  nodes.dateLabel.textContent = formatDay(new Date());
  paintTotals(emptyMacros);
  try {
    await loadMeals();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Couldn't load today's meals.");
  }
  await refreshEnergy();
  mealsReady = true;
}

function debounce(run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, 300);
  };
}

const journal = mountJournal();

const syncFood = debounce(() => {
  if (!mealsReady || viewFood.hidden) {
    return;
  }
  if (logging) {
    foodDirty = true;
    return;
  }
  reloadFood();
});

const syncJournal = debounce(() => {
  if (viewJournal.hidden) {
    return;
  }
  void journal.load();
});

watchChanges(
  (topic) => {
    if (topic === "food") {
      syncFood();
    } else {
      syncJournal();
    }
  },
  () => {
    if (viewFood.hidden) {
      syncJournal();
    } else {
      syncFood();
    }
  },
);
if (location.pathname !== "/" && location.pathname !== "/journal") {
  history.replaceState({}, "", "/");
}
show(viewFromPath(location.pathname));
void load();
