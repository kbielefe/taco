const FALLBACK_MS = 60_000;

export function watchChanges(onTopic: (topic: "food" | "journal") => void, onVisible: () => void): void {
  let source: EventSource | undefined;
  let recover = false;
  let fallback: ReturnType<typeof setInterval> | undefined;

  function close(): void {
    const current = source;
    source = undefined;
    recover = false;
    current?.close();
  }

  function open(): void {
    if (document.hidden || source) {
      return;
    }
    const next = new EventSource("/api/events");
    source = next;
    next.onmessage = (event) => {
      if (source !== next) {
        return;
      }
      try {
        const body = JSON.parse(String(event.data)) as { topic?: unknown };
        if (body.topic === "food" || body.topic === "journal") {
          onTopic(body.topic);
        }
      } catch {
        return;
      }
    };
    next.onerror = () => {
      if (source === next) {
        recover = true;
      }
    };
    next.onopen = () => {
      if (source === next && recover) {
        recover = false;
        onVisible();
      }
    };
  }

  function startFallback(): void {
    if (fallback !== undefined || document.hidden) {
      return;
    }
    fallback = setInterval(() => {
      if (!document.hidden) {
        onVisible();
      }
    }, FALLBACK_MS);
  }

  function stopFallback(): void {
    if (fallback !== undefined) {
      clearInterval(fallback);
      fallback = undefined;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      close();
      stopFallback();
      return;
    }
    onVisible();
    open();
    startFallback();
  });
  open();
  startFallback();
}
