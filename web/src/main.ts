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
import { mountAsk } from "./ask.js";
import { mountCombobox } from "./combobox.js";
import { mountJournal } from "./journal.js";
import { emptyMacros, formatGrams, formatKcal, sumMacros } from "./macros.js";
import { renderMeal } from "./meals.js";
import { watchChanges } from "./sync.js";
import { paceMeter } from "./pace.js";
import { eatingDayFraction, formatDay, formatTime, localDayRange } from "./time.js";
import { confirmDelete } from "./undo.js";
import "./styles.css";

function required<T extends Element>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const viewFood = required(document.querySelector<HTMLElement>("#view-food"), "view-food");
const viewJournal = required(document.querySelector<HTMLElement>("#view-journal"), "view-journal");
const viewAsk = required(document.querySelector<HTMLElement>("#view-ask"), "view-ask");
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
  pace: required(document.querySelector<HTMLElement>("#pace"), "pace"),
  paceDay: required(document.querySelector<HTMLElement>("#pace-day"), "pace-day"),
  paceRange: required(document.querySelector<HTMLElement>("#pace-range"), "pace-range"),
  paceMarkNow: required(document.querySelector<HTMLElement>("#pace-mark-now"), "pace-mark-now"),
  paceMarkDay: required(document.querySelector<HTMLElement>("#pace-mark-day"), "pace-mark-day"),
  paceScale: required(document.querySelector<HTMLElement>("#pace-scale"), "pace-scale"),
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

function paintRecommendation(eaten: number): void {
  if (recommendationProblem) {
    hidePace();
    nodes.calorieTarget.hidden = true;
    nodes.calorieTarget.textContent = "";
    setRecommendationReason(recommendationProblem, true);
    return;
  }
  if (!recommendation) {
    hidePace();
    nodes.calorieTarget.hidden = true;
    setRecommendationReason("", false);
    return;
  }
  const minKcal = recommendation.minKcal ?? recommendation.kcal;
  const maxKcal = recommendation.maxKcal ?? recommendation.kcal;
  if (minKcal === null || maxKcal === null) {
    hidePace();
    nodes.calorieTarget.hidden = true;
    nodes.calorieTarget.textContent = "";
    setRecommendationReason(recommendation.message, true);
    return;
  }
  paintPace(eaten, minKcal, maxKcal);
  const over = eaten > maxKcal;
  nodes.calorieTarget.hidden = !over;
  nodes.calorieTarget.textContent = over ? `${formatKcal(eaten - maxKcal)} over` : "";
  setRecommendationReason(recommendation.message, false);
}

function hidePace(): void {
  nodes.pace.hidden = true;
  nodes.pace.removeAttribute("aria-label");
}

function paintPace(eaten: number, minKcal: number, maxKcal: number): void {
  const dayFraction = eatingDayFraction();
  const meter = paceMeter({ eaten, minKcal, maxKcal, dayFraction });
  const dayPercent = Math.round(dayFraction * 100);
  nodes.pace.hidden = false;
  nodes.paceDay.textContent = `${dayPercent}% of the day`;
  placeRange(meter.rangeStart, meter.rangeEnd);
  placeMark(nodes.paceMarkNow, meter.now);
  placeMark(nodes.paceMarkDay, meter.day);
  paintScale(minKcal, maxKcal, meter.rangeStart, meter.rangeEnd);
  const range = minKcal === maxKcal ? `${formatKcal(maxKcal)} kcal` : `${formatKcal(minKcal)} to ${formatKcal(maxKcal)} kcal`;
  const over = eaten > maxKcal ? ` ${formatKcal(eaten - maxKcal)} over the top.` : "";
  nodes.pace.setAttribute(
    "aria-label",
    `${formatKcal(eaten)} kcal. Recommended ${range}. ${dayPercent}% of the day has passed, from 8:30 AM to 10:00 PM.${over}`,
  );
}

function placeRange(start: number, end: number): void {
  const point = end - start < 0.004;
  nodes.paceRange.classList.toggle("is-point", point);
  nodes.paceRange.style.left = `${start * 100}%`;
  nodes.paceRange.style.width = point ? "2px" : `${(end - start) * 100}%`;
}

function placeMark(mark: HTMLElement, fraction: number): void {
  mark.style.left = `${fraction * 100}%`;
}

function paintScale(minKcal: number, maxKcal: number, start: number, end: number): void {
  const label = (text: string, at: number): HTMLSpanElement => {
    const el = document.createElement("span");
    el.textContent = text;
    el.style.left = `${at * 100}%`;
    return el;
  };
  if (minKcal === maxKcal) {
    nodes.paceScale.replaceChildren(label(formatKcal(maxKcal), end));
    return;
  }
  const minLabel = label(formatKcal(minKcal), start);
  const maxLabel = label(formatKcal(maxKcal), end);
  nodes.paceScale.replaceChildren(minLabel, maxLabel);
  if (minLabel.getBoundingClientRect().right > maxLabel.getBoundingClientRect().left - 8) {
    nodes.paceScale.replaceChildren(label(`${formatKcal(minKcal)}–${formatKcal(maxKcal)}`, end));
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

window.setInterval(() => {
  if (!nodes.pace.hidden) paintRecommendation(eatenKcal());
}, 60_000);

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

let finishMealDelete: (() => void) | undefined;

function handleDelete(meal: Meal, row: HTMLLIElement): void {
  const index = meals.findIndex((item) => item.id === meal.id);
  if (index === -1) {
    return;
  }
  finishMealDelete?.();
  const snapshot = meals.slice();
  meals = meals.filter((item) => item.id !== meal.id);
  paintTotals(sumMacros(meals.map(shownMacros)));
  const restore = (): void => {
    meals = snapshot;
    paintList();
  };
  finishMealDelete = confirmDelete(
    row,
    `Removed ${formatTime(meal.eatenAt)}.`,
    async () => {
      await deleteMeal(meal.id);
      const empty = meals.length === 0;
      nodes.emptyEl.hidden = !empty;
      nodes.mealsEl.hidden = empty;
    },
    restore,
    (error) => {
      setError(error instanceof Error ? error.message : "Couldn't delete that meal.");
      nodes.input.focus();
    },
  );
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

type View = "food" | "journal" | "ask";

function viewFromPath(path: string): View {
  if (path === "/journal") {
    return "journal";
  }
  if (path === "/ask") {
    return "ask";
  }
  return "food";
}

function show(view: View): void {
  viewFood.hidden = view !== "food";
  viewJournal.hidden = view !== "journal";
  viewAsk.hidden = view !== "ask";
  document.title = view === "journal" ? "Taco · Journal" : view === "ask" ? "Taco · Ask" : "Taco · Food";
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
    const named = link.dataset.view;
    const view: View = named === "journal" || named === "ask" ? named : "food";
    if (location.pathname !== url.pathname) {
      history.pushState({}, "", url.pathname);
    }
    show(view);
  });
}

window.addEventListener("popstate", () => {
  if (location.pathname !== "/" && location.pathname !== "/journal" && location.pathname !== "/ask") {
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
mountAsk();

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
    if (!viewFood.hidden) {
      syncFood();
    } else if (!viewJournal.hidden) {
      syncJournal();
    }
  },
);
if (location.pathname !== "/" && location.pathname !== "/journal" && location.pathname !== "/ask") {
  history.replaceState({}, "", "/");
}
show(viewFromPath(location.pathname));
void load();
