export interface ChartPoint {
  label: string;
  value: number;
}

interface ChartProps {
  data: ChartPoint[];
  height?: number;
  positiveColor?: string;
  negativeColor?: string;
}

const AXIS_COLOR = "var(--color-border)";
const TEXT_COLOR = "var(--color-text-muted)";

// Affiche au plus ~12 étiquettes pour éviter le chevauchement quand la série
// est longue (ex: 30 jours) — un point sur N plutôt que toutes.
function labelStep(count: number): number {
  return Math.max(1, Math.ceil(count / 12));
}

export function BarChart({ data, height = 220, positiveColor = "#38bdf8", negativeColor = "#f87171" }: ChartProps) {
  const width = 720;
  const paddingLeft = 48;
  const paddingBottom = 28;
  const paddingTop = 12;
  const plotWidth = width - paddingLeft - 12;
  const plotHeight = height - paddingTop - paddingBottom;

  if (data.length === 0) {
    return <p style={{ color: TEXT_COLOR }}>Aucune donnée pour cette période.</p>;
  }

  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const minValue = Math.min(0, ...data.map((d) => d.value));
  const range = maxValue - minValue || 1;
  const zeroY = paddingTop + (maxValue / range) * plotHeight;

  const barWidth = plotWidth / data.length;
  const step = labelStep(data.length);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
      <line x1={paddingLeft} y1={zeroY} x2={width - 12} y2={zeroY} stroke={AXIS_COLOR} strokeWidth={1} />
      <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={height - paddingBottom} stroke={AXIS_COLOR} strokeWidth={1} />
      <text x={4} y={paddingTop + 4} fill={TEXT_COLOR} fontSize={10}>
        {maxValue.toFixed(0)}
      </text>
      <text x={4} y={height - paddingBottom} fill={TEXT_COLOR} fontSize={10}>
        {minValue.toFixed(0)}
      </text>
      {data.map((point, i) => {
        const barHeight = (Math.abs(point.value) / range) * plotHeight;
        const x = paddingLeft + i * barWidth + barWidth * 0.15;
        const y = point.value >= 0 ? zeroY - barHeight : zeroY;
        return (
          <g key={point.label}>
            <rect
              x={x}
              y={y}
              width={barWidth * 0.7}
              height={Math.max(barHeight, 0.5)}
              fill={point.value >= 0 ? positiveColor : negativeColor}
              rx={2}
            />
            {i % step === 0 && (
              <text
                x={paddingLeft + i * barWidth + barWidth / 2}
                y={height - paddingBottom + 14}
                fill={TEXT_COLOR}
                fontSize={9}
                textAnchor="middle"
              >
                {point.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ data, height = 220, positiveColor = "#38bdf8", negativeColor = "#f87171" }: ChartProps) {
  const width = 720;
  const paddingLeft = 48;
  const paddingBottom = 28;
  const paddingTop = 12;
  const plotWidth = width - paddingLeft - 12;
  const plotHeight = height - paddingTop - paddingBottom;

  if (data.length === 0) {
    return <p style={{ color: TEXT_COLOR }}>Aucune donnée pour cette période.</p>;
  }

  const maxValue = Math.max(0, ...data.map((d) => d.value));
  const minValue = Math.min(0, ...data.map((d) => d.value));
  const range = maxValue - minValue || 1;
  const zeroY = paddingTop + (maxValue / range) * plotHeight;
  const step = labelStep(data.length);

  const stepX = data.length > 1 ? plotWidth / (data.length - 1) : 0;
  const points = data.map((point, i) => {
    const x = paddingLeft + i * stepX;
    const y = paddingTop + ((maxValue - point.value) / range) * plotHeight;
    return { x, y, point };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const overallTrend = (data[data.length - 1]?.value ?? 0) >= (data[0]?.value ?? 0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
      <line x1={paddingLeft} y1={zeroY} x2={width - 12} y2={zeroY} stroke={AXIS_COLOR} strokeWidth={1} />
      <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={height - paddingBottom} stroke={AXIS_COLOR} strokeWidth={1} />
      <text x={4} y={paddingTop + 4} fill={TEXT_COLOR} fontSize={10}>
        {maxValue.toFixed(0)}
      </text>
      <text x={4} y={height - paddingBottom} fill={TEXT_COLOR} fontSize={10}>
        {minValue.toFixed(0)}
      </text>
      <path d={linePath} fill="none" stroke={overallTrend ? positiveColor : negativeColor} strokeWidth={2} />
      {points.map(({ x, y, point }, i) => (
        <g key={point.label}>
          <circle cx={x} cy={y} r={3} fill={overallTrend ? positiveColor : negativeColor} />
          {i % step === 0 && (
            <text x={x} y={height - paddingBottom + 14} fill={TEXT_COLOR} fontSize={9} textAnchor="middle">
              {point.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
