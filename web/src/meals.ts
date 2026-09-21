import type { Meal, MealItem } from "./api.js";
import { formatGrams, formatKcal, formatMacroLine } from "./macros.js";
import { formatTime } from "./time.js";

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

function detailsIcon(): SVGSVGElement {
  return svgIcon([
    svgEl("circle", { cx: "12", cy: "12", r: "10" }),
    svgEl("path", { d: "M12 16v-4" }),
    svgEl("path", { d: "M12 8h.01" }),
  ]);
}

function deleteIcon(): SVGSVGElement {
  return svgIcon([
    svgEl("path", { d: "M3 6h18" }),
    svgEl("path", { d: "M8 6V4h8v2" }),
    svgEl("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }),
    svgEl("path", { d: "M10 11v6" }),
    svgEl("path", { d: "M14 11v6" }),
  ]);
}

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

  const end = document.createElement("div");
  end.className = "meal-end";

  const extraId = `meal-extra-${meal.id}`;
  const details = document.createElement("details");
  details.className = "meal-extra";
  details.id = extraId;

  const summary = document.createElement("summary");
  summary.className = "visually-hidden";
  summary.tabIndex = -1;
  summary.textContent = `Details for ${meal.description}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-button";
  toggle.setAttribute("aria-label", `Details for ${meal.description}`);
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", extraId);
  toggle.append(detailsIcon());
  const syncExpanded = (): void => {
    toggle.setAttribute("aria-expanded", String(details.open));
  };
  toggle.addEventListener("click", () => {
    details.open = !details.open;
    syncExpanded();
  });
  details.addEventListener("toggle", syncExpanded);

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
  del.className = "icon-button delete";
  del.setAttribute("aria-label", `Delete ${meal.description}`);
  del.append(deleteIcon());
  del.addEventListener("click", () => {
    onDelete(meal, row);
  });

  const kcal = document.createElement("p");
  kcal.className = "meal-kcal";
  kcal.textContent = `${formatKcal(meal.macros.caloriesKcal)} kcal`;

  end.append(toggle, del, kcal);
  top.append(time, end);

  const title = document.createElement("h3");
  title.className = "meal-title";
  title.textContent = meal.description;

  article.append(top, title, details);
  row.append(article);
  return row;
}
