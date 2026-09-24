export type SyncTopic = "food" | "journal";

export interface SyncHub {
  publish(topic: SyncTopic): void;
  subscribe(listener: (topic: SyncTopic) => void): () => void;
}

export function createSyncHub(): SyncHub {
  const listeners = new Set<(topic: SyncTopic) => void>();
  return {
    publish(topic) {
      for (const listener of [...listeners]) {
        listener(topic);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
