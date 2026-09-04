import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import type { AnalyticsScenarios } from '@eclens/shared';
import { decimalStringToNumber } from '@eclens/shared';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSettings } from '@/providers/SettingsProvider';

export interface ScenarioComparisonChartProps {
  scenarios: AnalyticsScenarios | undefined;
  loading?: boolean;
}

const SCENARIO_COLOR: Record<string, string> = {
  BASE: '#2c4a6f',
  UPSIDE: '#0d9488',
  DOWNSIDE: '#dc2626',
};

/**
 * Base / upside / downside / weighted scenario contribution.
 *
 * Answers: "how sensitive is the allowance to the macro scenario, and how
 * much of the final number does each scenario actually contribute once its
 * weight is applied." Unweighted ECL shows severity; weighted ECL shows
 * contribution to the reported allowance — the two bars are deliberately
 * different colors per scenario but also carry a text legend and axis
 * labels, so the distinction survives without color.
 */
export function ScenarioComparisonChart({ scenarios, loading }: ScenarioComparisonChartProps) {
  const { moneyString, percentString } = useSettings();

  if (loading) {
    return <div className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  }
  if (!scenarios || scenarios.scenarios.length === 0) {
    return (
      <EmptyState title="No scenario split to show" description="Needs a completed run with scenario-level results." />
    );
  }

  const data = scenarios.scenarios.map((scenario) => ({
    name: scenario.scenarioName,
    code: scenario.scenarioCode,
    unweighted: decimalStringToNumber(scenario.unweightedEcl),
    weighted: decimalStringToNumber(scenario.weightedEcl),
    weight: scenario.weight,
    unweightedText: scenario.unweightedEcl,
    weightedText: scenario.weightedEcl,
    color: SCENARIO_COLOR[scenario.scenarioCode] ?? '#64748b',
  }));

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        Run {scenarios.runLabel}: total weighted allowance {moneyString(scenarios.totalWeightedEcl, { compact: true })}{' '}
        across {scenarios.scenarios.length} scenarios weighted {percentString(scenarios.weightSum, 0)} of 100%.
      </p>
      <p className="sr-only">
        {scenarios.scenarios
          .map(
            (scenario) =>
              `${scenario.scenarioName}, weight ${scenario.weight}, unweighted ECL ${scenario.unweightedEcl}, weighted contribution ${scenario.weightedEcl}`,
          )
          .join('. ')}
        .
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(value: number) => moneyString(String(value), { compact: true })}
            tick={{ fontSize: 11, fill: '#64748b' }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <ChartTooltip
            formatter={(_value: number, key: string, item: { payload?: (typeof data)[number] }) => [
              moneyString(key === 'unweighted' ? item.payload?.unweightedText : item.payload?.weightedText),
              key === 'unweighted' ? 'Unweighted ECL' : 'Weighted contribution',
            ]}
            contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e2e8f0' }}
          />
          <Legend
            formatter={(value: string) => (value === 'unweighted' ? 'Unweighted ECL' : 'Weighted contribution')}
            wrapperStyle={{ fontSize: 11 }}
          />
          <Bar dataKey="unweighted" name="unweighted" radius={[3, 3, 0, 0]}>
            {data.map((entry) => (
              <Cell key={entry.code} fill={entry.color} />
            ))}
          </Bar>
          <Bar dataKey="weighted" name="weighted" fill="#94a3b8" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
        {scenarios.scenarios.map((scenario) => (
          <span key={scenario.scenarioCode} className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: SCENARIO_COLOR[scenario.scenarioCode] ?? '#64748b' }}
            />
            {scenario.scenarioName} — weight {percentString(scenario.weight, 0)}, PD ×{scenario.pdMultiplier}, LGD ×
            {scenario.lgdMultiplier}
          </span>
        ))}
      </div>
    </div>
  );
}
