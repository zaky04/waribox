// Voix du mode caisse simplifié : la synthèse vocale du système (navigateur / WebView), hors ligne, gratuite.
// Sert aux employés qui lisent peu : le total et la monnaie à rendre sont aussi dits à voix haute.
// Elle ne parle qu'en français ou en anglais (les langues locales ne sont pas couvertes par les voix du système).

const STORAGE_KEY = "waribox-voice";

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

// Préférence de l'appareil (comme la langue ou le thème) : désactivée tant que personne ne l'a activée.
export function loadVoiceEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveVoiceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // stockage indisponible : la préférence ne survit simplement pas au rechargement
  }
}

export function speak(text: string, lang: string): void {
  if (!isSpeechSupported()) return;
  try {
    // Une nouvelle phrase remplace celle en cours : jamais de file qui continue de parler après le client.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang.startsWith("en") ? "en-US" : "fr-FR";
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  } catch {
    // une synthèse vocale en panne ne doit jamais gêner une vente
  }
}

export function stopSpeaking(): void {
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // idem
  }
}
