import type { Meal, MealItem } from "./api.js";
import { formatGrams, formatKcal, formatMacroLine, scaleMacros } from "./macros.js";
import { formatTime } from "./time.js";
import { titleCase } from "./title.js";

export const MAX_SERVINGS = 24;

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(children: SVGElement[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.append(...children);
  return svg;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function trashIcon(): SVGSVGElement {
  return svgIcon([
    svgEl("path", { d: "M3 6h18" }),
    svgEl("path", { d: "M8 6V4h8v2" }),
    svgEl("path", { d: "M19 6l-1 14H6L5 6" }),
    svgEl("path", { d: "M10 11v6" }),
    svgEl("path", { d: "M14 11v6" }),
  ]);
}

function mealTitle(meal: Meal): string {
  if (meal.items.length > 0) {
    return titleCase(meal.items.map((item) => item.name).join(" and "));
  }
  return titleCase(stripPortions(meal.description));
}

function stripPortions(text: string): string {
  let current = text;
  let next = current.replace(/\s*\([^()]*\)/g, "");
  while (next !== current) {
    current = next;
    next = current.replace(/\s*\([^()]*\)/g, "");
  }
  const trimmed = current.replace(/\s+/g, " ").trim();
  return trimmed === "" ? text : trimmed;
}

export function withServings(meal: Meal, servings: number): Meal {
  const current = meal.servings && meal.servings > 0 ? meal.servings : 1;
  if (servings === current) {
    return { ...meal, servings };
  }
  const factor = servings / current;
  return {
    ...meal,
    servings,
    macros: scaleMacros(meal.macros, factor),
    ...(meal.adjusted ? { adjusted: scaleMacros(meal.adjusted, factor) } : {}),
    items: meal.items.map((item) => ({
      ...item,
      grams: Math.round(item.grams * factor * 10) / 10,
      macros: scaleMacros(item.macros, factor),
    })),
  };
}

function itemRow(item: MealItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "meal-item";

  const title = document.createElement("p");
  title.className = "meal-item-title";
  title.textContent = `${item.name} · ${formatGrams(item.grams)} g`;

  const source = document.createElement("p");
  source.className = "muted";
  source.textContent = `${item.description} · ${item.dataType}`;

  const macros = document.createElement("p");
  macros.className = "meal-item-macros";
  macros.textContent = formatMacroLine(item.correction ? scaleMacros(item.macros, item.correction.factor) : item.macros);

  li.append(title, source, macros);
  return li;
}

export function renderMeal(
  meal: Meal,
  onDelete: (meal: Meal, row: HTMLLIElement) => void,
  onServings: (meal: Meal, servings: number) => void,
  expanded: boolean,
  onToggle: (open: boolean) => void,
): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "meal-row";
  row.dataset.id = meal.id;

  const article = document.createElement("article");
  article.className = "meal";

  const titleText = mealTitle(meal);
  const when = formatTime(meal.eatenAt);
  const count = meal.servings && meal.servings > 0 ? meal.servings : 1;
  const shownKcal = meal.adjusted?.caloriesKcal ?? meal.macros.caloriesKcal;

  const head = document.createElement("div");
  head.className = "log-head";

  const extraId = `meal-extra-${meal.id}`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "log-open";
  open.setAttribute("aria-expanded", String(expanded));
  open.setAttribute("aria-controls", extraId);

  const title = document.createElement("span");
  title.className = "log-title";
  title.textContent = titleText;

  const kcal = document.createElement("span");
  kcal.className = "log-value";
  kcal.textContent = formatKcal(shownKcal);
  const unit = document.createElement("span");
  unit.className = "visually-hidden";
  unit.textContent = " calories";
  open.append(title, kcal, unit);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-button delete log-delete";
  del.setAttribute("aria-label", `Delete ${when} ${titleText}`);
  del.append(trashIcon());
  del.addEventListener("click", () => {
    onDelete(meal, row);
  });
  head.append(open, del);

  const meta = document.createElement("div");
  meta.className = "log-meta";
  const time = document.createElement("time");
  time.dateTime = meal.eatenAt;
  time.textContent = when;

  const stepper = document.createElement("div");
  stepper.className = "stepper";
  stepper.setAttribute("role", "group");
  stepper.setAttribute("aria-label", "Servings");

  const fewer = document.createElement("button");
  fewer.type = "button";
  fewer.setAttribute("aria-label", `Fewer servings of ${titleText}`);
  fewer.textContent = "−";
  fewer.disabled = count <= 1;

  const amount = document.createElement("span");
  amount.textContent = String(count);

  const more = document.createElement("button");
  more.type = "button";
  more.setAttribute("aria-label", `More servings of ${titleText}`);
  more.textContent = "+";
  more.disabled = count >= MAX_SERVINGS;

  fewer.addEventListener("click", () => {
    onServings(meal, count - 1);
  });
  more.addEventListener("click", () => {
    onServings(meal, count + 1);
  });
  stepper.append(fewer, amount, more);
  meta.append(time, stepper);

  const details = document.createElement("div");
  details.className = "meal-extra";
  details.id = extraId;
  details.hidden = !expanded;
  if (meal.query.trim().toLowerCase() !== titleText.trim().toLowerCase()) {
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

  open.addEventListener("click", () => {
    const next = details.hidden;
    details.hidden = !next;
    open.setAttribute("aria-expanded", String(next));
    onToggle(next);
  });

  article.append(head, meta, details);
  row.append(article);
  return row;
}
