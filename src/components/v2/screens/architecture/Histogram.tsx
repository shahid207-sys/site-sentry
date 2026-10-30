"use client";
// A stacked bar histogram in plain SVG (docs/PHASE4.md conflict #3: no chart library). The SVG is an image with a
// summary label; the same numbers are in a visually hidden table for screen readers, and every bar carries its total
// as text, so nothing is conveyed by colour alone. Bars never animate.

export interface HistogramSeries {
  id: string;
  name: string;
  /** A CSS colour (a design token, e.g. var(--info)), defined for light and dark themes. */
  color: string;
}

export interface HistogramBar {
  key: string;
  /** Axis label (short). */
  label: string;
  /** Row label in the data table; defaults to `label`. */
  longLabel?: string;
  values: Record<string, number>;
}

const PAD_TOP = 20;
const AXIS_H = 26;
const BAR_W = 28;

export function Histogram({ title, xLabel, series, bars, height = 200, unit }: { title: string; xLabel: string; series: HistogramSeries[]; bars: HistogramBar[]; height?: number; unit: string }) {
  const total = (b: HistogramBar) => series.reduce((n, s) => n + (b.values[s.id] ?? 0), 0);
  const max = Math.max(1, ...bars.map(total));
  const longest = Math.max(...bars.map((b) => b.label.length), 1);
  const slot = Math.max(44, Math.ceil(longest * 6.6) + 12);
  const width = Math.max(slot * bars.length, 1);
  const plotH = height - PAD_TOP - AXIS_H;
  // Long series are summarised; the hidden table below always has every value.
  const summary =
    bars.length <= 15
      ? `${title}. ${bars.map((b) => `${b.longLabel ?? b.label}: ${total(b).toLocaleString("en-GB")} ${unit}`).join("; ")}.`
      : `${title}. ${bars.length} bars; the table that follows lists every value.`;

  return (
    <figure>
      <div className="overflow-x-auto">
        <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ minWidth: width }} preserveAspectRatio="xMinYMid meet">
          <line x1={0} x2={width} y1={PAD_TOP + plotH + 0.5} y2={PAD_TOP + plotH + 0.5} stroke="var(--line-strong)" />
          {bars.map((b, i) => {
            const x = i * slot + (slot - BAR_W) / 2;
            let y = PAD_TOP + plotH;
            const t = total(b);
            return (
              <g key={b.key}>
                {series.map((s) => {
                  const v = b.values[s.id] ?? 0;
                  if (!v) return null;
                  // At least 2px, so a small non-zero count is still visible next to a large one.
                  const h = Math.max(2, (v / max) * plotH);
                  y -= h;
                  return <rect key={s.id} x={x} y={y} width={BAR_W} height={Math.max(1, h - 1)} rx={2} fill={s.color} />;
                })}
                <text x={x + BAR_W / 2} y={y - 5} textAnchor="middle" fontSize={11} fill="var(--fg)" className="tabular">
                  {t.toLocaleString("en-GB")}
                </text>
                <text x={i * slot + slot / 2} y={PAD_TOP + plotH + 17} textAnchor="middle" fontSize={11} fill="var(--fg-2)">
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
        <span>{xLabel}</span>
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.name}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{xLabel}</th>
            {series.map((s) => (
              <th key={s.id} scope="col">
                {s.name}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row">{b.longLabel ?? b.label}</th>
              {series.map((s) => (
                <td key={s.id}>{(b.values[s.id] ?? 0).toLocaleString("en-GB")}</td>
              ))}
              <td>{total(b).toLocaleString("en-GB")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
