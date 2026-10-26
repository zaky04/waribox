// Sur un appareil relié, le hash du PIN d'un responsable n'existe pas (voir
// pin.ts, REMOTE_PIN_HASH) : la couche réseau de l'application enregistre ici
// la fonction qui demande au Maître de vérifier le PIN (défi/réponse, le PIN ne
// circule jamais en clair — voir pinProof.ts). Hors connexion, aucune fonction
// n'est enregistrée et la vérification échoue avec un message explicite.
export type RemotePinVerifier = (approverId: number, pin: string) => Promise<boolean>;

let verifier: RemotePinVerifier | null = null;

export function setRemotePinVerifier(fn: RemotePinVerifier | null): void {
  verifier = fn;
}

export function getRemotePinVerifier(): RemotePinVerifier | null {
  return verifier;
}
