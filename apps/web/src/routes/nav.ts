import type { LucideIcon } from 'lucide-react';
import {
  Briefcase,
  Calculator,
  Download,
  GitCompareArrows,
  LayoutDashboard,
  Library,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Upload,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  section: 'Overview' | 'Portfolio' | 'Models & Governance' | 'Workspace';
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, section: 'Overview' },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase, section: 'Portfolio' },
  { to: '/imports', label: 'Data Imports', icon: Upload, section: 'Portfolio' },
  { to: '/ecl-runs', label: 'ECL Runs', icon: Calculator, section: 'Portfolio' },
  { to: '/exceptions', label: 'Exception Queue', icon: ShieldAlert, section: 'Portfolio' },
  { to: '/scenarios', label: 'Macro Scenarios', icon: TrendingUp, section: 'Models & Governance' },
  { to: '/model-governance', label: 'Model Governance', icon: ShieldCheck, section: 'Models & Governance' },
  { to: '/documents', label: 'Governance Documents', icon: Library, section: 'Models & Governance' },
  { to: '/overrides', label: 'Stage Overrides', icon: GitCompareArrows, section: 'Models & Governance' },
  { to: '/reports', label: 'Reports & Exports', icon: Download, section: 'Models & Governance' },
  { to: '/copilot', label: 'AI Copilot', icon: Sparkles, section: 'Workspace' },
  { to: '/audit-log', label: 'Audit Log', icon: ScrollText, section: 'Workspace' },
  { to: '/settings', label: 'Settings', icon: Settings, section: 'Workspace' },
];

export const NAV_SECTIONS = ['Overview', 'Portfolio', 'Models & Governance', 'Workspace'] as const;

/** Titles used for breadcrumbs and the command palette. */
export const ROUTE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/portfolio': 'Portfolio',
  '/imports': 'Data Imports',
  '/ecl-runs': 'ECL Runs',
  '/exceptions': 'Exception Queue',
  '/scenarios': 'Macro Scenarios',
  '/model-governance': 'Model Governance',
  '/documents': 'Governance Documents',
  '/overrides': 'Stage Overrides',
  '/reports': 'Reports & Exports',
  '/copilot': 'AI Copilot',
  '/audit-log': 'Audit Log',
  '/settings': 'Settings',
};
