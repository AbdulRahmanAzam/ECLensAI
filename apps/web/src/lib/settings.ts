export interface AppSettings {
  currency: string;
  sidebarCollapsed: boolean;
}

const STORAGE_KEY = 'eclens.settings';

const DEFAULT_SETTINGS: AppSettings = {
  currency: import.meta.env.VITE_CURRENCY || 'PKR',
  sidebarCollapsed: false,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function persistSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings stay in memory.
  }
}
