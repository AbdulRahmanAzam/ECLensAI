import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  formatCurrency,
  formatDecimalMoney,
  formatDecimalPercent,
  formatDecimalPercentPoints,
  formatPercent,
  type CurrencyFormatOptions,
} from '@eclens/shared';
import { loadSettings, persistSettings, type AppSettings } from '@/lib/settings';

interface SettingsContextValue extends AppSettings {
  setCurrency: (currency: string) => void;
  toggleSidebar: () => void;
  /** Binary-float formatters, for chart axes and layout maths only. */
  money: (value: number, options?: CurrencyFormatOptions) => string;
  percent: (value: number, digits?: number) => string;
  /**
   * Decimal-string formatters. Every figure the API returns is an exact decimal
   * string, so these are what screens use — the value never becomes a float.
   */
  moneyString: (value: string | null | undefined, options?: CurrencyFormatOptions) => string;
  percentString: (value: string | null | undefined, digits?: number) => string;
  /** For `*Percent` API fields, which arrive already in percentage points. */
  percentPointsString: (value: string | null | undefined, digits?: number) => string;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      persistSettings(next);
      return next;
    });
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      setCurrency: (currency) => update({ currency }),
      toggleSidebar: () => update({ sidebarCollapsed: !settings.sidebarCollapsed }),
      money: (amount, options) => formatCurrency(amount, settings.currency, options),
      percent: (value, digits = 2) => formatPercent(value, digits),
      moneyString: (amount, options) => formatDecimalMoney(amount, settings.currency, options),
      percentString: (value, digits = 2) => formatDecimalPercent(value, digits),
      percentPointsString: (value, digits = 2) => formatDecimalPercentPoints(value, digits),
    }),
    [settings, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within SettingsProvider');
  return context;
}
