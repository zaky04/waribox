export interface AppearancePreset {
  key: string;
  labelKey: string;
  color: string;
}

// Palette curatée — les 4 premières reprennent les teintes choisies lors du
// tout premier jet de ce chantier (secteur d'activité → couleur, voir
// CLAUDE.md journal du 2026-09-20), désormais détachées du secteur :
// n'importe quel commerce peut choisir n'importe laquelle. "Personnalisé"
// (voir SettingsPage.tsx, sélecteur de couleur libre) permet d'aller
// au-delà de cette liste.
export const APPEARANCE_PRESETS: AppearancePreset[] = [
  { key: "amber", labelKey: "settings.appearance.presets.amber", color: "#e2793d" },
  { key: "teal", labelKey: "settings.appearance.presets.teal", color: "#16a394" },
  { key: "tomato", labelKey: "settings.appearance.presets.tomato", color: "#d6494a" },
  { key: "plum", labelKey: "settings.appearance.presets.plum", color: "#8b5fbf" },
  { key: "emerald", labelKey: "settings.appearance.presets.emerald", color: "#10b981" },
  { key: "rose", labelKey: "settings.appearance.presets.rose", color: "#ec4899" },
  { key: "slate", labelKey: "settings.appearance.presets.slate", color: "#64748b" },
];

// Valeur affichée dans le sélecteur de couleur libre quand aucun accent
// personnalisé n'est encore choisi (le vrai défaut de l'app, voir index.css
// `:root { --color-accent: #38bdf8; }`) — un `<input type="color">` ne peut
// pas rester "vide", il lui faut une valeur de départ.
export const DEFAULT_ACCENT_COLOR = "#38bdf8";
