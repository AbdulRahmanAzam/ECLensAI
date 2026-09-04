/**
 * Typed client for the v1 API.
 *
 * Step 1 bound the `Api` interface to an in-memory mock; this is the fetch-backed
 * implementation Step 2 swapped in. Two invariants hold throughout:
 *
 *   1. Money and rates stay **decimal strings** end to end. Nothing here parses
 *      them into a binary float, so a figure rendered on screen is the figure the
 *      engine persisted. `@eclens/shared`'s `formatDecimal*` helpers do the
 *      rendering.
 *   2. Every response is unwrapped from its envelope here, not in a page. The API
 *      wraps single resources (`{ run }`, `{ modelConfiguration }`, `{ batch }`)
 *      and pages (`{ items, meta }`); pages therefore only ever see records.
 */
import type {
  AiImportMappingRequest,
  AiResponse,
  AiStatusResponse,
  AnalyticsConcentration,
  AnalyticsDrivers,
  AnalyticsFilter,
  AnalyticsMigration,
  AnalyticsScenarios,
  AnalyticsSummary,
  AnalyticsTrend,
  AuditEventRecord,
  AuditListQuery,
  CopilotFeedbackRequest,
  CopilotFeedbackResponse,
  CopilotQueryRequest,
  CopilotQueryResponse,
  CopilotThreadListResponse,
  CopilotThreadRecord,
  CreateModelConfigurationRequest,
  CreateRunRequest,
  CreateScenarioSetRequest,
  DataQualityInvestigation,
  DocumentExtraction,
  DocumentListQuery,
  DocumentListResponse,
  DocumentRecord,
  DocumentSignalRecord,
  DocumentUploadRequest,
  DocumentUploadResponse,
  DriversQuery,
  EclExplanation,
  EclRunRecord,
  EclRunSummaryRecord,
  ExecutiveCommentary,
  ExecutiveCommentaryRequest,
  ExceptionItemRecord,
  ExceptionListQuery,
  ExceptionSummaryRecord,
  ExplainEclRequest,
  ExposureDetailRecord,
  ExposureRecord,
  ImportBatchRecord,
  ImportIssuesRecord,
  ImportMappingSuggestionSet,
  ImportPreviewRecord,
  InvestigateQualityRequest,
  ListQuery,
  MappingRequest,
  MovementBridge,
  MovementQuery,
  CommitRequest,
  MigrationQuery,
  ModelConfigurationRecord,
  OverrideReviewRequest,
  Paginated,
  PortfolioFilters,
  PortfolioSnapshotRecord,
  PortfolioSummaryRecord,
  PortfolioTotalsDto,
  RunComparison,
  RunComparisonQuery,
  RunResultDetailRecord,
  RunResultRowRecord,
  ScenarioDraftRequest,
  ScenarioProposal,
  ScenarioQuery,
  ScenarioSetRecord,
  SessionUserRecord,
  SignalDecisionRequest,
  StageOverrideHistoryRecord,
  StageOverrideListItem,
  StageOverrideRequest,
  TemplateDownloadRecord,
  TrendQuery,
} from '@eclens/shared';
import { downloadText, request } from './http';

/** What a 202 answers with: the resource in its transitional state plus the job. */
export interface JobAccepted<T> {
  jobId: string;
  driver: string;
  record?: T;
  run?: EclRunRecord;
}

export interface ReportDownload {
  fileName: string;
  contentType: string;
  contentBase64: string;
}

export interface TemplateQuery {
  kind?: 'blank' | 'sample';
  format?: 'csv' | 'xlsx';
  reportingDate?: string;
  count?: number;
}

export interface Api {
  auth: {
    login(email: string, password: string): Promise<SessionUserRecord>;
    logout(): Promise<void>;
    restore(): Promise<SessionUserRecord | null>;
  };
  portfolio: {
    summary(snapshotId?: string): Promise<PortfolioSummaryRecord>;
    listExposures(query: ListQuery): Promise<Paginated<ExposureRecord>>;
    /** The full filtered set as CSV text, not one page of it. */
    exportExposuresCsv(query: ListQuery): Promise<string>;
    getExposure(idOrPublicId: string): Promise<ExposureDetailRecord>;
    listSnapshots(take?: number): Promise<PortfolioSnapshotRecord[]>;
  };
  imports: {
    list(query: ListQuery): Promise<Paginated<ImportBatchRecord>>;
    upload(file: File): Promise<JobAccepted<ImportBatchRecord> & { record: ImportBatchRecord }>;
    preview(idOrPublicId: string): Promise<ImportPreviewRecord>;
    applyMapping(idOrPublicId: string, input: MappingRequest): Promise<ImportBatchRecord>;
    commit(idOrPublicId: string, input?: CommitRequest): Promise<JobAccepted<ImportBatchRecord> & { record: ImportBatchRecord }>;
    issues(idOrPublicId: string): Promise<ImportIssuesRecord>;
    issuesCsv(idOrPublicId: string): Promise<string>;
  };
  templates: {
    portfolio(query?: TemplateQuery): Promise<TemplateDownloadRecord>;
  };
  runs: {
    list(query: ListQuery): Promise<Paginated<EclRunSummaryRecord>>;
    get(idOrPublicId: string): Promise<EclRunRecord>;
    create(input: CreateRunRequest): Promise<EclRunRecord>;
    execute(idOrPublicId: string): Promise<JobAccepted<EclRunRecord> & { run: EclRunRecord }>;
    results(idOrPublicId: string, query: ListQuery): Promise<Paginated<RunResultRowRecord> & { totals: PortfolioTotalsDto | null }>;
    resultDetail(idOrPublicId: string, exposureIdOrPublicId: string): Promise<RunResultDetailRecord>;
    submit(idOrPublicId: string, comment?: string): Promise<EclRunRecord>;
    approve(idOrPublicId: string, comment: string): Promise<EclRunRecord>;
    reject(idOrPublicId: string, comment: string): Promise<EclRunRecord>;
    /** `aiCommentary`, when supplied, is text the caller already fetched — never generated here. */
    report(idOrPublicId: string, aiCommentary?: { headline: string; overview: string } | null): Promise<ReportDownload>;
  };
  scenarios: {
    list(query: ListQuery): Promise<Paginated<ScenarioSetRecord>>;
    get(idOrPublicId: string): Promise<ScenarioSetRecord>;
    create(input: CreateScenarioSetRequest): Promise<ScenarioSetRecord>;
    approve(id: string): Promise<ScenarioSetRecord>;
  };
  modelConfigurations: {
    list(query: ListQuery): Promise<Paginated<ModelConfigurationRecord>>;
    get(idOrPublicId: string): Promise<ModelConfigurationRecord>;
    create(input: CreateModelConfigurationRequest): Promise<ModelConfigurationRecord>;
  };
  /**
   * Read-only aggregates behind `/api/v1/analytics/*`. Every method takes the
   * same filter shape the dashboard's URL carries, so a chart and the filter
   * chips above it never disagree about what is currently selected.
   */
  analytics: {
    summary(filter?: AnalyticsFilter): Promise<AnalyticsSummary>;
    movement(filter?: MovementQuery): Promise<MovementBridge>;
    trend(filter?: TrendQuery): Promise<AnalyticsTrend>;
    concentration(filter?: AnalyticsFilter): Promise<AnalyticsConcentration>;
    drivers(filter?: DriversQuery): Promise<AnalyticsDrivers>;
    filters(snapshotId?: string): Promise<PortfolioFilters>;
    scenarios(query?: ScenarioQuery): Promise<AnalyticsScenarios>;
    migration(query?: MigrationQuery): Promise<AnalyticsMigration>;
    runComparison(query?: RunComparisonQuery): Promise<RunComparison>;
  };
  overrides: {
    request(exposureIdOrPublicId: string, input: StageOverrideRequest): Promise<StageOverrideHistoryRecord>;
    review(overrideId: string, input: OverrideReviewRequest): Promise<StageOverrideHistoryRecord>;
    queue(query: ListQuery & { status?: 'PENDING_REVIEW' | 'REVIEWED' | 'REJECTED' }): Promise<Paginated<StageOverrideListItem>>;
  };
  exceptions: {
    list(query: ExceptionListQuery): Promise<Paginated<ExceptionItemRecord>>;
    summary(): Promise<ExceptionSummaryRecord>;
    acknowledge(id: string, note?: string): Promise<ExceptionItemRecord>;
    resolve(id: string, note?: string): Promise<ExceptionItemRecord>;
  };
  audit: {
    list(query: AuditListQuery): Promise<Paginated<AuditEventRecord>>;
  };
  /**
   * Every feature answers with the shared `AiResponse<T>` envelope, never a bare
   * record. That is the whole point of the shape: an unavailable model, a timeout
   * or a schema the model could not satisfy all arrive as a **200** with
   * `result: null` and an honest `message`, so a panel can say "AI unavailable"
   * instead of the page appearing broken. Callers branch on `status` once.
   */
  ai: {
    status(): Promise<AiStatusResponse>;
    queryCopilot(input: CopilotQueryRequest): Promise<CopilotQueryResponse>;
    listThreads(query: ListQuery): Promise<CopilotThreadListResponse>;
    getThread(threadId: string): Promise<CopilotThreadRecord>;
    feedback(threadId: string, turnId: string, input: CopilotFeedbackRequest): Promise<CopilotFeedbackResponse>;
    explainEcl(input: ExplainEclRequest): Promise<AiResponse<EclExplanation>>;
    suggestImportMapping(input: AiImportMappingRequest): Promise<AiResponse<ImportMappingSuggestionSet>>;
    investigateQuality(input: InvestigateQualityRequest): Promise<AiResponse<DataQualityInvestigation>>;
    draftScenario(input: ScenarioDraftRequest): Promise<AiResponse<ScenarioProposal>>;
    executiveCommentary(input: ExecutiveCommentaryRequest): Promise<AiResponse<ExecutiveCommentary>>;
  };
  demo: {
    /** Whole-database wipe-and-reseed. Invalidates the caller's own session — the response clears the cookie. */
    reset(): Promise<{ ok: true; durationMs: number }>;
  };
  documents: {
    list(query: DocumentListQuery): Promise<DocumentListResponse>;
    get(idOrPublicId: string): Promise<DocumentRecord>;
    upload(file: File, input: DocumentUploadRequest): Promise<DocumentUploadResponse>;
    extract(idOrPublicId: string, force?: boolean): Promise<AiResponse<DocumentExtraction>>;
    decideSignal(idOrPublicId: string, signalId: string, input: SignalDecisionRequest): Promise<DocumentSignalRecord>;
    remove(idOrPublicId: string): Promise<void>;
  };
}

const query = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined => value;

export const api: Api = {
  auth: {
    async login(email, password) {
      const body = await request<{ user: SessionUserRecord }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      return body.user;
    },
    async logout() {
      await request<{ success: boolean }>('/auth/logout', { method: 'POST' });
    },
    async restore() {
      // A missing or expired cookie is the normal anonymous state, not an error.
      try {
        const body = await request<{ user: SessionUserRecord }>('/auth/me');
        return body.user;
      } catch {
        return null;
      }
    },
  },

  portfolio: {
    summary: (snapshotId) => request<PortfolioSummaryRecord>('/portfolio/summary', { query: query({ snapshotId }) }),
    listExposures: (params) => request<Paginated<ExposureRecord>>('/portfolio/exposures', { query: { ...params } }),
    exportExposuresCsv: (params) => downloadText('/portfolio/exposures/export', { ...params }),
    getExposure: (id) => request<ExposureDetailRecord>(`/portfolio/exposures/${encodeURIComponent(id)}`),
    async listSnapshots(take = 50) {
      const body = await request<{ items: PortfolioSnapshotRecord[] }>('/portfolio/snapshots', { query: query({ take }) });
      return body.items;
    },
  },

  imports: {
    list: (params) => request<Paginated<ImportBatchRecord>>('/imports', { query: { ...params } }),
    upload: (file) => {
      const form = new FormData();
      form.append('file', file);
      return request('/imports/portfolio', { method: 'POST', body: form });
    },
    preview: (id) => request<ImportPreviewRecord>(`/imports/${encodeURIComponent(id)}/preview`),
    async applyMapping(id, input) {
      const body = await request<{ batch: ImportBatchRecord }>(`/imports/${encodeURIComponent(id)}/mapping`, {
        method: 'POST',
        body: input,
      });
      return body.batch;
    },
    commit: (id, input) =>
      request(`/imports/${encodeURIComponent(id)}/commit`, { method: 'POST', body: input ?? {} }),
    issues: (id) => request<ImportIssuesRecord>(`/imports/${encodeURIComponent(id)}/issues`),
    issuesCsv: (id) => downloadText(`/imports/${encodeURIComponent(id)}/issues/export`),
  },

  templates: {
    async portfolio(params = {}) {
      const body = await request<{ template: TemplateDownloadRecord }>('/templates/portfolio', { query: { ...params } });
      return body.template;
    },
  },

  runs: {
    list: (params) => request<Paginated<EclRunSummaryRecord>>('/ecl-runs', { query: { ...params } }),
    async get(id) {
      const body = await request<{ run: EclRunRecord }>(`/ecl-runs/${encodeURIComponent(id)}`);
      return body.run;
    },
    async create(input) {
      const body = await request<{ run: EclRunRecord }>('/ecl-runs', { method: 'POST', body: input });
      return body.run;
    },
    execute: (id) => request(`/ecl-runs/${encodeURIComponent(id)}/execute`, { method: 'POST' }),
    results: (id, params) =>
      request<Paginated<RunResultRowRecord> & { totals: PortfolioTotalsDto | null }>(
        `/ecl-runs/${encodeURIComponent(id)}/results`,
        { query: { ...params } },
      ),
    resultDetail: (id, exposureId) =>
      request<RunResultDetailRecord>(
        `/ecl-runs/${encodeURIComponent(id)}/results/${encodeURIComponent(exposureId)}`,
      ),
    async submit(id, comment) {
      const body = await request<{ run: EclRunRecord }>(`/ecl-runs/${encodeURIComponent(id)}/submit`, {
        method: 'POST',
        body: { comment },
      });
      return body.run;
    },
    async approve(id, comment) {
      const body = await request<{ run: EclRunRecord }>(`/ecl-runs/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: { comment },
      });
      return body.run;
    },
    async reject(id, comment) {
      const body = await request<{ run: EclRunRecord }>(`/ecl-runs/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        body: { comment },
      });
      return body.run;
    },
    async report(id, aiCommentary) {
      const body = await request<{ report: ReportDownload }>(`/ecl-runs/${encodeURIComponent(id)}/report`, {
        query: query({ aiHeadline: aiCommentary?.headline, aiOverview: aiCommentary?.overview }),
      });
      return body.report;
    },
  },

  scenarios: {
    list: (params) => request<Paginated<ScenarioSetRecord>>('/scenario-sets', { query: { ...params } }),
    async get(id) {
      const body = await request<{ scenarioSet: ScenarioSetRecord }>(`/scenario-sets/${encodeURIComponent(id)}`);
      return body.scenarioSet;
    },
    async create(input) {
      const body = await request<{ scenarioSet: ScenarioSetRecord }>('/scenario-sets', { method: 'POST', body: input });
      return body.scenarioSet;
    },
    async approve(id) {
      const body = await request<{ scenarioSet: ScenarioSetRecord }>(`/scenario-sets/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
      });
      return body.scenarioSet;
    },
  },

  modelConfigurations: {
    list: (params) => request<Paginated<ModelConfigurationRecord>>('/model-configurations', { query: { ...params } }),
    async get(id) {
      const body = await request<{ modelConfiguration: ModelConfigurationRecord }>(
        `/model-configurations/${encodeURIComponent(id)}`,
      );
      return body.modelConfiguration;
    },
    async create(input) {
      const body = await request<{ modelConfiguration: ModelConfigurationRecord }>('/model-configurations', {
        method: 'POST',
        body: input,
      });
      return body.modelConfiguration;
    },
  },

  analytics: {
    summary: (filter) => request<AnalyticsSummary>('/analytics/summary', { query: query({ ...filter }) }),
    movement: (filter) => request<MovementBridge>('/analytics/movement', { query: query({ ...filter }) }),
    trend: (filter) => request<AnalyticsTrend>('/analytics/trend', { query: query({ ...filter }) }),
    concentration: (filter) => request<AnalyticsConcentration>('/analytics/concentration', { query: query({ ...filter }) }),
    drivers: (filter) => request<AnalyticsDrivers>('/analytics/drivers', { query: query({ ...filter }) }),
    filters: (snapshotId) => request<PortfolioFilters>('/analytics/filters', { query: query({ snapshotId }) }),
    scenarios: (params) => request<AnalyticsScenarios>('/analytics/scenarios', { query: query({ ...params }) }),
    migration: (params) => request<AnalyticsMigration>('/analytics/migration', { query: query({ ...params }) }),
    runComparison: (params) => request<RunComparison>('/analytics/run-comparison', { query: query({ ...params }) }),
  },

  overrides: {
    async request(exposureId, input) {
      const body = await request<{ override: StageOverrideHistoryRecord }>(
        `/exposures/${encodeURIComponent(exposureId)}/stage-override`,
        { method: 'POST', body: input },
      );
      return body.override;
    },
    async review(overrideId, input) {
      const body = await request<{ override: StageOverrideHistoryRecord }>(
        `/stage-overrides/${encodeURIComponent(overrideId)}/review`,
        { method: 'POST', body: input },
      );
      return body.override;
    },
    queue: (params) => request<Paginated<StageOverrideListItem>>('/stage-overrides', { query: { ...params } }),
  },

  exceptions: {
    list: (params) => request<Paginated<ExceptionItemRecord>>('/exceptions', { query: { ...params } }),
    summary: () => request<ExceptionSummaryRecord>('/exceptions/summary'),
    async acknowledge(id, note) {
      const body = await request<{ exception: ExceptionItemRecord }>(
        `/exceptions/${encodeURIComponent(id)}/acknowledge`,
        { method: 'POST', body: { note } },
      );
      return body.exception;
    },
    async resolve(id, note) {
      const body = await request<{ exception: ExceptionItemRecord }>(`/exceptions/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        body: { note },
      });
      return body.exception;
    },
  },

  audit: {
    list: (params) => request<Paginated<AuditEventRecord>>('/audit-events', { query: { ...params } }),
  },

  ai: {
    status: () => request<AiStatusResponse>('/ai/status'),
    queryCopilot: (input) => request<CopilotQueryResponse>('/ai/copilot/query', { method: 'POST', body: input }),
    listThreads: (params) => request<CopilotThreadListResponse>('/ai/copilot/threads', { query: { ...params } }),
    getThread: (threadId) => request<CopilotThreadRecord>(`/ai/copilot/threads/${encodeURIComponent(threadId)}`),
    feedback: (threadId, turnId, input) =>
      request<CopilotFeedbackResponse>(
        `/ai/copilot/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/feedback`,
        { method: 'POST', body: input },
      ),
    explainEcl: (input) => request<AiResponse<EclExplanation>>('/ai/explain-ecl', { method: 'POST', body: input }),
    suggestImportMapping: (input) =>
      request<AiResponse<ImportMappingSuggestionSet>>('/ai/import-mapping', { method: 'POST', body: input }),
    investigateQuality: (input) =>
      request<AiResponse<DataQualityInvestigation>>('/ai/investigate-quality', { method: 'POST', body: input }),
    draftScenario: (input) =>
      request<AiResponse<ScenarioProposal>>('/ai/scenario-draft', { method: 'POST', body: input }),
    executiveCommentary: (input) =>
      request<AiResponse<ExecutiveCommentary>>('/ai/executive-commentary', { method: 'POST', body: input }),
  },

  demo: {
    reset: () => request<{ ok: true; durationMs: number }>('/demo/reset', { method: 'POST' }),
  },

  documents: {
    list: (params) => request<DocumentListResponse>('/documents', { query: { ...params } }),
    get: (id) => request<DocumentRecord>(`/documents/${encodeURIComponent(id)}`),
    upload(file, input) {
      const form = new FormData();
      form.append('file', file);
      // Text parts, not JSON: multer reads the non-file fields of a multipart
      // request, and every value arrives at the schema as a string.
      form.append('category', input.category);
      if (input.name) form.append('name', input.name);
      return request<DocumentUploadResponse>('/documents', { method: 'POST', body: form });
    },
    extract: (id, force = false) =>
      request<AiResponse<DocumentExtraction>>(`/documents/${encodeURIComponent(id)}/extract`, {
        method: 'POST',
        body: { force },
      }),
    async decideSignal(id, signalId, input) {
      return request<DocumentSignalRecord>(
        `/documents/${encodeURIComponent(id)}/signals/${encodeURIComponent(signalId)}/decision`,
        { method: 'POST', body: input },
      );
    },
    remove: (id) => request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
};
