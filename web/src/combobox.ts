import type { Suggestion } from "./api.js";
import { formatKcal } from "./macros.js";

export function mountCombobox(options: {
  input: HTMLInputElement;
  list: HTMLUListElement;
  fetchItems: (query: string) => Promise<Suggestion[]>;
  onSelect: (item: Suggestion) => void;
}): { close: () => void } {
  const { input, list, fetchItems, onSelect } = options;
  let items: Suggestion[] = [];
  let activeIndex = -1;
  let requestId = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function optionId(index: number): string {
    return `suggestion-${index}`;
  }

  function setActive(index: number): void {
    activeIndex = index;
    for (const [i, node] of [...list.children].entries()) {
      const selected = i === index;
      node.classList.toggle("active", selected);
      node.setAttribute("aria-selected", selected ? "true" : "false");
    }
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", optionId(index));
      list.children[index]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function render(next: Suggestion[]): void {
    items = next;
    activeIndex = -1;
    list.replaceChildren();
    if (items.length === 0) {
      close();
      return;
    }
    for (const [index, item] of items.entries()) {
      const option = document.createElement("li");
      option.id = optionId(index);
      option.role = "option";
      option.setAttribute("aria-selected", "false");

      const query = document.createElement("span");
      query.className = "suggestion-query";
      query.textContent = item.query;

      const kcal = document.createElement("span");
      kcal.className = "suggestion-kcal";
      kcal.textContent = `${formatKcal(item.macros.caloriesKcal)} kcal`;

      option.append(query, kcal);
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      option.addEventListener("click", () => {
        onSelect(item);
        close();
      });
      list.append(option);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function blank(): boolean {
    return input.value.trim() === "";
  }

  async function load(): Promise<void> {
    if (blank()) {
      close();
      return;
    }
    const id = ++requestId;
    try {
      const next = await fetchItems(input.value);
      if (id !== requestId) {
        return;
      }
      render(next);
    } catch {
      if (id === requestId) {
        close();
      }
    }
  }

  function scheduleLoad(): void {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      void load();
    }, 150);
  }

  input.addEventListener("input", () => {
    scheduleLoad();
  });

  input.addEventListener("focus", () => {
    void load();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        close();
      }
    }, 0);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      if (blank()) {
        close();
        return;
      }
      event.preventDefault();
      if (list.hidden) {
        void load();
        return;
      }
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Escape") {
      close();
    } else if (event.key === "Enter" && !list.hidden && activeIndex >= 0) {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) {
        onSelect(item);
        close();
      }
    } else if (event.key === "Tab") {
      close();
    }
  });

  return { close };
}

export function mountStringCombobox(options: {
  input: HTMLInputElement;
  list: HTMLUListElement;
  idPrefix: string;
  getItems: () => string[];
}): { close: () => void } {
  const { input, list, idPrefix, getItems } = options;
  let items: string[] = [];
  let activeIndex = -1;

  function close(): void {
    list.hidden = true;
    list.replaceChildren();
    items = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function setActive(index: number): void {
    activeIndex = index;
    for (const [i, node] of [...list.children].entries()) {
      const selected = i === index;
      node.classList.toggle("active", selected);
      node.setAttribute("aria-selected", selected ? "true" : "false");
    }
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", `${idPrefix}-${index}`);
      list.children[index]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function blank(): boolean {
    return input.value.trim() === "";
  }

  function render(): void {
    if (blank()) {
      close();
      return;
    }
    items = getItems();
    activeIndex = -1;
    list.replaceChildren();
    if (items.length === 0) {
      close();
      return;
    }
    for (const [index, item] of items.entries()) {
      const option = document.createElement("li");
      option.id = `${idPrefix}-${index}`;
      option.role = "option";
      option.setAttribute("aria-selected", "false");
      const label = document.createElement("span");
      label.className = "suggestion-query";
      label.textContent = item;
      option.append(label);
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      option.addEventListener("click", () => {
        input.value = item;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        close();
      });
      list.append(option);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  input.role = "combobox";
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);

  input.addEventListener("input", () => {
    render();
  });
  input.addEventListener("focus", () => {
    render();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        close();
      }
    }, 0);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      if (blank()) {
        close();
        return;
      }
      event.preventDefault();
      if (list.hidden) {
        render();
        return;
      }
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Escape") {
      close();
    } else if (event.key === "Enter" && !list.hidden && activeIndex >= 0) {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) {
        input.value = item;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        close();
      }
    } else if (event.key === "Tab") {
      close();
    }
  });

  return { close };
}
