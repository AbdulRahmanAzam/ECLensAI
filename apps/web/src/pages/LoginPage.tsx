import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, ArrowLeft, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/providers/AuthProvider';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

type LoginValues = z.infer<typeof loginSchema>;

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
      push('success', `Welcome back, ${user.fullName.split(' ')[0]}`, `Signed in as ${user.role.replace('_', ' ')}.`);
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
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <div className="hidden flex-col justify-between bg-navy-950 p-10 lg:flex">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-navy-800 text-sm font-bold text-teal-400">
            E
          </span>
          <span className="text-sm font-semibold text-white">ECLens AI</span>
        </Link>
        <div>
          <h2 className="max-w-sm text-2xl font-semibold tracking-tight text-white">
            Explainable Expected Credit Loss for regulated lenders.
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
            Deterministic IFRS 9 engine · scenario-weighted allowances · full audit trail. The AI
            copilot explains and recommends — it never computes the authoritative number.
          </p>
        </div>
        <div className="rounded-lg border border-navy-800 bg-navy-900/60 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-teal-400">
            <Sparkles className="h-3.5 w-3.5" /> Seeded demo accounts
          </p>
          <ul className="mt-2 space-y-1 text-xs text-slate-300">
            <li>demo@eclens.ai — Risk Analyst</li>
            <li>admin@eclens.ai — Admin</li>
            <li>reviewer@eclens.ai — Reviewer</li>
            <li>auditor@eclens.ai — Auditor</li>
            <li className="pt-1 text-slate-500">Password for all demo users: Demo1234!</li>
          </ul>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-sm">
          <Link
            to="/"
            className="mb-8 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-navy-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to home
          </Link>

          <h1 className="text-xl font-semibold tracking-tight text-navy-950">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Access the ECL workspace for your organization.
          </p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
            {formError ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
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

            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
            <Button type="button" variant="secondary" className="w-full" onClick={fillDemo}>
              Use demo account
            </Button>
          </form>

          <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-400">
            Passwords are bcrypt-hashed and the session is a JWT in a secure httpOnly cookie issued by
            the ECLens API. Accounts belong to the synthetic demo dataset.
          </p>
        </div>
      </div>
    </div>
  );
}
