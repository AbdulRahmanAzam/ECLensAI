import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, ArrowLeft, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/providers/AuthProvider';
import { BrandMark } from '@/components/layout/BrandMark';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginValues = z.infer<typeof loginSchema>;

const DEMO_ACCOUNTS = [
  ['demo@eclens.ai', 'Risk Analyst'],
  ['admin@eclens.ai', 'Admin'],
  ['reviewer@eclens.ai', 'Reviewer'],
  ['auditor@eclens.ai', 'Auditor'],
];

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { push } = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  if (status === 'authenticated') {
    return <Navigate to="/dashboard" replace />;
  }

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const onSubmit = async (values: LoginValues) => {
    setFormError(null);
    try {
      const user = await login(values.email, values.password);
      push(
        'success',
        `Welcome back, ${user.fullName.split(' ')[0]}`,
        `Signed in as ${user.role.replace('_', ' ')}.`,
      );
      navigate(from, { replace: true });
    } catch {
      setFormError('Invalid email or password. Try the demo account below.');
    }
  };

  const fillDemo = () => {
    setValue('email', 'demo@eclens.ai', { shouldValidate: true });
    setValue('password', 'Demo1234!', { shouldValidate: true });
    setFormError(null);
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="ink-canvas grain relative hidden flex-col justify-between overflow-hidden bg-ink p-12 lg:flex">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.13]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgb(255 255 255 / 0.6) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.6) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(80% 55% at 20% 10%, black, transparent)',
            WebkitMaskImage: 'radial-gradient(80% 55% at 20% 10%, black, transparent)',
          }}
        />

        <Link to="/" className="relative flex w-fit items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-sm font-semibold tracking-tight text-white">ECLens AI</span>
        </Link>

        <div className="relative">
          <h2 className="max-w-md font-display text-[2.6rem] font-normal leading-[1.08] tracking-tight text-white">
            Explainable Expected Credit Loss for{' '}
            <span className="bg-gradient-to-r from-teal-300 to-teal-100 bg-clip-text italic text-transparent">
              regulated lenders.
            </span>
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/55">
            Deterministic IFRS 9 engine · scenario-weighted allowances · full audit trail. The AI
            copilot explains and recommends — it never computes the authoritative number.
          </p>
          <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-2xs font-medium text-teal-200 ring-1 ring-inset ring-white/10">
            <ShieldCheck className="h-3.5 w-3.5" /> Synthetic demo data · no real borrowers
          </p>
        </div>

        <div className="relative rounded-2xl bg-white/[0.05] p-5 ring-1 ring-inset ring-white/10">
          <p className="flex items-center gap-2 text-xs font-semibold text-teal-300">
            <Sparkles className="h-3.5 w-3.5" /> Seeded demo accounts
          </p>
          <ul className="mt-3 space-y-1.5">
            {DEMO_ACCOUNTS.map(([email, role]) => (
              <li key={email} className="flex items-center justify-between gap-4 text-xs">
                <span className="font-mono text-white/70">{email}</span>
                <span className="text-white/40">{role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-white/10 pt-3 text-2xs text-white/40">
            Password for all demo users: <span className="font-mono text-white/70">Demo1234!</span>
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="app-canvas flex items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm animate-fade-up">
          <Link
            to="/"
            className="mb-10 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to home
          </Link>

          <div className="mb-8 lg:hidden">
            <BrandMark className="h-11 w-11" />
          </div>

          <h1 className="font-display text-[2.25rem] font-normal leading-none tracking-tight text-slate-900">
            Sign in
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Access the ECL workspace for your organization.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-7 space-y-4" noValidate>
            {formError ? (
              <div
                role="alert"
                className="flex animate-fade-in items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-xs text-red-700 ring-1 ring-inset ring-red-500/20"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {formError}
              </div>
            ) : null}

            <Input
              label="Work email"
              type="email"
              autoComplete="email"
              placeholder="you@institution.com"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              error={errors.password?.message}
              {...register('password')}
            />

            <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={fillDemo}
            >
              Use demo account
            </Button>
          </form>

          <p className="mt-8 text-center text-2xs leading-relaxed text-slate-400">
            Passwords are bcrypt-hashed and the session is a JWT in a secure httpOnly cookie issued
            by the ECLens API. Accounts belong to the synthetic demo dataset.
          </p>
        </div>
      </div>
    </div>
  );
}
