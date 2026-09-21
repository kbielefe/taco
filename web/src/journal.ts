import {
  appendKind,
  deleteJournalEntry,
  fetchJournal,
  fetchKinds,
  logJournal,
  type FieldType,
  type JournalEntry,
  type JournalField,
  type JournalFieldInput,
  type JournalKind,
  type JournalValue,
} from "./api.js";
import { formatTime, localDayRange } from "./time.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "enum", label: "Choice" },
  { value: "text", label: "Text" },
  { value: "boolean", label: "Yes/no" },
  { value: "event", label: "Event" },
];

interface Draft {
  label: string;
  type: FieldType | "";
  unit: string;
  options: string;
}

interface Editor {
  key: string;
  read(): { value: JournalValue["value"] } | { error: string } | undefined;
  clear(): void;
  focus(): void;
  restore(value: JournalValue["value"]): void;
}

type Mode = "idle" | "existing" | "create";

function required<T extends Element>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function sameName(a: string, b: string): boolean {
  return normalize(a).toLocaleLowerCase("en-US") === normalize(b).toLocaleLowerCase("en-US");
}

function splitOptions(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalize(part))
    .filter((part) => part.length > 0);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Math.round(value * 100) / 100);
}

function formatFieldValue(field: JournalField, value: JournalValue["value"]): string | undefined {
  if (field.type === "event") {
    return undefined;
  }
  if (field.type === "number" && typeof value === "number") {
    return `${formatNumber(value)} ${field.unit ?? ""}`.trim();
  }
  if (field.type === "boolean") {
    return value ? "Yes" : "No";
  }
  return typeof value === "string" ? value : undefined;
}

function figureFor(entry: JournalEntry): string {
  const parts: string[] = [];
  for (const field of entry.kind.fields) {
    const stored = entry.values.find((value) => value.fieldId === field.id);
    if (!stored) {
      continue;
    }
    const formatted = formatFieldValue(field, stored.value);
    if (formatted) {
      parts.push(formatted);
    }
  }
  return parts.join(" · ");
}

function isFieldType(value: string): value is FieldType {
  return FIELD_TYPES.some((type) => type.value === value);
}

function isBlank(draft: Draft): boolean {
  return !normalize(draft.label) && !draft.type && !normalize(draft.unit) && !normalize(draft.options);
}

function buildField(draft: Draft): JournalFieldInput | string {
  const label = normalize(draft.label);
  if (!label) {
    return "Name that field.";
  }
  if (label.length > 40) {
    return "That field name is too long.";
  }
  if (!draft.type) {
    return "Choose number, choice, text, yes/no, or event.";
  }
  if (draft.type === "number") {
    const unit = normalize(draft.unit);
    if (!unit) {
      return "Enter a unit, such as lb or bpm.";
    }
    if (unit.length > 20) {
      return "That unit is too long.";
    }
    return { label, type: "number", unit };
  }
  if (draft.type === "enum") {
    const options = splitOptions(draft.options);
    if (options.length < 2) {
      return "Add at least two choices.";
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (option.length > 40) {
        return "That choice is too long.";
      }
      const key = option.toLocaleLowerCase("en-US");
      if (seen.has(key)) {
        return "Those choices are the same.";
      }
      seen.add(key);
    }
    return { label, type: "enum", options };
  }
  return { label, type: draft.type };
}

function buildFields(drafts: Draft[]): JournalFieldInput[] | string {
  const fields: JournalFieldInput[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const built = buildField(draft);
    if (typeof built === "string") {
      return built;
    }
    const key = built.label.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      return "Those fields have the same name.";
    }
    seen.add(key);
    fields.push(built);
  }
  if (fields.length === 0) {
    return "Add at least one field.";
  }
  return fields;
}

function deleteIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ["M3 6h18", "M8 6V4h8v2", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M10 11v6", "M14 11v6"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function mountJournal(): { load: () => Promise<void> } {
  const form = required(document.querySelector<HTMLFormElement>("#journal-form"), "journal-form");
  const input = required(document.querySelector<HTMLInputElement>("#kind"), "kind");
  const list = required(document.querySelector<HTMLUListElement>("#kind-list"), "kind-list");
  const errorEl = required(document.querySelector<HTMLParagraphElement>("#journal-error"), "journal-error");
  const setup = required(document.querySelector<HTMLDivElement>("#kind-setup"), "kind-setup");
  const fieldsHost = required(document.querySelector<HTMLDivElement>("#entry-fields"), "entry-fields");
  const addFieldButton = required(document.querySelector<HTMLButtonElement>("#add-field"), "add-field");
  const logButton = required(document.querySelector<HTMLButtonElement>("#journal-log"), "journal-log");
  const emptyEl = required(document.querySelector<HTMLParagraphElement>("#journal-empty"), "journal-empty");
  const entriesEl = required(document.querySelector<HTMLOListElement>("#journal-entries"), "journal-entries");
  const summary = required(document.querySelector<HTMLElement>("#journal-summary"), "journal-summary");
  const summaryList = required(document.querySelector<HTMLUListElement>("#latest-numbers"), "latest-numbers");

  let kinds: JournalKind[] = [];
  let entries: JournalEntry[] = [];
  let mode: Mode = "idle";
  let selected: JournalKind | null = null;
  let drafts: Draft[] = [];
  let appending = false;
  let createLabel = "";
  let editors: Editor[] = [];
  let options: { label: string; kind: JournalKind | null }[] = [];
  let activeIndex = -1;

  function setError(message: string | undefined): void {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      input.removeAttribute("aria-invalid");
      input.setAttribute("aria-describedby", "kind-hint");
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "kind-hint journal-error");
  }

  function setBusy(busy: boolean): void {
    logButton.disabled = busy;
    addFieldButton.disabled = busy;
  }

  function closeList(): void {
    list.hidden = true;
    list.replaceChildren();
    options = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function setActive(index: number): void {
    activeIndex = index;
    for (const [i, node] of [...list.children].entries()) {
      const selectedOption = i === index;
      node.classList.toggle("active", selectedOption);
      node.setAttribute("aria-selected", selectedOption ? "true" : "false");
    }
    if (index >= 0) {
      input.setAttribute("aria-activedescendant", `kind-option-${index}`);
      list.children[index]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function optionItems(query: string): { label: string; kind: JournalKind | null }[] {
    const needle = normalize(query).toLocaleLowerCase("en-US");
    const matches = (needle
      ? kinds.filter((kind) => kind.label.toLocaleLowerCase("en-US").includes(needle))
      : kinds
    ).slice(0, 8);
    const items: { label: string; kind: JournalKind | null }[] = matches.map((kind) => ({ label: kind.label, kind }));
    const exact = needle.length > 0 && kinds.some((kind) => sameName(kind.label, query));
    if (needle && !exact) {
      items.push({ label: `Add “${normalize(query)}”`, kind: null });
    }
    return items;
  }

  function renderOptions(): void {
    options = optionItems(input.value);
    activeIndex = -1;
    list.replaceChildren();
    if (options.length === 0) {
      closeList();
      return;
    }
    for (const [index, option] of options.entries()) {
      const row = el("li");
      row.id = `kind-option-${index}`;
      row.role = "option";
      row.setAttribute("aria-selected", "false");
      row.append(el("span", "suggestion-query", option.label));
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      row.addEventListener("click", () => {
        chooseOption(option);
      });
      list.append(row);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function chooseOption(option: { label: string; kind: JournalKind | null }): void {
    closeList();
    if (option.kind) {
      selectExisting(option.kind);
      return;
    }
    beginCreate(normalize(input.value));
  }

  function updateAddButton(): void {
    addFieldButton.hidden = mode === "idle" || (mode === "existing" && appending);
  }

  function selectExisting(kind: JournalKind): void {
    mode = "existing";
    selected = kind;
    appending = false;
    drafts = [];
    createLabel = "";
    input.value = kind.label;
    closeList();
    renderSetup();
    renderEntryFields();
    updateAddButton();
    focusFirst();
  }

  function beginCreate(label: string): void {
    mode = "create";
    selected = null;
    appending = false;
    createLabel = label;
    drafts = [{ label, type: "", unit: "", options: "" }];
    input.value = label;
    closeList();
    renderSetup();
    renderEntryFields();
    updateAddButton();
    setup.querySelector("select")?.focus();
  }

  function clearComposer(): void {
    mode = "idle";
    selected = null;
    appending = false;
    drafts = [];
    createLabel = "";
    renderSetup();
    renderEntryFields();
    updateAddButton();
  }

  function renderSetup(): void {
    setup.replaceChildren();
    if (mode !== "create" && !appending) {
      return;
    }
    drafts.forEach((draft, index) => {
      setup.append(renderDraft(draft, index));
    });
  }

  function renderDraft(draft: Draft, index: number): HTMLDivElement {
    const row = el("div", "draft");
    const labelInput = el("input");
    labelInput.value = draft.label;
    labelInput.autocomplete = "off";
    labelInput.setAttribute("aria-label", "Field name");
    labelInput.addEventListener("input", () => {
      draft.label = labelInput.value;
      renderEntryFields();
    });

    const type = el("select");
    type.append(new Option("Choose", ""));
    for (const item of FIELD_TYPES) {
      type.append(new Option(item.label, item.value));
    }
    type.value = draft.type;
    type.setAttribute("aria-label", "Field type");

    const unitBlock = el("div", "unit-block");
    const unitInput = el("input");
    unitInput.value = draft.unit;
    unitInput.autocomplete = "off";
    unitInput.setAttribute("aria-label", "Unit");
    unitInput.addEventListener("input", () => {
      draft.unit = unitInput.value;
      renderEntryFields();
    });
    const unitLabel = el("label", "stack", "Unit");
    unitLabel.append(unitInput);
    unitBlock.append(unitLabel, el("p", "hint", "This unit stays fixed, so later charts stay in one unit."));

    const optionsBlock = el("div", "options-block");
    const optionsInput = el("input");
    optionsInput.value = draft.options;
    optionsInput.autocomplete = "off";
    optionsInput.setAttribute("aria-label", "Choices");
    const chips = el("ul", "chips");
    const paintChips = (): void => {
      chips.replaceChildren();
      for (const option of splitOptions(optionsInput.value)) {
        chips.append(el("li", undefined, option));
      }
      chips.hidden = chips.childElementCount === 0;
    };
    optionsInput.addEventListener("input", () => {
      draft.options = optionsInput.value;
      paintChips();
      renderEntryFields();
    });
    paintChips();
    const optionsLabel = el("label", "stack", "Choices");
    optionsLabel.append(optionsInput);
    optionsBlock.append(
      optionsLabel,
      chips,
      el("p", "hint", "Order is low to high, such as mild, moderate, severe."),
    );

    const syncType = (): void => {
      unitBlock.hidden = draft.type !== "number";
      optionsBlock.hidden = draft.type !== "enum";
    };
    type.addEventListener("change", () => {
      draft.type = isFieldType(type.value) ? type.value : "";
      syncType();
      renderEntryFields();
    });
    syncType();

    const nameLabel = el("label", "stack", "Field");
    nameLabel.append(labelInput);
    const typeLabel = el("label", "stack", "Type");
    typeLabel.append(type);
    row.append(nameLabel, typeLabel, unitBlock, optionsBlock);

    if (appending) {
      const cancel = el("button", "button-secondary", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        appending = false;
        drafts = [];
        renderSetup();
        renderEntryFields();
        updateAddButton();
      });
      row.append(cancel);
    } else if (index > 0) {
      const remove = el("button", "button-secondary", "Remove field");
      remove.type = "button";
      remove.addEventListener("click", () => {
        drafts.splice(index, 1);
        renderSetup();
        renderEntryFields();
      });
      row.append(remove);
    }
    return row;
  }

  function renderEntryFields(): void {
    const saved = editors.map((editor) => ({ key: editor.key, value: editor.read() }));
    fieldsHost.replaceChildren();
    editors = [];
    if (mode === "existing" && selected) {
      for (const field of selected.fields) {
        fieldsHost.append(renderValueField(field, field.id));
      }
    }
    if (mode === "create" || appending) {
      drafts.forEach((draft, index) => {
        const preview = previewField(draft, index);
        if (preview) {
          fieldsHost.append(renderValueField(preview, `draft:${index}`));
        }
      });
    }
    for (const item of saved) {
      if (!item.value || "error" in item.value) {
        continue;
      }
      editors.find((editor) => editor.key === item.key)?.restore(item.value.value);
    }
  }

  function previewField(draft: Draft, index: number): JournalField | undefined {
    if (!draft.type) {
      return undefined;
    }
    const label = normalize(draft.label) || `Field ${index + 1}`;
    if (draft.type === "number") {
      return { id: `draft:${index}`, label, type: "number", unit: normalize(draft.unit) };
    }
    if (draft.type === "enum") {
      const options = splitOptions(draft.options);
      if (options.length === 0) {
        return undefined;
      }
      return { id: `draft:${index}`, label, type: "enum", options };
    }
    return { id: `draft:${index}`, label, type: draft.type };
  }

  function renderValueField(field: JournalField, key: string): HTMLDivElement {
    const block = el("div", "entry-field");
    block.append(el("p", "entry-label", field.label));
    if (field.type === "number") {
      block.append(numberEditor(field, key));
    } else if (field.type === "enum" && field.options) {
      block.append(choiceEditor(field.label, field.options, key));
      if (selected && mode === "existing" && !key.startsWith("draft:")) {
        block.append(addOptionRow(field));
      }
    } else if (field.type === "text") {
      block.append(textEditor(field, key));
    } else if (field.type === "boolean") {
      block.append(booleanEditor(field.label, key));
    } else {
      block.append(eventEditor(field.label, key));
    }
    return block;
  }

  function numberEditor(field: JournalField, key: string): HTMLDivElement {
    const wrap = el("div", "number-row");
    const box = el("input", "text-input");
    box.inputMode = "decimal";
    box.autocomplete = "off";
    box.setAttribute("aria-label", field.label);
    const editor: Editor = {
      key,
      read: () => {
        const raw = box.value.trim();
        if (raw === "") {
          return undefined;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          return { error: "Enter a number." };
        }
        return { value };
      },
      clear: () => {
        box.value = "";
      },
      focus: () => {
        box.focus();
      },
      restore: (value) => {
        if (typeof value === "number") {
          box.value = String(value);
        }
      },
    };
    editors.push(editor);
    wrap.append(box, el("span", "unit-suffix", field.unit ?? ""));
    return wrap;
  }

  function choiceEditor(label: string, options: string[], key: string): HTMLDivElement {
    const row = el("div", "choice-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    const buttons: HTMLButtonElement[] = [];
    for (const option of options) {
      const button = el("button", "choice", option);
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const wasOn = button.getAttribute("aria-pressed") === "true";
        for (const other of buttons) {
          other.setAttribute("aria-pressed", "false");
        }
        button.setAttribute("aria-pressed", wasOn ? "false" : "true");
      });
      buttons.push(button);
      row.append(button);
    }
    editors.push({
      key,
      read: () => {
        const pressed = buttons.find((button) => button.getAttribute("aria-pressed") === "true");
        return pressed?.textContent ? { value: pressed.textContent } : undefined;
      },
      clear: () => {
        for (const button of buttons) {
          button.setAttribute("aria-pressed", "false");
        }
      },
      focus: () => {
        buttons[0]?.focus();
      },
      restore: (value) => {
        for (const button of buttons) {
          button.setAttribute("aria-pressed", button.textContent === value ? "true" : "false");
        }
      },
    });
    return row;
  }

  function textEditor(field: JournalField, key: string): HTMLInputElement {
    const box = el("input", "text-input");
    box.autocomplete = "off";
    box.spellcheck = true;
    box.setAttribute("aria-label", field.label);
    const listId = `suggest-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
    const suggestions = selected?.suggestions[field.id] ?? [];
    if (suggestions.length > 0 && !key.startsWith("draft:")) {
      box.setAttribute("list", listId);
      const data = el("datalist");
      data.id = listId;
      for (const suggestion of suggestions) {
        const option = el("option");
        option.value = suggestion;
        data.append(option);
      }
      fieldsHost.append(data);
    }
    editors.push({
      key,
      read: () => {
        const value = normalize(box.value);
        return value ? { value } : undefined;
      },
      clear: () => {
        box.value = "";
      },
      focus: () => {
        box.focus();
      },
      restore: (value) => {
        if (typeof value === "string") {
          box.value = value;
        }
      },
    });
    return box;
  }

  function booleanEditor(label: string, key: string): HTMLDivElement {
    return toggleEditor(label, key, [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ]);
  }

  function eventEditor(label: string, key: string): HTMLDivElement {
    return toggleEditor(label, key, [{ label, value: true }]);
  }

  function toggleEditor(
    label: string,
    key: string,
    items: { label: string; value: boolean }[],
  ): HTMLDivElement {
    const row = el("div", "choice-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    const buttons: HTMLButtonElement[] = [];
    for (const item of items) {
      const button = el("button", "choice", item.label);
      button.type = "button";
      button.dataset.value = item.value ? "true" : "false";
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const wasOn = button.getAttribute("aria-pressed") === "true";
        for (const other of buttons) {
          other.setAttribute("aria-pressed", "false");
        }
        button.setAttribute("aria-pressed", wasOn ? "false" : "true");
      });
      buttons.push(button);
      row.append(button);
    }
    editors.push({
      key,
      read: () => {
        const pressed = buttons.find((button) => button.getAttribute("aria-pressed") === "true");
        if (!pressed) {
          return undefined;
        }
        return { value: pressed.dataset.value === "true" };
      },
      clear: () => {
        for (const button of buttons) {
          button.setAttribute("aria-pressed", "false");
        }
      },
      focus: () => {
        buttons[0]?.focus();
      },
      restore: (value) => {
        const token = value === true ? "true" : value === false ? "false" : "";
        for (const button of buttons) {
          button.setAttribute("aria-pressed", token !== "" && button.dataset.value === token ? "true" : "false");
        }
      },
    });
    return row;
  }

  function addOptionRow(field: JournalField): HTMLDivElement {
    const row = el("div", "inline-add");
    const box = el("input", "text-input");
    box.autocomplete = "off";
    box.setAttribute("aria-label", `Add a choice to ${field.label}`);
    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void addOption(field, box);
      }
    });
    const button = el("button", "button-secondary", "Add option");
    button.type = "button";
    button.addEventListener("click", () => {
      void addOption(field, box);
    });
    row.append(box, button);
    return row;
  }

  async function addOption(field: JournalField, box: HTMLInputElement): Promise<void> {
    if (!selected) {
      return;
    }
    const option = normalize(box.value);
    if (!option) {
      setError("Name that choice.");
      box.focus();
      return;
    }
    const saved = readValues();
    setError(undefined);
    setBusy(true);
    try {
      const updated = await appendKind(selected.id, { addOptions: [{ fieldId: field.id, options: [option] }] });
      rememberKind(updated);
      selected = updated;
      renderEntryFields();
      if (saved && !("error" in saved)) {
        restoreValues(saved.values);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't add that choice.");
    } finally {
      setBusy(false);
    }
  }

  function readValues(): { values: { key: string; value: JournalValue["value"] }[] } | { error: string } {
    const values: { key: string; value: JournalValue["value"] }[] = [];
    for (const editor of editors) {
      const result = editor.read();
      if (!result) {
        continue;
      }
      if ("error" in result) {
        return result;
      }
      values.push({ key: editor.key, value: result.value });
    }
    return { values };
  }

  function restoreValues(values: { key: string; value: JournalValue["value"] }[]): void {
    for (const value of values) {
      editors.find((editor) => editor.key === value.key)?.restore(value.value);
    }
  }

  function focusFirst(): void {
    if (editors[0]) {
      editors[0].focus();
      return;
    }
    logButton.focus();
  }

  function rememberKind(kind: JournalKind): void {
    const index = kinds.findIndex((item) => item.id === kind.id);
    if (index === -1) {
      kinds.unshift(kind);
      return;
    }
    kinds[index] = kind;
  }

  function paintSummary(): void {
    summaryList.replaceChildren();
    for (const kind of kinds) {
      const numberFields = kind.fields.filter((field) => field.type === "number");
      for (const field of numberFields) {
        const entry = entries.find(
          (item) => item.kind.id === kind.id && item.values.some((value) => value.fieldId === field.id),
        );
        const stored = entry?.values.find((value) => value.fieldId === field.id);
        if (!stored || typeof stored.value !== "number") {
          continue;
        }
        const cell = el("li", "macro");
        cell.append(
          el("span", "macro-label", numberFields.length === 1 ? kind.label : `${kind.label} · ${field.label}`),
          el("span", "macro-value", `${formatNumber(stored.value)} ${field.unit ?? ""}`.trim()),
        );
        summaryList.append(cell);
      }
    }
    summary.hidden = summaryList.childElementCount === 0;
  }

  function paintEntries(): void {
    entriesEl.replaceChildren();
    for (const entry of entries) {
      entriesEl.append(renderEntry(entry));
    }
    const empty = entries.length === 0;
    emptyEl.hidden = !empty;
    entriesEl.hidden = empty;
    paintSummary();
  }

  function renderEntry(entry: JournalEntry): HTMLLIElement {
    const row = el("li", "meal-row");
    row.dataset.id = entry.id;
    const article = el("article", "meal");
    const top = el("div", "meal-top journal-top");
    const time = el("time");
    time.dateTime = entry.at;
    time.textContent = formatTime(entry.at);
    const title = el("h3", "meal-title", entry.kind.label);
    const end = el("div", "meal-end");
    const del = el("button", "icon-button delete");
    del.type = "button";
    del.setAttribute("aria-label", `Delete ${entry.kind.label}`);
    del.append(deleteIcon());
    del.addEventListener("click", () => {
      void removeEntry(entry, row);
    });
    end.append(del);
    const figure = figureFor(entry);
    if (figure) {
      end.append(el("p", "meal-kcal", figure));
    }
    top.append(time, title, end);
    article.append(top);
    row.append(article);
    return row;
  }

  async function removeEntry(entry: JournalEntry, row: HTMLLIElement): Promise<void> {
    const snapshot = entries.slice();
    entries = entries.filter((item) => item.id !== entry.id);
    row.remove();
    const empty = entries.length === 0;
    emptyEl.hidden = !empty;
    entriesEl.hidden = empty;
    paintSummary();
    try {
      await deleteJournalEntry(entry.id);
    } catch (error) {
      entries = snapshot;
      paintEntries();
      setError(error instanceof Error ? error.message : "Couldn't delete that entry.");
    }
  }

  async function refresh(): Promise<void> {
    const { from, to } = localDayRange();
    const [nextKinds, nextEntries] = await Promise.all([fetchKinds(), fetchJournal(from, to)]);
    kinds = nextKinds;
    entries = nextEntries;
    if (selected) {
      selected = kinds.find((kind) => kind.id === selected?.id) ?? null;
      if (!selected) {
        clearComposer();
      }
    }
    paintEntries();
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    closeList();
    if (mode === "idle") {
      const typed = normalize(input.value);
      const exact = kinds.find((kind) => sameName(kind.label, typed));
      if (exact) {
        selectExisting(exact);
        setError("Enter at least one thing.");
        return;
      }
      if (typed) {
        beginCreate(typed);
        setError("Choose number, choice, text, yes/no, or event.");
        return;
      }
      setError("Choose what you're recording.");
      input.focus();
      return;
    }

    const collected = readValues();
    if ("error" in collected) {
      setError(collected.error);
      return;
    }
    setError(undefined);

    if (mode === "create") {
      const built = buildFields(drafts);
      if (typeof built === "string") {
        setError(built);
        return;
      }
      if (!createLabel) {
        setError("Name what you're recording.");
        input.focus();
        return;
      }
      const values: JournalValue[] = [];
      built.forEach((field, index) => {
        const found = collected.values.find((value) => value.key === `draft:${index}`);
        if (found) {
          values.push({ fieldId: field.label, value: found.value });
        }
      });
      if (values.length === 0) {
        setError("Enter at least one thing.");
        return;
      }
      setBusy(true);
      try {
        const entry = await logJournal({ kind: { label: createLabel, fields: built }, values });
        await refresh();
        const kind = kinds.find((item) => item.id === entry.kind.id);
        if (kind) {
          selectExisting(kind);
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : "Couldn't save that.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!selected) {
      setError("Choose what you're recording.");
      return;
    }

    let kind = selected;
    const values: JournalValue[] = collected.values
      .filter((value) => !value.key.startsWith("draft:"))
      .map((value) => ({ fieldId: value.key, value: value.value }));
    const draft = appending ? drafts[0] : undefined;
    const draftValue = collected.values.find((value) => value.key === "draft:0");

    setBusy(true);
    try {
      if (draft && !isBlank(draft)) {
        const built = buildField(draft);
        if (typeof built === "string") {
          setError(built);
          return;
        }
        const updated = await appendKind(kind.id, { addFields: [built] });
        rememberKind(updated);
        kind = updated;
        selected = updated;
        appending = false;
        drafts = [];
        const created = updated.fields.find((field) => sameName(field.label, built.label));
        if (draftValue && created) {
          values.push({ fieldId: created.id, value: draftValue.value });
        }
        renderSetup();
        renderEntryFields();
        updateAddButton();
        restoreValues(values.map((value) => ({ key: value.fieldId, value: value.value })));
      }
      if (values.length === 0) {
        setError("Enter at least one thing.");
        return;
      }
      await logJournal({ kindId: kind.id, values });
      await refresh();
      const fresh = kinds.find((item) => item.id === kind.id);
      if (fresh) {
        selectExisting(fresh);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", (event) => {
    void submit(event);
  });

  addFieldButton.addEventListener("click", () => {
    if (mode === "create") {
      drafts.push({ label: "", type: "", unit: "", options: "" });
      renderSetup();
      renderEntryFields();
      const rows = setup.querySelectorAll(".draft");
      rows.item(rows.length - 1)?.querySelector("input")?.focus();
      return;
    }
    if (mode === "existing" && selected && !appending) {
      appending = true;
      drafts = [{ label: "", type: "", unit: "", options: "" }];
      renderSetup();
      updateAddButton();
      setup.querySelector("input")?.focus();
    }
  });

  input.addEventListener("input", () => {
    if (mode === "existing" && selected && !sameName(input.value, selected.label)) {
      clearComposer();
    } else if (mode === "create") {
      const next = normalize(input.value);
      const first = drafts[0];
      if (first && sameName(first.label, createLabel)) {
        first.label = next;
        const labelInput = setup.querySelector<HTMLInputElement>(".draft input");
        if (labelInput && document.activeElement !== labelInput) {
          labelInput.value = next;
        }
      }
      createLabel = next;
      renderEntryFields();
    }
    renderOptions();
  });

  input.addEventListener("focus", () => {
    renderOptions();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== input) {
        closeList();
      }
    }, 0);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.hidden) {
        renderOptions();
        return;
      }
      setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Escape") {
      closeList();
    } else if (event.key === "Enter" && !list.hidden && activeIndex >= 0) {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) {
        chooseOption(option);
      }
    } else if (event.key === "Tab") {
      closeList();
    }
  });

  return {
    load: async () => {
      try {
        await refresh();
      } catch (error) {
        setError(error instanceof Error ? error.message : "Couldn't load today's journal.");
      }
    },
  };
}
