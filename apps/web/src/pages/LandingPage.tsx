import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  Calculator,
  Database,
  FileSearch,
  Layers,
  Lock,
  ScrollText,
  SearchCheck,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { BrandMark } from '@/components/layout/BrandMark';

const WORKFLOW_STEPS = [
  {
    step: '01',
    icon: Database,
    title: 'Ingest & validate',
    body: 'Import portfolio extracts against a strict data dictionary. Every row is schema- and range-validated before anything is computed.',
  },
  {
    step: '02',
    icon: Layers,
    title: 'Stage & compute',
    body: 'The deterministic engine stages every exposure under IFRS 9 proxies and computes PD × LGD × EAD × DF — reproducible to the last rupee.',
  },
  {
    step: '03',
    icon: Workflow,
    title: 'Weight scenarios',
    body: 'Base, upside and downside macro views are applied with approved weights, and every parameter set is versioned and governed.',
  },
  {
    step: '04',
    icon: FileSearch,
    title: 'Explain & report',
    body: 'Each figure carries its full derivation. Auditors get stage movement, disclosures and an immutable action trail — ready for review.',
  },
];

const AI_CAPABILITIES = [
  {
    title: 'Explain',
    body: 'Plain-language rationale for any ECL figure, staging decision or scenario shift.',
  },
  {
    title: 'Extract',
    body: 'Pull structured exposure and collateral fields from unstructured documents.',
  },
  {
    title: 'Classify',
    body: 'Flag SICR candidates and suggest watchlist additions for analyst confirmation.',
  },
  {
    title: 'Recommend',
    body: 'Propose governance actions — never authoritative numbers, always attributed.',
  },
];

const PROBLEMS = [
  {
    icon: FileSearch,
    title: 'Spreadsheet risk',
    body: 'Month-end ECL lives in fragile workbooks. One wrong PD column and the allowance silently misstates the books.',
  },
  {
    icon: SearchCheck,
    title: 'Opaque models',
    body: 'When regulators ask “why is this exposure in Stage 2?”, teams spend days reconstructing decisions that were never recorded.',
  },
  {
    icon: ScrollText,
    title: 'Audit friction',
    body: 'Without versioned parameters, scenario weights and an action trail, every audit becomes a forensic exercise.',
  },
];

const SECURITY = [
  {
    icon: ShieldCheck,
    title: 'Role-based access',
    body: 'Admin, risk analyst, reviewer and auditor roles with enforced middleware — separation of duties by default.',
  },
  {
    icon: Lock,
    title: 'Secure sessions',
    body: 'JWT in httpOnly cookies, bcrypt password hashing, security headers, CORS allow-lists and rate limiting.',
  },
  {
    icon: ScrollText,
    title: 'Immutable audit trail',
    body: 'Every login, run, approval and export is recorded with actor, role and timestamp.',
  },
  {
    icon: Database,
    title: 'Your data stays yours',
    body: 'Self-hostable stack on PostgreSQL. Demo datasets are synthetic — no real borrower information anywhere.',
  },
];

const NAV_LINKS = [
  ['#problem', 'Why ECLens'],
  ['#workflow', 'How it works'],
  ['#ai', 'AI capabilities'],
  ['#security', 'Security'],
];

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.18em] text-brand">{children}</p>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <Link to="/" className="flex items-center gap-2.5">
            <BrandMark className="h-9 w-9" />
            <span className="text-sm font-semibold tracking-tight text-slate-900">ECLens AI</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-slate-500 md:flex">
            {NAV_LINKS.map(([href, label]) => (
              <a key={href} href={href} className="transition-colors hover:text-slate-900">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </Link>
            <Link to="/login">
              <Button size="sm" icon={<ArrowRight className="h-3.5 w-3.5" />}>
                Start Demo
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — the only always-dark section above the fold. It sets the brand
          so every product surface below can stay quiet paper. */}
      <section className="ink-canvas grain relative overflow-hidden bg-ink">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgb(255 255 255 / 0.6) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.6) 1px, transparent 1px)',
            backgroundSize: '54px 54px',
            maskImage: 'radial-gradient(70% 60% at 30% 0%, black, transparent)',
            WebkitMaskImage: 'radial-gradient(70% 60% at 30% 0%, black, transparent)',
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-24 md:px-8 md:py-32">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/[0.07] py-1 pl-2 pr-3 text-xs font-medium text-teal-200 ring-1 ring-inset ring-white/15">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-400/15">
              <Calculator className="h-3 w-3" />
            </span>
            IFRS 9 Expected Credit Loss · Deterministic &amp; explainable
          </p>
          <h1 className="max-w-4xl font-display text-[2.6rem] font-normal leading-[1.05] tracking-tight text-white md:text-[4.15rem]">
            Expected credit losses your auditors can{' '}
            <span className="bg-gradient-to-r from-teal-300 to-teal-100 bg-clip-text italic text-transparent">
              actually follow.
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/60 md:text-lg">
            Banks, MFIs and NBFCs still compute ECL in spreadsheets and black-box models. ECLens AI
            combines a fully deterministic calculation engine with governed AI — so every allowance
            is reproducible, every stage decision is justified, and every action is auditable.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/login">
              <Button size="lg" variant="accent" icon={<ArrowRight className="h-4 w-4" />}>
                Start Demo
              </Button>
            </Link>
            <a href="#workflow">
              <Button size="lg" variant="inverse">
                See how it works
              </Button>
            </a>
          </div>
          <dl className="mt-14 grid max-w-2xl grid-cols-1 gap-6 border-t border-white/10 pt-8 sm:grid-cols-3">
            {[
              ['3-stage', 'IFRS 9 staging with documented proxies'],
              ['100%', 'of figures reproducible from stored inputs'],
              ['0', 'authoritative numbers produced by AI'],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="font-display text-[2.4rem] font-normal leading-none tracking-tight text-white tabular-nums">
                  {value}
                </dt>
                <dd className="mt-1.5 text-xs leading-relaxed text-white/45">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Problem */}
      <section id="problem" className="border-b border-line">
        <div className="relative mx-auto max-w-6xl px-4 py-20 md:px-8">
          <SectionLabel>The problem</SectionLabel>
          <h2 className="max-w-2xl font-display text-[2rem] font-normal leading-tight tracking-tight text-slate-900 md:text-[2.6rem]">
            Three failure modes every provisioning team already knows.
          </h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PROBLEMS.map((item) => (
              <div
                key={item.title}
                className="group rounded-2xl border border-line bg-surface p-6 shadow-card transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-raised"
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-inset ring-red-500/15">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-b border-line bg-surface-2">
        <div className="relative mx-auto max-w-6xl px-4 py-20 md:px-8">
          <SectionLabel>The pipeline</SectionLabel>
          <h2 className="font-display text-[2rem] font-normal leading-tight tracking-tight text-slate-900 md:text-[2.6rem]">
            How ECLens AI works
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500">
            A four-step pipeline where the numbers come from tested application code and the AI
            stays firmly in an advisory seat.
          </p>
          <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW_STEPS.map((step) => (
              <li
                key={step.title}
                className="relative overflow-hidden rounded-2xl border border-line bg-surface p-6 shadow-card"
              >
                <span
                  aria-hidden
                  className="absolute -right-3 -top-4 text-[4.5rem] font-semibold leading-none tracking-tightest text-slate-900/[0.045]"
                >
                  {step.step}
                </span>
                <span className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand ring-1 ring-inset ring-navy-500/15">
                  <step.icon className="h-5 w-5" />
                </span>
                <h3 className="relative mt-4 text-base font-semibold text-slate-900">
                  {step.title}
                </h3>
                <p className="relative mt-2 text-sm leading-relaxed text-slate-500">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* AI capabilities */}
      <section id="ai" className="border-b border-line">
        <div className="relative mx-auto max-w-6xl px-4 py-20 md:px-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <SectionLabel>Governed AI</SectionLabel>
              <h2 className="font-display text-[2rem] font-normal leading-tight tracking-tight text-slate-900 md:text-[2.6rem]">
                AI, on a leash
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500">
                The copilot explains, extracts, classifies and recommends — but the deterministic
                engine owns every authoritative figure. That boundary is enforced in the
                architecture, not in a policy document.
              </p>
            </div>
            <span className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full bg-brand-soft px-3 py-1.5 text-xs font-medium text-navy-700 ring-1 ring-inset ring-navy-500/20">
              <Bot className="h-3.5 w-3.5" /> Advisory only · never the calculator
            </span>
          </div>
          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
            {AI_CAPABILITIES.map((capability) => (
              <div key={capability.title} className="bg-surface p-6">
                <h3 className="text-base font-semibold text-slate-900">{capability.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{capability.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security */}
      <section
        id="security"
        className="ink-canvas grain relative overflow-hidden border-b border-line bg-ink"
      >
        <div className="relative mx-auto max-w-6xl px-4 py-20 md:px-8">
          <p className="mb-3 text-2xs font-semibold uppercase tracking-[0.18em] text-teal-300">
            Controls
          </p>
          <h2 className="font-display text-[2rem] font-normal leading-tight tracking-tight text-white md:text-[2.6rem]">
            Built for regulated environments
          </h2>
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {SECURITY.map((item) => (
              <div
                key={item.title}
                className="rounded-2xl bg-white/[0.04] p-6 ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.07]"
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-teal-400/10 text-teal-300 ring-1 ring-inset ring-teal-300/20">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/50">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-20 md:px-8">
        <div className="rounded-3xl border border-line bg-surface px-6 py-14 text-center shadow-card">
          <h2 className="font-display text-[2rem] font-normal leading-tight tracking-tight text-slate-900 md:text-[2.6rem]">
            See a full ECL workspace in two minutes
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-500">
            The demo is pre-seeded with a synthetic 44-exposure portfolio, three macro scenarios and
            completed calculation runs — no signup, no data entry.
          </p>
          <div className="mt-7">
            <Link to="/login">
              <Button size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                Start Demo
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line bg-surface-2">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-7 text-xs text-slate-500 md:flex-row md:px-8">
          <p>© 2026 ECLens AI · Hackathon prototype for demonstration purposes.</p>
          <p>Figures shown in the demo are synthetic and must not inform real provisioning.</p>
        </div>
      </footer>
    </div>
  );
}
