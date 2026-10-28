import { useId } from 'react';
import { Table } from './Table';

/** One bar. */
export interface BarDatum {
  /** Category or day label, shown under the bar and in the data table. */
  label: string;
  value: number;
}

/** Props for {@link BarChart}. */
export interface BarChartProps {
  title: string;
  data: readonly BarDatum[];
  /** Name of the measured quantity for the table header, e.g. "Alerts". */
  valueName: string;
}

const WIDTH = 600;
const HEIGHT = 220;
const PAD = { top: 24, right: 8, bottom: 36, left: 8 };

/**
 * A single-series bar chart as inline SVG (no chart library, ADR-0073).
 *
 * Accessibility: the SVG is one `role="img"` whose name is the title and whose description
 * summarises the data in words; each bar has a `<title>` (native hover tooltip); and the
 * exact numbers are always available in a real data table below (WCAG 1.1.1).
 * One series means one colour, so colour carries no meaning; the axis labels do.
 */
export function BarChart({ title, data, valueName }: BarChartProps) {
  const id = useId();
  const max = Math.max(1, ...data.map((d) => d.value));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const band = data.length > 0 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.max(2, Math.min(48, band * 0.62));
  // Thin out x labels so they never collide (at most ~10 visible).
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  const showAllValues = data.length <= 12;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const peak = data.reduce<BarDatum | null>(
    (best, d) => (best && best.value >= d.value ? best : d),
    null,
  );
  const summary =
    data.length === 0
      ? 'No data.'
      : `${data.length} bars, total ${total}. Highest: ${peak?.label ?? ''} with ${peak?.value ?? 0}.`;

  return (
    <figure className="sp-chart">
      <figcaption className="sp-chart__title">{title}</figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="sp-chart__svg"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotHeight}
          y2={PAD.top + plotHeight}
          className="sp-chart__axis"
        />
        {data.map((d, i) => {
          const h = (d.value / max) * plotHeight;
          const x = PAD.left + band * i + (band - barWidth) / 2;
          const y = PAD.top + plotHeight - h;
          const r = Math.min(4, barWidth / 2, h);
          const isPeak = d === peak;
          return (
            <g key={`${d.label}-${String(i)}`}>
              <title>{`${d.label}: ${String(d.value)}`}</title>
              {/* Hit target taller than the bar so small values are still hoverable. */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotHeight}
                fill="transparent"
              />
              {h > 0 ? (
                <path d={roundedTopBar(x, y, barWidth, h, r)} className="sp-chart__bar" />
              ) : null}
              {(showAllValues || isPeak) && d.value > 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="sp-chart__value"
                >
                  {d.value}
                </text>
              ) : null}
              {i % labelEvery === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - PAD.bottom + 18}
                  textAnchor="middle"
                  className="sp-chart__label"
                >
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details className="sp-chart__table">
        <summary>Show data table</summary>
        <Table caption={title} captionHidden>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col" className="sp-num">
                {valueName}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((d, i) => (
              <tr key={`${d.label}-${String(i)}`}>
                <th scope="row">{d.label}</th>
                <td className="sp-num">{d.value}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </figure>
  );
}

/** SVG path for a bar anchored to the baseline with rounded top corners of radius `r`. */
export function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  const bottom = y + h;
  return [
    `M${x},${bottom}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${bottom}`,
    'Z',
  ].join(' ');
}
