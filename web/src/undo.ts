const UNDO_MS = 5000;

export function confirmDelete(
  row: HTMLElement,
  message: string,
  commit: () => Promise<void>,
  onUndo: () => void,
  onError: (error: unknown) => void,
): () => void {
  const article = row.querySelector("article");
  if (article === null) {
    return () => undefined;
  }
  article.hidden = true;
  const bar = document.createElement("div");
  bar.className = "undo-bar";
  bar.setAttribute("role", "status");
  const text = document.createElement("p");
  text.textContent = message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Undo";
  bar.append(text, button);
  row.append(bar);
  button.focus();

  let settled = false;
  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    window.clearTimeout(timer);
    void commit()
      .then(() => {
        row.remove();
      })
      .catch((error: unknown) => {
        bar.remove();
        article.hidden = false;
        onUndo();
        onError(error);
      });
  };
  const timer = window.setTimeout(finish, UNDO_MS);
  button.addEventListener("click", () => {
    if (settled) {
      return;
    }
    settled = true;
    window.clearTimeout(timer);
    bar.remove();
    article.hidden = false;
    onUndo();
  });
  return finish;
}
