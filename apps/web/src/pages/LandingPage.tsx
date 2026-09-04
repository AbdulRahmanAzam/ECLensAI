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

const WORKFLOW_STEPS = [
  {
    icon: Database,
    title: '1 · Ingest & validate',
    body: 'Import portfolio extracts against a strict data dictionary. Every row is schema- and range-validated before anything is computed.',
  },
  {
    icon: Layers,
    title: '2 · Stage & compute',
    body: 'The deterministic engine stages every exposure under IFRS 9 proxies and computes PD × LGD × EAD × DF — reproducible to the last rupee.',
  },
  {
    icon: Workflow,
    title: '3 · Weight scenarios',
    body: 'Base, upside and downside macro views are applied with approved weights, and every parameter set is versioned and governed.',
  },
  {
    icon: FileSearch,
    title: '4 · Explain & report',
    body: 'Each figure carries its full derivation. Auditors get stage movement, disclosures and an immutable action trail — ready for review.',
  },
];

const AI_CAPABILITIES = [
  { title: 'Explain', body: 'Plain-language rationale for any ECL figure, staging decision or scenario shift.' },
  { title: 'Extract', body: 'Pull structured exposure and collateral fields from unstructured documents.' },
  { title: 'Classify', body: 'Flag SICR candidates and suggest watchlist additions for analyst confirmation.' },
  { title: 'Recommend', body: 'Propose governance actions — never authoritative numbers, always attributed.' },
];

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-navy-950 text-sm font-bold text-teal-400">
              E
            </div>
            <span className="text-sm font-semibold tracking-tight text-navy-950">ECLens AI</span>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-slate-600 md:flex">
            <a href="#problem" className="transition-colors hover:text-navy-800">Why ECLens</a>
            <a href="#workflow" className="transition-colors hover:text-navy-800">How it works</a>
            <a href="#ai" className="transition-colors hover:text-navy-800">AI capabilities</a>
            <a href="#security" className="transition-colors hover:text-navy-800">Security</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login">
              <Button variant="ghost" size="sm">Sign in</Button>
            </Link>
            <Link to="/login">
              <Button size="sm" icon={<ArrowRight className="h-3.5 w-3.5" />}>Start Demo</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-slate-200 bg-gradient-to-b from-navy-50/60 to-white">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-8 md:py-24">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
            <Calculator className="h-3.5 w-3.5" /> IFRS 9 Expected Credit Loss · Deterministic & explainable
          </p>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-navy-950 md:text-5xl md:leading-[1.1]">
            Expected credit losses your auditors can actually follow.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-slate-600 md:text-lg">
            Banks, MFIs and NBFCs still compute ECL in spreadsheets and black-box models. ECLens AI
            combines a fully deterministic calculation engine with governed AI — so every allowance is
            reproducible, every stage decision is justified, and every action is auditable.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/login">
              <Button size="md" icon={<ArrowRight className="h-4 w-4" />}>Start Demo</Button>
            </Link>
            <a href="#workflow">
              <Button variant="secondary" size="md">See how it works</Button>
            </a>
          </div>
          <dl className="mt-12 grid max-w-2xl grid-cols-3 gap-6 border-t border-slate-200 pt-6">
            {[
              ['3-stage', 'IFRS 9 staging with documented proxies'],
              ['100%', 'of figures reproducible from stored inputs'],
              ['0', 'authoritative numbers produced by AI'],
            ].map(([value, label]) => (
              <div key={label}>
                <dt className="text-2xl font-semibold tracking-tight text-navy-900">{value}</dt>
                <dd className="mt-1 text-xs text-slate-500">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Problem */}
      <section id="problem" className="border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-8">
          <h2 className="text-2xl font-semibold tracking-tight text-navy-950">The problem</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {[
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
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-card">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-navy-50 text-navy-700">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-3 text-sm font-semibold text-navy-950">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-8">
          <h2 className="text-2xl font-semibold tracking-tight text-navy-950">How ECLens AI works</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            A four-step pipeline where the numbers come from tested application code and the AI stays
            firmly in an advisory seat.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW_STEPS.map((step) => (
              <div key={step.title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-card">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-teal-50 text-teal-700">
                  <step.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-3 text-sm font-semibold text-navy-950">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI capabilities */}
      <section id="ai" className="border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-8">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-navy-950">AI, on a leash</h2>
              <p className="mt-2 max-w-2xl text-sm text-slate-600">
                The copilot explains, extracts, classifies and recommends — but the deterministic
                engine owns every authoritative figure. That boundary is enforced in the
                architecture, not in a policy document.
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded border border-navy-200 bg-navy-50 px-2 py-1 text-xs font-medium text-navy-700">
              <Bot className="h-3.5 w-3.5" /> Advisory only · never the calculator
            </span>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {AI_CAPABILITIES.map((capability) => (
              <div key={capability.title} className="rounded-lg border border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-navy-900">{capability.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{capability.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="border-b border-slate-200 bg-navy-950">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-8">
          <h2 className="text-2xl font-semibold tracking-tight text-white">Built for regulated environments</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {[
              { icon: ShieldCheck, title: 'Role-based access', body: 'Admin, risk analyst, reviewer and auditor roles with enforced middleware — separation of duties by default.' },
              { icon: Lock, title: 'Secure sessions', body: 'JWT in httpOnly cookies, bcrypt password hashing, security headers, CORS allow-lists and rate limiting.' },
              { icon: ScrollText, title: 'Immutable audit trail', body: 'Every login, run, approval and export is recorded with actor, role and timestamp.' },
              { icon: Database, title: 'Your data stays yours', body: 'Self-hostable stack on PostgreSQL. Demo datasets are synthetic — no real borrower information anywhere.' },
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-navy-800 bg-navy-900/60 p-5">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-navy-800 text-teal-400">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-3 text-sm font-semibold text-white">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-16 text-center md:px-8">
        <h2 className="text-2xl font-semibold tracking-tight text-navy-950">See a full ECL workspace in two minutes</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-600">
          The demo is pre-seeded with a synthetic 44-exposure portfolio, three macro scenarios and
          completed calculation runs — no signup, no data entry.
        </p>
        <div className="mt-6">
          <Link to="/login">
            <Button size="md" icon={<ArrowRight className="h-4 w-4" />}>Start Demo</Button>
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-slate-500 md:flex-row md:px-8">
          <p>© 2026 ECLens AI · Hackathon prototype for demonstration purposes.</p>
          <p>Figures shown in the demo are synthetic and must not inform real provisioning.</p>
        </div>
      </footer>
    </div>
  );
}
