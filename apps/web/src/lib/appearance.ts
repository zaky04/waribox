import { lighten, toRgba } from "./color";

// Applique (ou retire) la personnalisation d'apparence — couleur d'accent et
// forme des coins — en style inline sur <html>, qui l'emporte sur les
// valeurs par défaut de :root/[data-theme="light"] (index.css) sans avoir
// besoin d'un bloc CSS par couleur possible (contrairement à l'ancien
// mécanisme par secteur, remplacé ici — voir CLAUDE.md journal du
// 2026-09-20 : `sectorType` ne pilote plus que l'icône/libellé de l'onglet
// "Produits", voir Nav.tsx). `accentColor: null` retire l'override et
// revient au thème par défaut ; `shape !== "square"` revient aux coins
// arrondis d'origine. `theme` doit être repassé à chaque appel (pas lu ici)
// car --color-accent-soft/--bg-glow ont une opacité différente en clair/
// sombre — appelant responsable de réappliquer au changement de thème.
export function applyAppearance(
  accentColor: string | null,
  shape: string | null,
  theme: "dark" | "light",
) {
  const root = document.documentElement.style;

  if (accentColor) {
    const accent2 = lighten(accentColor, 0.14);
    root.setProperty("--color-accent", accentColor);
    root.setProperty("--color-accent-2", accent2);
    root.setProperty("--gradient-accent", `linear-gradient(135deg, ${accentColor} 0%, ${accent2} 100%)`);
    root.setProperty("--color-accent-soft", toRgba(accentColor, theme === "light" ? 0.13 : 0.18));
    root.setProperty(
      "--bg-glow",
      `radial-gradient(circle at 12% -10%, ${toRgba(accentColor, 0.14)}, transparent 45%), ` +
        `radial-gradient(circle at 100% 0%, ${toRgba(accent2, 0.12)}, transparent 40%)`,
    );
  } else {
    root.removeProperty("--color-accent");
    root.removeProperty("--color-accent-2");
    root.removeProperty("--gradient-accent");
    root.removeProperty("--color-accent-soft");
    root.removeProperty("--bg-glow");
  }

  if (shape === "square") {
    root.setProperty("--radius-md", "6px");
    root.setProperty("--radius-lg", "8px");
  } else {
    root.removeProperty("--radius-md");
    root.removeProperty("--radius-lg");
  }
}
