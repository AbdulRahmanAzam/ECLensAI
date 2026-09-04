import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Check, LogOut, Monitor, Moon, ShieldCheck, Sun, User as UserIcon, X } from 'lucide-react';
import type { RoleName } from '@eclens/shared';
import { Badge, SyntheticBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { useAuth } from '@/providers/AuthProvider';
import { useSettings } from '@/providers/SettingsProvider';
import type { ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR'];

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const ROLE_LABEL: Record<RoleName, string> = {
  ADMIN: 'Admin',
  RISK_ANALYST: 'Risk Analyst',
  REVIEWER: 'Reviewer',
  AUDITOR: 'Auditor',
};

interface Capability {
  label: string;
  grants: RoleName[];
}

const CAPABILITIES: Capability[] = [
  { label: 'View portfolio & runs', grants: ['ADMIN', 'RISK_ANALYST', 'REVIEWER', 'AUDITOR'] },
  { label: 'Import data', grants: ['ADMIN', 'RISK_ANALYST'] },
  { label: 'Start ECL runs', grants: ['ADMIN', 'RISK_ANALYST'] },
  { label: 'Approve scenario weights', grants: ['ADMIN', 'REVIEWER'] },
  { label: 'Generate reports', grants: ['ADMIN', 'RISK_ANALYST', 'REVIEWER', 'AUDITOR'] },
  { label: 'Manage users & roles', grants: ['ADMIN'] },
  { label: 'View audit log', grants: ['ADMIN', 'AUDITOR'] },
];

const ROLE_ORDER: RoleName[] = ['ADMIN', 'RISK_ANALYST', 'REVIEWER', 'AUDITOR'];

function Cell({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="flex justify-center text-emerald-600">
      <Check className="h-4 w-4" />
    </span>
  ) : (
    <span className="flex justify-center text-slate-300">
      <X className="h-4 w-4" />
    </span>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { currency, setCurrency, sidebarCollapsed, toggleSidebar, theme, setTheme } = useSettings();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => navigate('/login'),
  });

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Your profile, display preferences and the permissions that govern this workspace."
        tags={<SyntheticBadge />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" description="Seeded demo account" />
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-1 ring-inset ring-navy-500/15">
                <UserIcon className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-900">{user?.fullName ?? '—'}</p>
                <p className="text-xs text-slate-500">{user?.email ?? '—'}</p>
              </div>
            </div>
            <dl className="space-y-2 border-t border-line-soft pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Role</dt>
                <dd>{user ? <Badge tone="info">{ROLE_LABEL[user.role]}</Badge> : '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Organization</dt>
                <dd className="text-slate-800">{user?.organizationName ?? '—'}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Display preferences"
            description="Applies across the workspace and persists locally"
          />
          <CardContent className="space-y-4">
            <Select
              label="Working currency"
              hint="Money values across the app are shown in this currency."
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>

            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-600">Appearance</p>
              <div
                role="radiogroup"
                aria-label="Appearance"
                className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface-2 p-1"
              >
                {THEMES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.value}
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      'flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-all duration-150',
                      theme === option.value
                        ? 'bg-surface text-slate-900 shadow-xs'
                        : 'text-slate-500 hover:text-slate-800',
                    )}
                  >
                    <option.icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-slate-500">
                “System” follows your operating system setting and updates live.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-line px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-slate-700">Collapse sidebar</p>
                <p className="text-xs text-slate-500">
                  Show icons only for a denser analyst layout.
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={toggleSidebar}>
                {sidebarCollapsed ? 'Expand' : 'Collapse'}
              </Button>
            </div>

            <div className="border-t border-line-soft pt-3">
              <Button
                variant="danger"
                size="sm"
                icon={<LogOut className="h-4 w-4" />}
                onClick={() => setConfirmSignOut(true)}
              >
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Role permissions"
          description={
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-navy-600" />
              Enforced by authorization middleware on the API
            </span>
          }
        />
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-3 font-semibold">Capability</th>
                  {ROLE_ORDER.map((role) => (
                    <th key={role} className="px-3 py-2 text-center font-semibold">
                      {ROLE_LABEL[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CAPABILITIES.map((capability) => (
                  <tr key={capability.label} className="border-b border-line-soft last:border-b-0">
                    <td className="py-2.5 pr-3 text-slate-700">{capability.label}</td>
                    {ROLE_ORDER.map((role) => (
                      <td key={role} className="px-3 py-2.5">
                        <Cell allowed={capability.grants.includes(role)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out?"
        description="You will be returned to the login screen. Your working preferences are kept."
        confirmLabel="Sign out"
        destructive
        loading={signOut.isPending}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => signOut.mutate()}
      />
    </div>
  );
}
