import type { MovementBridge, MovementComponent } from '@eclens/shared';
import { decimalStringToNumber } from '@eclens/shared';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tooltip } from '@/components/ui/Tooltip';
import { useSettings } from '@/providers/SettingsProvider';

export interface MovementBridgeChartProps {
  bridge: MovementBridge | undefined;
  loading?: boolean;
}

const SIGN_TONE: Record<'up' | 'down' | 'flat', string> = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  flat: 'bg-navy-400',
};

function signOf(component: MovementComponent, code: string): 'up' | 'down' | 'flat' {
  if (code === 'OPENING' || code === 'CLOSING') return 'flat';
  const amount = component.amount === null ? 0 : decimalStringToNumber(component.amount);
  if (amount > 0) return 'up';
  if (amount < 0) return 'down';
  return 'flat';
}

/**
 * Opening-to-closing allowance waterfall.
 *
 * Answers: "what moved the allowance between the last two reporting periods,
 * and by how much." A plain bar-per-component list, not a Recharts stacked
 * bar — the null components (parameter/scenario changes, write-offs, all
 * legitimately unmeasured in this book) need an honest "not measured" row
 * rather than a zero-height bar that reads as "no change."
 */
export function MovementBridgeChart({ bridge, loading }: MovementBridgeChartProps) {
  const { moneyString } = useSettings();

  if (loading) {
    return <div className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  }
  if (!bridge) {
    return (
      <EmptyState
        title="No movement to show"
        description="A movement bridge needs two reporting periods with completed runs."
      />
    );
  }

  const measured = bridge.components.filter((component) => component.amount !== null);
  const maxAbs = Math.max(
    1,
    ...measured.map((component) => Math.abs(decimalStringToNumber(component.amount))),
  );

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        Opening allowance {moneyString(bridge.from.lossAllowance, { compact: true })} on {bridge.from.reportingDate}{' '}
        moved to {moneyString(bridge.to.lossAllowance, { compact: true })} on {bridge.to.reportingDate}
        {bridge.changePercent ? ` (${Number(bridge.changePercent) >= 0 ? '+' : ''}${bridge.changePercent}%)` : ''}.
      </p>
      <p className="sr-only">
        Allowance movement from {moneyString(bridge.from.lossAllowance)} to {moneyString(bridge.to.lossAllowance)}, a
        change of {moneyString(bridge.change)}. Components: {bridge.components
          .map((component) => `${component.label} ${component.amount !== null ? moneyString(component.amount) : 'not measured'}`)
          .join('; ')}
        .
      </p>
      <ul className="space-y-2">
        {bridge.components.map((component) => {
          const tone = signOf(component, component.code);
          const amountNumber = component.amount === null ? 0 : decimalStringToNumber(component.amount);
          const width = component.amount === null ? 0 : Math.max((Math.abs(amountNumber) / maxAbs) * 100, amountNumber === 0 ? 0 : 3);
          const Icon = tone === 'up' ? TrendingUp : tone === 'down' ? TrendingDown : Minus;
          return (
            <li key={component.code} className="grid grid-cols-[9rem_1fr_9rem] items-center gap-3 text-xs">
              <span className="truncate font-medium text-slate-700" title={component.label}>
                {component.label}
              </span>
              <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                {component.amount !== null ? (
                  <span
                    className={`block h-full rounded-full ${SIGN_TONE[tone]}`}
                    style={{ width: `${width}%`, marginLeft: tone === 'down' ? undefined : undefined }}
                  />
                ) : (
                  <Tooltip content={component.note ?? 'Not measured for this book.'}>
                    <span className="block h-full w-full rounded-full bg-[repeating-linear-gradient(45deg,theme(colors.slate.200),theme(colors.slate.200)_4px,transparent_4px,transparent_8px)]" />
                  </Tooltip>
                )}
              </span>
              <span className="flex items-center justify-end gap-1 font-medium tabular-nums text-slate-700">
                {component.amount !== null ? (
                  <>
                    <Icon className={`h-3 w-3 ${tone === 'up' ? 'text-emerald-600' : tone === 'down' ? 'text-red-600' : 'text-navy-500'}`} />
                    {moneyString(component.amount, { compact: true })}
                  </>
                ) : (
                  <span className="text-[11px] font-normal italic text-slate-400">not measured</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-4 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> Increases allowance
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" /> Decreases allowance
        </span>
        <span className="ml-auto">
          {bridge.componentsSumToChange ? 'Components reconcile exactly to the change.' : 'Components do not sum to the change — see limitations.'}
        </span>
      </div>
      {bridge.limitations.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
          {bridge.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
