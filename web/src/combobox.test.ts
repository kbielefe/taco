/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from "vitest";
import type { Suggestion } from "./api.js";
import { mountCombobox } from "./combobox.js";

const macros = { caloriesKcal: 100, proteinG: 1, fatG: 1, carbG: 1, fiberG: 1 };

function suggestion(query: string): Suggestion {
  return { query, description: query, macros };
}

function mount(options: {
  fetchItems?: (query: string) => Promise<Suggestion[]>;
  onSelect?: (item: Suggestion) => void;
  onForget?: (item: Suggestion) => Promise<void>;
  onForgetError?: (error: unknown) => void;
}): {
  input: HTMLInputElement;
  list: HTMLUListElement;
  close: () => void;
} {
  document.body.replaceChildren();
  const input = document.createElement("input");
  const list = document.createElement("ul");
  list.id = "suggestions";
  list.hidden = true;
  document.body.append(input, list);
  const { close } = mountCombobox({
    input,
    list,
    fetchItems: options.fetchItems ?? (async () => [suggestion("banana"), suggestion("Banana bread")]),
    onSelect: options.onSelect ?? (() => {}),
    onForget: options.onForget ?? (async () => {}),
    onForgetError: options.onForgetError,
  });
  return { input, list, close };
}

describe("mountCombobox forget", () => {
  it("removes a suggestion without selecting it and keeps the list open", async () => {
    const forgotten = new Set<string>();
    const selected: string[] = [];
    const { input, list } = mount({
      fetchItems: async () =>
        [suggestion("banana"), suggestion("Banana bread")].filter((item) => !forgotten.has(item.query)),
      onSelect: (item) => {
        selected.push(item.query);
      },
      onForget: async (item) => {
        forgotten.add(item.query);
      },
    });

    input.value = "ban";
    input.focus();
    await vi.waitFor(() => {
      expect(list.hidden).toBe(false);
      expect(list.children).toHaveLength(2);
    });

    const forget = list.querySelector<HTMLButtonElement>(".suggestion-forget");
    expect(forget?.getAttribute("aria-label")).toBe("Remove banana from suggestions");
    forget?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    forget?.click();

    await vi.waitFor(() => {
      expect([...forgotten]).toEqual(["banana"]);
      expect(selected).toEqual([]);
      expect(list.hidden).toBe(false);
      expect(list.children).toHaveLength(1);
      expect(list.querySelector(".suggestion-query")?.textContent).toBe("Banana bread");
    });
    expect(document.activeElement).toBe(input);
  });

  it("keeps the row when forget fails", async () => {
    const errors: unknown[] = [];
    const { input, list } = mount({
      onForget: async () => {
        throw new Error("nope");
      },
      onForgetError: (error) => {
        errors.push(error);
      },
    });

    input.value = "ban";
    input.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(list.children).toHaveLength(2));

    list.querySelector<HTMLButtonElement>(".suggestion-forget")?.click();

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
      expect(list.children).toHaveLength(2);
    });
  });
});
