import { Monitor, Moon, Sun } from 'lucide-react';
import { useSettings } from '@/providers/SettingsProvider';
import { Tooltip } from '@/components/ui/Tooltip';

const LABEL = {
  light: 'Light theme',
  dark: 'Dark theme',
  system: 'Match system theme',
} as const;

/** Single-button light → dark → system cycle. */
export function ThemeToggle() {
  const { theme, cycleTheme } = useSettings();
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <Tooltip content={LABEL[theme]}>
      <button
        type="button"
        onClick={cycleTheme}
        aria-label={`${LABEL[theme]} — click to change`}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
      >
        <Icon className="h-4 w-4" />
      </button>
    </Tooltip>
  );
}
