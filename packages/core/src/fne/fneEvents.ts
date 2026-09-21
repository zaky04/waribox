// Pub/sub minimal — signale qu'une vente vient d'être mise en file d'attente
// de certification FNE (voir fneQueue.ts), pour que apps/web puisse tenter
// une certification immédiate sans attendre le prochain passage périodique
// de useFneQueue.ts. Émis seulement APRÈS écriture confirmée en base (voir
// SalesService.createSale) — jamais avant, pour ne jamais risquer qu'un
// abonné relise la file avant que la ligne n'y existe réellement.

const listeners = new Set<() => void>();

export function emitFneQueued(): void {
  for (const listener of listeners) listener();
}

export function onFneQueued(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
