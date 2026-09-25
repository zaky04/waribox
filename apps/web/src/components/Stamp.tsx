import { useId } from "react";

interface StampProps {
  text: string;
  subText?: string;
  // Couleur du trait/texte (variable CSS ou valeur) — accent par défaut.
  color?: string;
  width?: number;
  rotate?: number;
  // Rejoue l'animation "tampon qui tombe" au montage (voir index.css, stampIn).
  animate?: boolean;
}

// Tampon d'encre (PAYÉ, CAISSE JUSTE...) : double cadre, texte à chasse fixe,
// contour légèrement rongé par un filtre de bruit — signature visuelle de la
// direction "ticket de caisse". Purement décoratif : `text` est aussi exposé
// via aria-label pour les lecteurs d'écran.
export function Stamp({ text, subText, color = "var(--color-accent)", width = 210, rotate = -9, animate = true }: StampProps) {
  const filterId = useId().replace(/:/g, "");
  const height = Math.round(width * (subText ? 0.43 : 0.34));
  const fontSize = Math.min(width * 0.18, (width * 0.86) / (text.length * 0.66));
  const textY = subText ? height * 0.55 : height * 0.62;
  return (
    <div
      style={{
        display: "inline-block",
        transform: `rotate(${rotate}deg)`,
        animation: animate ? "stampIn 0.4s cubic-bezier(0.2, 0.9, 0.3, 1) both" : undefined,
        ["--stamp-rotate" as string]: `${rotate}deg`,
        pointerEvents: "none",
      }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text}>
        <defs>
          <filter id={filterId} x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.05 0.8" numOctaves="2" seed="4" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" />
          </filter>
        </defs>
        <g filter={`url(#${filterId})`} style={{ opacity: 0.92 }}>
          <rect x="3" y="3" width={width - 6} height={height - 6} rx="6" fill="none" stroke={color} strokeWidth="3.2" />
          <rect x="10" y="10" width={width - 20} height={height - 20} rx="3" fill="none" stroke={color} strokeWidth="1.2" />
          <text
            x={width / 2}
            y={textY}
            textAnchor="middle"
            fontFamily="var(--font-mono)"
            fontWeight={600}
            fontSize={fontSize}
            letterSpacing={Math.max(1, fontSize * 0.12)}
            fill={color}
          >
            {text}
          </text>
          {subText && (
            <text
              x={width / 2}
              y={height * 0.78}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={Math.max(8, width * 0.05)}
              letterSpacing="1.2"
              fill={color}
            >
              {subText}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}
