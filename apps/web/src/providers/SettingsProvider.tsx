import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  formatCurrency,
  formatDecimalMoney,
  formatDecimalPercent,
  formatPercent,
  type CurrencyFormatOptions,
} from '@eclens/shared';
import { loadSettings, persistSettings, type AppSettings } from '@/lib/settings';
import {
  applyTheme,
  resolveTheme,
  watchSystemTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

interface SettingsContextValue extends AppSettings {
  setCurrency: (currency: string) => void;
  toggleSidebar: () => void;
  setTheme: (theme: ThemePreference) => void;
  /** Cycles light → dark → system, for the single-button topbar control. */
  cycleTheme: () => void;
  /** What is actually painted right now, with `system` already resolved. */
  resolvedTheme: ResolvedTheme;
  /** Binary-float formatters, for chart axes and layout maths only. */
  money: (value: number, options?: CurrencyFormatOptions) => string;
  percent: (value: number, digits?: number) => string;
  /**
   * Decimal-string formatters. Every figure the API returns is an exact decimal
   * string, so these are what screens use — the value never becomes a float.
   */
  moneyString: (value: string | null | undefined, options?: CurrencyFormatOptions) => string;
  percentString: (value: string | null | undefined, digits?: number) => string;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

const THEME_CYCLE: ThemePreference[] = ['light', 'dark', 'system'];

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(loadSettings().theme),
  );

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      persistSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    setResolvedTheme(applyTheme(settings.theme));
  }, [settings.theme]);

  useEffect(() => {
    if (settings.theme !== 'system') return undefined;
    return watchSystemTheme(() => setResolvedTheme(applyTheme('system')));
  }, [settings.theme]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      resolvedTheme,
      setCurrency: (currency) => update({ currency }),
      toggleSidebar: () => update({ sidebarCollapsed: !settings.sidebarCollapsed }),
      setTheme: (theme) => update({ theme }),
      cycleTheme: () =>
        update({
          theme: THEME_CYCLE[(THEME_CYCLE.indexOf(settings.theme) + 1) % THEME_CYCLE.length],
        }),
      money: (amount, options) => formatCurrency(amount, settings.currency, options),
      percent: (value, digits = 2) => formatPercent(value, digits),
      moneyString: (amount, options) => formatDecimalMoney(amount, settings.currency, options),
      percentString: (value, digits = 2) => formatDecimalPercent(value, digits),
    }),
    [settings, resolvedTheme, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within SettingsProvider');
  return context;
}
