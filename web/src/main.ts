import { deleteMeal, fetchMeals, fetchSuggestions, logMeal, type Macros, type Meal } from "./api.js";
import { mountCombobox } from "./combobox.js";
import { emptyMacros, formatGrams, formatKcal, sumMacros } from "./macros.js";
import { renderMeal } from "./meals.js";
import { formatDay, localDayRange } from "./time.js";
import "./styles.css";

function required<T extends Element>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const nodes = {
  dateLabel: required(document.querySelector<HTMLParagraphElement>("#date-label"), "date-label"),
  totalKcal: required(document.querySelector<HTMLSpanElement>("#total-kcal"), "total-kcal"),
  totalProtein: required(document.querySelector<HTMLSpanElement>("#total-protein"), "total-protein"),
  totalFat: required(document.querySelector<HTMLSpanElement>("#total-fat"), "total-fat"),
  totalCarb: required(document.querySelector<HTMLSpanElement>("#total-carb"), "total-carb"),
  totalFiber: required(document.querySelector<HTMLSpanElement>("#total-fiber"), "total-fiber"),
  form: required(document.querySelector<HTMLFormElement>("#log-form"), "log-form"),
  input: required(document.querySelector<HTMLInputElement>("#meal"), "meal"),
  listbox: required(document.querySelector<HTMLUListElement>("#suggestions"), "suggestions"),
  logButton: required(document.querySelector<HTMLButtonElement>("#log-button"), "log-button"),
  errorEl: required(document.querySelector<HTMLParagraphElement>("#meal-error"), "meal-error"),
  statusEl: required(document.querySelector<HTMLParagraphElement>("#meal-status"), "meal-status"),
  emptyEl: required(document.querySelector<HTMLParagraphElement>("#empty"), "empty"),
  mealsEl: required(document.querySelector<HTMLOListElement>("#meals"), "meals"),
};

let meals: Meal[] = [];

function paintTotals(macros: Macros): void {
  nodes.totalKcal.textContent = formatKcal(macros.caloriesKcal);
  nodes.totalProtein.textContent = formatGrams(macros.proteinG);
  nodes.totalFat.textContent = formatGrams(macros.fatG);
  nodes.totalCarb.textContent = formatGrams(macros.carbG);
  nodes.totalFiber.textContent = formatGrams(macros.fiberG);
}

function paintList(): void {
  nodes.mealsEl.replaceChildren();
  for (const meal of meals) {
    nodes.mealsEl.append(renderMeal(meal, handleDelete));
  }
  const empty = meals.length === 0;
  nodes.emptyEl.hidden = !empty;
  nodes.mealsEl.hidden = empty;
  paintTotals(sumMacros(meals.map((meal) => meal.macros)));
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
  paintTotals(sumMacros(meals.map((item) => item.macros)));
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
    setBusy(false);
    nodes.input.focus();
  }
});

async function load(): Promise<void> {
  nodes.dateLabel.textContent = formatDay(new Date());
  paintTotals(emptyMacros);
  try {
    const { from, to } = localDayRange();
    const result = await fetchMeals(from, to);
    meals = result.meals;
    paintList();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Couldn't load today's meals.");
  }
}

void load();
