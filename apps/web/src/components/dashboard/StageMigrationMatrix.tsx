import type { AnalyticsMigration } from '@eclens/shared';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSettings } from '@/providers/SettingsProvider';

export interface StageMigrationMatrixProps {
  migration: AnalyticsMigration | undefined;
  loading?: boolean;
}

const STAGES = [1, 2, 3] as const;

/**
 * Stage migration matrix between two reporting periods.
 *
 * Answers: "of the loans present in both periods, how many changed stage and
 * in which direction." Rows are the earlier period's stage, columns the
 * later one's — the diagonal is "stayed put," everything else is a
 * transition. Direction is shown with an arrow icon and a label, never by
 * color alone, since an upgrade (worse stage) and a downgrade (fewer
 * exposures) are both meaningful and must stay legible without color
 * vision.
 */
export function StageMigrationMatrix({ migration, loading }: StageMigrationMatrixProps) {
  const { moneyString } = useSettings();

  if (loading) {
    return <div className="h-56 animate-pulse rounded-lg bg-slate-100" />;
  }
  if (!migration || migration.cells.length === 0) {
    return (
      <EmptyState
        title="No migration to show"
        description="Needs two reporting periods with completed runs and at least one exposure common to both."
      />
    );
  }

  const cellByKey = new Map(migration.cells.map((cell) => [`${cell.fromStage}-${cell.toStage}`, cell]));
  const maxCount = Math.max(1, ...migration.cells.map((cell) => cell.count));

  return (
    <div>
      <p className="mb-3 text-xs text-slate-500">
        {migration.fromSnapshot.label} ({migration.fromSnapshot.asOfDate}) → {migration.toSnapshot.label} (
        {migration.toSnapshot.asOfDate}), {migration.matchedExposures} exposures matched.
      </p>
      <p className="sr-only">
        Stage migration matrix. {migration.cells
          .map((cell) => `${cell.count} exposure(s) moved from stage ${cell.fromStage} to stage ${cell.toStage}`)
          .join('; ')}
        . {migration.onlyInFromSnapshot} exposures exited the book, {migration.onlyInToSnapshot} were newly
        originated. Net Stage 3 change: {migration.netStage3Change >= 0 ? '+' : ''}
        {migration.netStage3Change}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="p-2 text-left font-medium text-slate-400" scope="col">
                From \ To
              </th>
              {STAGES.map((stage) => (
                <th key={stage} className="p-2 text-center font-medium text-slate-500" scope="col">
                  Stage {stage}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAGES.map((fromStage) => (
              <tr key={fromStage}>
                <th className="p-2 text-left font-medium text-slate-500" scope="row">
                  Stage {fromStage}
                </th>
                {STAGES.map((toStage) => {
                  const cell = cellByKey.get(`${fromStage}-${toStage}`);
                  const count = cell?.count ?? 0;
                  const isDiagonal = fromStage === toStage;
                  const isDowngrade = toStage > fromStage;
                  const isUpgrade = toStage < fromStage;
                  const intensity = count === 0 ? 0 : Math.max(0.15, count / maxCount);
                  return (
                    <td key={toStage} className="p-1.5 text-center align-middle">
                      <div
                        className="mx-auto flex min-h-[3.25rem] w-full flex-col items-center justify-center gap-0.5 rounded-md border border-slate-200 px-1 py-1.5"
                        style={{
                          backgroundColor: isDiagonal
                            ? `rgba(44, 74, 111, ${intensity * 0.35})`
                            : isDowngrade
                              ? `rgba(220, 38, 38, ${intensity * 0.3})`
                              : count > 0
                                ? `rgba(16, 185, 129, ${intensity * 0.3})`
                                : undefined,
                        }}
                      >
                        <span className="flex items-center gap-1 font-semibold tabular-nums text-navy-900">
                          {!isDiagonal && count > 0 ? (
                            isDowngrade ? (
                              <ArrowDown className="h-3 w-3 text-red-600" aria-label="Downgrade" />
                            ) : isUpgrade ? (
                              <ArrowUp className="h-3 w-3 text-emerald-600" aria-label="Upgrade" />
                            ) : null
                          ) : null}
                          {count}
                        </span>
                        {count > 0 ? (
                          <span className="text-[10px] text-slate-500">{moneyString(cell?.grossCarryingAmount, { compact: true })}</span>
                        ) : (
                          <span className="text-[10px] text-slate-300">—</span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-md border border-slate-200 px-2 py-1.5 text-center">
          <p className="font-semibold text-navy-900">{migration.onlyInFromSnapshot}</p>
          <p className="text-slate-500">Exited the book</p>
        </div>
        <div className="rounded-md border border-slate-200 px-2 py-1.5 text-center">
          <p className="font-semibold text-navy-900">{migration.onlyInToSnapshot}</p>
          <p className="text-slate-500">Newly originated</p>
        </div>
        <div className="rounded-md border border-slate-200 px-2 py-1.5 text-center">
          <p className="flex items-center justify-center gap-1 font-semibold text-navy-900">
            {migration.netStage3Change > 0 ? (
              <ArrowUp className="h-3 w-3 text-red-600" />
            ) : migration.netStage3Change < 0 ? (
              <ArrowDown className="h-3 w-3 text-emerald-600" />
            ) : (
              <ArrowRight className="h-3 w-3 text-slate-400" />
            )}
            {migration.netStage3Change >= 0 ? '+' : ''}
            {migration.netStage3Change}
          </p>
          <p className="text-slate-500">Net Stage 3 change</p>
        </div>
      </div>
      {migration.limitations.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
          {migration.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
