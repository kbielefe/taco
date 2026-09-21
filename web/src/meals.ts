import type { Meal, MealItem } from "./api.js";
import { formatGrams, formatKcal, formatMacroLine } from "./macros.js";
import { formatTime } from "./time.js";

function itemRow(item: MealItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "meal-item";

  const title = document.createElement("p");
  title.className = "meal-item-title";
  title.textContent = `${item.name} · ${item.servingDescription} · ${formatGrams(item.grams)} g`;

  const source = document.createElement("p");
  source.className = "muted";
  source.textContent = `${item.description} · ${item.dataType}`;

  const macros = document.createElement("p");
  macros.className = "meal-item-macros";
  macros.textContent = formatMacroLine(item.macros);

  li.append(title, source, macros);
  return li;
}

export function renderMeal(meal: Meal, onDelete: (meal: Meal, row: HTMLLIElement) => void): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "meal-row";
  row.dataset.id = meal.id;

  const article = document.createElement("article");
  article.className = "meal";

  const top = document.createElement("div");
  top.className = "meal-top";

  const time = document.createElement("time");
  time.dateTime = meal.eatenAt;
  time.textContent = formatTime(meal.eatenAt);

  const kcal = document.createElement("p");
  kcal.className = "meal-kcal";
  kcal.textContent = `${formatKcal(meal.macros.caloriesKcal)} kcal`;

  top.append(time, kcal);

  const title = document.createElement("h3");
  title.className = "meal-title";
  title.textContent = meal.description;

  const actions = document.createElement("div");
  actions.className = "meal-actions";

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  details.append(summary);

  if (meal.query.trim().toLowerCase() !== meal.description.trim().toLowerCase()) {
    const query = document.createElement("p");
    query.className = "muted meal-query";
    query.textContent = `Logged as “${meal.query}”`;
    details.append(query);
  }

  const items = document.createElement("ul");
  items.className = "meal-items";
  for (const item of meal.items) {
    items.append(itemRow(item));
  }
  details.append(items);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "Delete";
  del.setAttribute("aria-label", `Delete ${meal.description}`);
  del.addEventListener("click", () => {
    onDelete(meal, row);
  });

  actions.append(details, del);
  article.append(top, title, actions);
  row.append(article);
  return row;
}
