import { useId } from "react";

// Bord dentelé d'un ticket (haut ou bas) — motif SVG répété, remplit la
// largeur du parent. Voir la direction "ticket de caisse" (index.css).
export function TicketEdge({ position }: { position: "top" | "bottom" }) {
  const id = useId().replace(/:/g, "");
  const path = position === "top" ? "M0 10H14L7 0Z" : "M0 0H14L7 10Z";
  return (
    <svg width="100%" height="10" aria-hidden="true" style={{ display: "block" }}>
      <defs>
        <pattern id={id} width="14" height="10" patternUnits="userSpaceOnUse">
          <path d={path} style={{ fill: "var(--color-ticket)", stroke: "var(--color-border)" }} strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="10" fill={`url(#${id})`} />
    </svg>
  );
}
