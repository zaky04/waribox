export interface AppearancePreset {
  key: string;
  labelKey: string;
  color: string;
}

// Palette curatée — toutes assez foncées pour porter du texte blanc (contraste
// >= 4.5:1, les boutons principaux utilisent --color-on-accent). Le défaut de
// l'app (terracotta "tampon", voir index.css) n'est pas dans la liste : c'est
// la pastille "Par défaut". "Personnalisé" (SettingsPage.tsx) permet le reste.
export const APPEARANCE_PRESETS: AppearancePreset[] = [
  { key: "ochre", labelKey: "settings.appearance.presets.ochre", color: "#8a5e0f" },
  { key: "teal", labelKey: "settings.appearance.presets.teal", color: "#0f766e" },
  { key: "ink", labelKey: "settings.appearance.presets.ink", color: "#26476b" },
  { key: "plum", labelKey: "settings.appearance.presets.plum", color: "#6f4a9b" },
  { key: "forest", labelKey: "settings.appearance.presets.forest", color: "#2f6b4f" },
  { key: "rose", labelKey: "settings.appearance.presets.rose", color: "#be185d" },
  { key: "slate", labelKey: "settings.appearance.presets.slate", color: "#475569" },
];

// Valeur affichée dans le sélecteur de couleur libre quand aucun accent
// personnalisé n'est encore choisi (le vrai défaut de l'app, voir index.css
// `:root { --color-accent: #b4432b; }`) — un `<input type="color">` ne peut
// pas rester "vide", il lui faut une valeur de départ.
export const DEFAULT_ACCENT_COLOR = "#b4432b";
