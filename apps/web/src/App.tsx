import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/Skeleton';
import { LandingPage } from '@/pages/LandingPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ProtectedRoute } from '@/routes/ProtectedRoute';

// Every authenticated page is route-level code-split: the initial bundle only
// needs the landing/login/shell code, and each page's own weight (a chart
// library import, a large form) is fetched on first visit to that route
// rather than paid by everyone up front.
const AuditLogPage = lazy(() =>
  import('@/pages/AuditLogPage').then((m) => ({ default: m.AuditLogPage })),
);
const CopilotPage = lazy(() =>
  import('@/pages/CopilotPage').then((m) => ({ default: m.CopilotPage })),
);
const DashboardPage = lazy(() =>
  import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const DocumentsPage = lazy(() =>
  import('@/pages/DocumentsPage').then((m) => ({ default: m.DocumentsPage })),
);
const EclRunDetailPage = lazy(() =>
  import('@/pages/EclRunDetailPage').then((m) => ({ default: m.EclRunDetailPage })),
);
const EclRunsPage = lazy(() =>
  import('@/pages/EclRunsPage').then((m) => ({ default: m.EclRunsPage })),
);
const ExceptionsPage = lazy(() =>
  import('@/pages/ExceptionsPage').then((m) => ({ default: m.ExceptionsPage })),
);
const ExposureDetailPage = lazy(() =>
  import('@/pages/ExposureDetailPage').then((m) => ({ default: m.ExposureDetailPage })),
);
const ImportsPage = lazy(() =>
  import('@/pages/ImportsPage').then((m) => ({ default: m.ImportsPage })),
);
const ModelGovernancePage = lazy(() =>
  import('@/pages/ModelGovernancePage').then((m) => ({ default: m.ModelGovernancePage })),
);
const OverridesPage = lazy(() =>
  import('@/pages/OverridesPage').then((m) => ({ default: m.OverridesPage })),
);
const PortfolioPage = lazy(() =>
  import('@/pages/PortfolioPage').then((m) => ({ default: m.PortfolioPage })),
);
const ReportsPage = lazy(() =>
  import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const ScenariosPage = lazy(() =>
  import('@/pages/ScenariosPage').then((m) => ({ default: m.ScenariosPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

function PageFallback() {
  return (
    <div className="space-y-4 p-1">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route
            path="/dashboard"
            element={
              <Suspense fallback={<PageFallback />}>
                <DashboardPage />
              </Suspense>
            }
          />
          <Route
            path="/portfolio"
            element={
              <Suspense fallback={<PageFallback />}>
                <PortfolioPage />
              </Suspense>
            }
          />
          <Route
            path="/portfolio/:exposureId"
            element={
              <Suspense fallback={<PageFallback />}>
                <ExposureDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/imports"
            element={
              <Suspense fallback={<PageFallback />}>
                <ImportsPage />
              </Suspense>
            }
          />
          <Route
            path="/ecl-runs"
            element={
              <Suspense fallback={<PageFallback />}>
                <EclRunsPage />
              </Suspense>
            }
          />
          <Route
            path="/ecl-runs/:runId"
            element={
              <Suspense fallback={<PageFallback />}>
                <EclRunDetailPage />
              </Suspense>
            }
          />
          <Route
            path="/exceptions"
            element={
              <Suspense fallback={<PageFallback />}>
                <ExceptionsPage />
              </Suspense>
            }
          />
          <Route
            path="/scenarios"
            element={
              <Suspense fallback={<PageFallback />}>
                <ScenariosPage />
              </Suspense>
            }
          />
          <Route
            path="/copilot"
            element={
              <Suspense fallback={<PageFallback />}>
                <CopilotPage />
              </Suspense>
            }
          />
          <Route
            path="/reports"
            element={
              <Suspense fallback={<PageFallback />}>
                <ReportsPage />
              </Suspense>
            }
          />
          <Route
            path="/model-governance"
            element={
              <Suspense fallback={<PageFallback />}>
                <ModelGovernancePage />
              </Suspense>
            }
          />
          <Route
            path="/documents"
            element={
              <Suspense fallback={<PageFallback />}>
                <DocumentsPage />
              </Suspense>
            }
          />
          <Route
            path="/overrides"
            element={
              <Suspense fallback={<PageFallback />}>
                <OverridesPage />
              </Suspense>
            }
          />
          <Route
            path="/audit-log"
            element={
              <Suspense fallback={<PageFallback />}>
                <AuditLogPage />
              </Suspense>
            }
          />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<PageFallback />}>
                <SettingsPage />
              </Suspense>
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
