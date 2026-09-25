import { relativeLuminance, toRgba } from "./color";

export interface AppearanceOptions {
  accent: string | null;
  shape: string | null;
  // null = papier chaud (défaut) ; "white" | "grey" — thème clair uniquement.
  background: string | null;
  // null = Familjen Grotesk (embarquée) ; "system" | "serif" — polices déjà
  // présentes sur l'appareil, rien à embarquer (l'app reste 100 % hors ligne).
  font: string | null;
}

// Fonds alternatifs du thème clair : mêmes variables que :root (index.css).
const BACKGROUNDS: Record<string, Record<string, string>> = {
  white: {
    "--color-bg": "#f7f7f5",
    "--color-bg-elevated": "#ffffff",
    "--color-bg-side": "#eeeeec",
    "--color-ticket": "#ffffff",
    "--color-border": "#dcdcd8",
    "--color-rule-strong": "#c4c4bf",
    "--color-dot": "#d0d0cc",
  },
  grey: {
    "--color-bg": "#eceef0",
    "--color-bg-elevated": "#f6f7f8",
    "--color-bg-side": "#e0e3e6",
    "--color-ticket": "#fbfbfc",
    "--color-border": "#cfd3d8",
    "--color-rule-strong": "#b6bbc2",
    "--color-dot": "#c4c8ce",
  },
};
const BACKGROUND_KEYS = ["--color-bg", "--color-bg-elevated", "--color-bg-side", "--color-ticket", "--color-border", "--color-rule-strong", "--color-dot", "--bg-grain"];

const FONTS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
};

// Applique (ou retire) la personnalisation d'apparence — couleur d'accent,
// forme des coins, fond et police — en style inline sur <html>, qui l'emporte
// sur les valeurs par défaut de :root/:root[data-theme="dark"] (index.css).
// Direction "ticket de caisse" : l'accent est une couleur UNIE (aucun dégradé).
// Le texte posé sur l'accent (--color-on-accent) est blanc, ou encre si la
// couleur choisie est claire. `theme` doit être repassé à chaque appel :
// l'opacité de --color-accent-soft diffère en clair/sombre, et le fond
// personnalisé n'a de sens qu'en clair.
export function applyAppearance(o: AppearanceOptions, theme: "dark" | "light") {
  const root = document.documentElement.style;

  if (o.accent) {
    root.setProperty("--color-accent", o.accent);
    root.setProperty("--color-accent-2", o.accent);
    root.setProperty("--gradient-accent", o.accent);
    root.setProperty("--color-accent-soft", toRgba(o.accent, theme === "light" ? 0.12 : 0.22));
    root.setProperty("--color-on-accent", relativeLuminance(o.accent) > 0.42 ? "#1d1b16" : "#ffffff");
  } else {
    root.removeProperty("--color-accent");
    root.removeProperty("--color-accent-2");
    root.removeProperty("--gradient-accent");
    root.removeProperty("--color-accent-soft");
    root.removeProperty("--color-on-accent");
  }

  if (o.shape === "round") {
    root.setProperty("--radius-md", "14px");
    root.setProperty("--radius-lg", "20px");
  } else if (o.shape === "square") {
    root.setProperty("--radius-md", "2px");
    root.setProperty("--radius-lg", "3px");
  } else {
    root.removeProperty("--radius-md");
    root.removeProperty("--radius-lg");
  }

  for (const key of BACKGROUND_KEYS) root.removeProperty(key);
  const bg = theme === "light" && o.background ? BACKGROUNDS[o.background] : undefined;
  if (bg) {
    for (const [k, v] of Object.entries(bg)) root.setProperty(k, v);
    root.setProperty("--bg-grain", "none");
  }

  const fontStack = o.font ? FONTS[o.font] : undefined;
  if (fontStack) root.setProperty("--font-sans", fontStack);
  else root.removeProperty("--font-sans");
}
