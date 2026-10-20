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
import { mountStringCombobox } from "./combobox.js";
import { recentValueKey } from "../../src/journal/recent.js";
import { pickSuggestions } from "../../src/log/fuzzy.js";
import { formatTime, localDayRange } from "./time.js";
import { confirmDelete } from "./undo.js";

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
  subscribe(listener: (reason: "edit" | "blur") => void): void;
}

function editSignal(): {
  subscribe: Editor["subscribe"];
  emit: (reason: "edit" | "blur") => void;
} {
  const listeners = new Set<(reason: "edit" | "blur") => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
    },
    emit(reason) {
      for (const listener of listeners) {
        listener(reason);
      }
    },
  };
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

function strokeIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function pencilIcon(): SVGSVGElement {
  return strokeIcon(["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"]);
}

function plusIcon(): SVGSVGElement {
  return strokeIcon(["M12 5v14", "M5 12h14"]);
}

function trashIcon(): SVGSVGElement {
  return strokeIcon(["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"]);
}

export function mountJournal(): { load: () => Promise<void> } {
  const form = required(document.querySelector<HTMLFormElement>("#journal-form"), "journal-form");
  const input = required(document.querySelector<HTMLInputElement>("#kind"), "kind");
  const list = required(document.querySelector<HTMLUListElement>("#kind-list"), "kind-list");
  const errorEl = required(document.querySelector<HTMLParagraphElement>("#journal-error"), "journal-error");
  const setup = required(document.querySelector<HTMLDivElement>("#kind-setup"), "kind-setup");
  const fieldsHost = required(document.querySelector<HTMLDivElement>("#entry-fields"), "entry-fields");
  const addFieldButton = required(document.querySelector<HTMLButtonElement>("#add-field"), "add-field");
  const editButton = required(document.querySelector<HTMLButtonElement>("#edit-kind"), "edit-kind");
  editButton.append(pencilIcon());
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
  let editing = false;
  let createLabel = "";
  let editors: Editor[] = [];
  let options: { label: string; kind: JournalKind | null }[] = [];
  let activeIndex = -1;
  let appliedKey: string | null = null;
  let autofilled = new Set<string>();
  let edited = new Set<string>();

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
    editButton.disabled = busy;
    for (const button of fieldsHost.querySelectorAll<HTMLButtonElement>(".add-option-toggle, .inline-add button")) {
      button.disabled = busy;
    }
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
    const labels = pickSuggestions(
      kinds.map((kind) => kind.label),
      query,
      8,
    );
    const items: { label: string; kind: JournalKind | null }[] = [];
    for (const label of labels) {
      const kind = kinds.find((item) => item.label === label);
      if (kind) {
        items.push({ label: kind.label, kind });
      }
    }
    const exact = needle.length > 0 && kinds.some((kind) => sameName(kind.label, query));
    if (needle && !exact) {
      items.push({ label: `Add “${normalize(query)}”`, kind: null });
    }
    return items;
  }

  function renderOptions(): void {
    if (input.value.trim() === "") {
      closeList();
      return;
    }
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

  function updateChrome(): void {
    const showEdits = mode === "existing" && editing;
    editButton.hidden = mode !== "existing";
    editButton.setAttribute("aria-expanded", showEdits ? "true" : "false");
    addFieldButton.hidden = mode !== "create" && !(showEdits && !appending);
  }

  function selectExisting(kind: JournalKind): void {
    mode = "existing";
    selected = kind;
    appending = false;
    editing = false;
    drafts = [];
    createLabel = "";
    input.value = kind.label;
    closeList();
    renderSetup();
    renderEntryFields();
    updateChrome();
    focusFirst();
  }

  function beginCreate(label: string): void {
    mode = "create";
    selected = null;
    appending = false;
    editing = false;
    createLabel = label;
    drafts = [{ label, type: "", unit: "", options: "" }];
    input.value = label;
    closeList();
    renderSetup();
    renderEntryFields();
    updateChrome();
    setup.querySelector("select")?.focus();
  }

  function resetComposer(): void {
    clearComposer();
    input.value = "";
    closeList();
    input.focus();
  }

  function clearComposer(): void {
    mode = "idle";
    selected = null;
    appending = false;
    editing = false;
    drafts = [];
    createLabel = "";
    renderSetup();
    renderEntryFields();
    updateChrome();
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
        updateChrome();
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

  function editorValue(editor: Editor): JournalValue["value"] | undefined {
    const result = editor.read();
    if (!result || "error" in result) {
      return undefined;
    }
    return result.value;
  }

  function laterEditors(): Editor[] {
    if (!selected || selected.fields.length < 2) {
      return [];
    }
    const rest = new Set(selected.fields.slice(1).map((field) => field.id));
    return editors.filter((editor) => rest.has(editor.key));
  }

  function applyRecent(reason: "edit" | "blur"): void {
    if (!selected || selected.fields.length < 2) {
      return;
    }
    const first = selected.fields[0];
    if (!first) {
      return;
    }
    const lead = editors.find((editor) => editor.key === first.id);
    if (!lead) {
      return;
    }
    const value = editorValue(lead);
    const key = value === undefined ? undefined : recentValueKey(first.type, value);
    const preset = key ? selected.recentValues[key] : undefined;
    if (key && preset) {
      if (key === appliedKey) {
        return;
      }
      appliedKey = key;
      edited.clear();
      autofilled = new Set();
      const byId = new Map(preset.map((item) => [item.fieldId, item.value]));
      for (const editor of laterEditors()) {
        const next = byId.get(editor.key);
        if (next === undefined) {
          editor.clear();
          continue;
        }
        editor.restore(next);
        autofilled.add(editor.key);
      }
      return;
    }
    const discrete = first.type === "enum" || first.type === "boolean" || first.type === "event";
    const finished = value === undefined || reason === "blur" || discrete;
    if (finished && appliedKey) {
      for (const editor of laterEditors()) {
        if (autofilled.has(editor.key) && !edited.has(editor.key)) {
          editor.clear();
        }
      }
      autofilled.clear();
      appliedKey = null;
    }
  }

  function watchRecent(): void {
    const fields = selected?.fields ?? [];
    const first = fields[0];
    if (!first || fields.length < 2) {
      return;
    }
    editors.find((editor) => editor.key === first.id)?.subscribe((reason) => {
      applyRecent(reason);
    });
    const rest = new Set(fields.slice(1).map((field) => field.id));
    for (const editor of editors) {
      if (!rest.has(editor.key)) {
        continue;
      }
      editor.subscribe((reason) => {
        if (reason === "edit") {
          edited.add(editor.key);
        }
      });
    }
  }

  function renderEntryFields(): void {
    const saved = editors.map((editor) => ({ key: editor.key, value: editor.read() }));
    fieldsHost.replaceChildren();
    editors = [];
    appliedKey = null;
    autofilled = new Set();
    edited = new Set();
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
    watchRecent();
    updateChrome();
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
      const choices = choiceEditor(field.label, field.options, key);
      block.append(choices);
      if (selected && mode === "existing" && !key.startsWith("draft:")) {
        block.append(addOptionRow(field, choices));
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
    const signal = editSignal();
    box.addEventListener("input", () => {
      signal.emit("edit");
    });
    box.addEventListener("blur", () => {
      signal.emit("blur");
    });
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
      subscribe: signal.subscribe,
    };
    editors.push(editor);
    wrap.append(box, el("span", "unit-suffix", field.unit ?? ""));
    return wrap;
  }

  function choiceEditor(label: string, options: string[], key: string): HTMLDivElement {
    const row = el("div", "choice-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    const signal = editSignal();
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
        signal.emit("edit");
      });
      button.addEventListener("blur", () => {
        signal.emit("blur");
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
      subscribe: signal.subscribe,
    });
    return row;
  }

  function textEditor(field: JournalField, key: string): HTMLDivElement {
    const wrap = el("div", "combobox");
    const box = el("input", "text-input");
    box.autocomplete = "off";
    box.spellcheck = true;
    box.setAttribute("aria-label", field.label);
    const listId = `suggest-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
    const suggestions = selected?.suggestions[field.id] ?? [];
    const menu = el("ul", "suggest-list");
    menu.id = listId;
    menu.role = "listbox";
    menu.hidden = true;
    if (!key.startsWith("draft:")) {
      mountStringCombobox({
        input: box,
        list: menu,
        idPrefix: listId,
        getItems: () => pickSuggestions(suggestions, box.value, 8),
      });
    }
    const signal = editSignal();
    box.addEventListener("input", () => {
      signal.emit("edit");
    });
    box.addEventListener("blur", () => {
      signal.emit("blur");
    });
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
      subscribe: signal.subscribe,
    });
    wrap.append(box, menu);
    return wrap;
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
    const signal = editSignal();
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
        signal.emit("edit");
      });
      button.addEventListener("blur", () => {
        signal.emit("blur");
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
      subscribe: signal.subscribe,
    });
    return row;
  }

  function addOptionRow(field: JournalField, choices: HTMLElement): HTMLDivElement {
    const row = el("div", "inline-add");
    row.id = `add-option-${field.id}`;
    row.hidden = true;
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
    const toggle = el("button", "icon-button add-option-toggle");
    toggle.type = "button";
    toggle.append(plusIcon());
    toggle.setAttribute("aria-label", `Add a choice to ${field.label}`);
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", row.id);
    toggle.addEventListener("click", () => {
      const open = row.hidden;
      row.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        box.focus();
      } else {
        toggle.focus();
      }
    });
    choices.append(toggle);
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
    const when = formatTime(entry.at);
    const head = el("div", "log-head");
    const main = el("div", "log-open");
    main.append(el("span", "log-title", entry.kind.label), el("span", "log-value", figureFor(entry)));
    const del = el("button", "icon-button delete log-delete");
    del.type = "button";
    del.setAttribute("aria-label", `Delete ${when} ${entry.kind.label}`);
    del.append(trashIcon());
    del.addEventListener("click", () => {
      removeEntry(entry, row);
    });
    head.append(main, del);
    const meta = el("div", "log-meta");
    const time = el("time");
    time.dateTime = entry.at;
    time.textContent = when;
    meta.append(time);
    article.append(head, meta);
    row.append(article);
    return row;
  }

  let finishEntryDelete: (() => void) | undefined;

  function removeEntry(entry: JournalEntry, row: HTMLLIElement): void {
    finishEntryDelete?.();
    const snapshot = entries.slice();
    entries = entries.filter((item) => item.id !== entry.id);
    paintSummary();
    const restore = (): void => {
      entries = snapshot;
      paintEntries();
    };
    finishEntryDelete = confirmDelete(
      row,
      `Removed ${formatTime(entry.at)}.`,
      async () => {
        await deleteJournalEntry(entry.id);
        const empty = entries.length === 0;
        emptyEl.hidden = !empty;
        entriesEl.hidden = empty;
      },
      restore,
      (error) => {
        setError(error instanceof Error ? error.message : "Couldn't delete that entry.");
      },
    );
  }

  let refreshSerial = 0;

  async function refresh(): Promise<void> {
    const serial = ++refreshSerial;
    const { from, to } = localDayRange();
    const [nextKinds, nextEntries] = await Promise.all([fetchKinds(), fetchJournal(from, to)]);
    if (serial !== refreshSerial) {
      return;
    }
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
        await logJournal({ kind: { label: createLabel, fields: built }, values });
        await refresh();
        resetComposer();
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
        updateChrome();
        restoreValues(values.map((value) => ({ key: value.fieldId, value: value.value })));
      }
      if (values.length === 0) {
        setError("Enter at least one thing.");
        return;
      }
      await logJournal({ kindId: kind.id, values });
      await refresh();
      resetComposer();
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
      updateChrome();
      setup.querySelector("input")?.focus();
    }
  });

  editButton.addEventListener("click", () => {
    if (mode !== "existing" || !selected) {
      return;
    }
    editing = !editing;
    if (!editing && appending) {
      appending = false;
      drafts = [];
      renderSetup();
      renderEntryFields();
    }
    updateChrome();
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
      if (input.value.trim() === "") {
        closeList();
        return;
      }
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
