import { useEffect, useState } from 'react';
import { NavLink, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  Cpu,
  KeyRound,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  Palette,
  ShieldCheck,
  Trash2,
  UserCircle,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  LoadingRegion,
  SegmentedControl,
  Select,
  Skeleton,
  SwitchField,
  Textarea,
  cn,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type {
  AvailableModelsResponse,
  ConnectorProvider,
  ConnectorsResponse,
  ModelConfiguration,
  WorkspaceSettings,
} from '@uxe/contracts';
import { type ApiError, api, newIdempotencyKey } from '../lib/api.js';
import { useSyncedState } from '../lib/forms.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { useTheme } from '../lib/theme.js';
import { PageHeader } from '../components/PageHeader.js';
import { Ayumi } from '../components/Brand.js';

const SECTIONS = [
  { key: 'general', labelKey: 'settings.general', icon: Building2 },
  { key: 'consultant', labelKey: 'settings.consultant', icon: UserCircle },
  { key: 'models', labelKey: 'settings.models', icon: Cpu },
  { key: 'security', labelKey: 'settings.security', icon: ShieldCheck },
  { key: 'connectors', labelKey: 'settings.connectors', icon: Plug },
  { key: 'retention', labelKey: 'settings.retention', icon: Trash2 },
] as const;

interface SettingsResponse {
  settings: WorkspaceSettings;
  models: ModelConfiguration[];
}

export function SettingsPage() {
  const { section = 'general' } = useParams<{ section: string }>();
  const { t } = useI18n();
  const { can } = useSession();

  const query = useQuery<SettingsResponse, ApiError>({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/settings'),
  });

  return (
    <div className="mx-auto w-full max-w-[1200px] p-4 sm:p-6">
      <PageHeader title={t('settings.title')} />

      <div className="mt-5 flex flex-col gap-5">
        {/*
          Tabs, not a tablist. Each one is a route, so they stay links and NavLink marks
          the current one with aria-current; ARIA tabs would promise panel switching that
          a navigation does not do.
        */}
        <nav aria-label={t('settings.title')} className="border-b border-[var(--uxe-border)]">
          {/* Scrolls within itself on a narrow screen, so the page never scrolls sideways. */}
          <ul className="-mb-px flex gap-1 overflow-x-auto">
            {SECTIONS.map((entry) => (
              <li key={entry.key}>
                <NavLink
                  to={`/settings/${entry.key}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 border-b-2 px-3 py-2.5 text-[14px] font-medium whitespace-nowrap transition-colors',
                      // The underline carries the selection, so the label keeps its weight
                      // and the strip does not reflow as the current tab changes.
                      isActive
                        ? 'border-[var(--uxe-cobalt)] text-[var(--uxe-cobalt)]'
                        : 'border-transparent text-[var(--uxe-text-secondary)] hover:border-[var(--uxe-border-strong)] hover:text-[var(--uxe-text)]',
                    )
                  }
                >
                  <entry.icon className="h-4 w-4 shrink-0" aria-hidden />
                  {t(entry.labelKey)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {query.isLoading ? (
            <LoadingRegion label="Loading settings">
              <Skeleton className="h-64 w-full rounded-[var(--uxe-radius-card)]" />
            </LoadingRegion>
          ) : query.error && !query.data ? (
            <ErrorState
              message={query.error.message}
              traceId={query.error.traceId}
              onRetry={() => void query.refetch()}
            />
          ) : query.data ? (
            section === 'models' ? (
              <ModelsSection models={query.data.models} canEdit={can('settings:models')} />
            ) : section === 'consultant' ? (
              <ConsultantSection settings={query.data.settings} canEdit={can('settings:update')} />
            ) : section === 'security' ? (
              <SecuritySection settings={query.data.settings} canEdit={can('settings:security')} />
            ) : section === 'connectors' ? (
              <ConnectorsSection canEdit={can('settings:connectors')} />
            ) : section === 'retention' ? (
              <RetentionSection
                settings={query.data.settings}
                canEdit={can('settings:retention')}
              />
            ) : (
              <GeneralSection settings={query.data.settings} canEdit={can('settings:update')} />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function useSaveSettings() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { t } = useI18n();

  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/settings', patch),
    onSuccess: () => {
      push({ tone: 'success', title: t('settings.saved') });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not save', description: error.message }),
  });
}

/** Rendered instead of the form when the caller's role cannot change this section. */
function ReadOnlyNotice() {
  const { t } = useI18n();
  return (
    <p className="mb-4 flex items-center gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-info-border)] bg-[var(--uxe-info-bg)] px-3 py-2.5 text-[13px] text-[var(--uxe-info-text)]">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      {t('common.permissionDeniedBody')}
    </p>
  );
}

function GeneralSection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const { preference, setPreference } = useTheme();
  const [name, setName] = useSyncedState(settings.general.workspaceName);
  const [timezone, setTimezone] = useSyncedState(settings.general.timezone);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.general')}</CardTitle>
      </CardHeader>
      {!canEdit && <ReadOnlyNotice />}

      <div className="flex flex-col gap-4">
        <Field label="Workspace name" htmlFor="workspace-name">
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
          />
        </Field>

        <Field label="Locale" htmlFor="locale">
          <Select
            value={settings.general.locale}
            onValueChange={(value) => save.mutate({ general: { locale: value } })}
            ariaLabel="Locale"
            disabled={!canEdit}
            className="w-full"
            options={[
              { value: 'en', label: 'English' },
              { value: 'ja', label: '日本語 (Japanese)' },
            ]}
          />
        </Field>

        <Field
          label="Timezone"
          htmlFor="timezone"
          hint="Used for dates in reports and the activity log."
        >
          <Input
            id="timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!canEdit}
          />
        </Field>

        <div>
          <p className="mb-2 text-[13px] font-medium text-[var(--uxe-text)]">
            {t('settings.theme')}
          </p>
          <SegmentedControl
            value={preference}
            onValueChange={(value) => setPreference(value as 'light' | 'dark' | 'system')}
            ariaLabel={t('settings.theme')}
            options={[
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
              { value: 'system', label: t('settings.themeSystem') },
            ]}
          />
        </div>

        {canEdit && (
          <Button
            variant="primary"
            className="self-start"
            loading={save.isPending}
            onClick={() => save.mutate({ general: { workspaceName: name, timezone } })}
          >
            {t('settings.save')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ConsultantSection({
  settings,
  canEdit,
}: {
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useSyncedState(settings.consultant);
  const [answers, setAnswers] = useSyncedState(settings.answers);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.consultant')}</CardTitle>
        </CardHeader>
        {!canEdit && <ReadOnlyNotice />}

        <div className="flex items-start gap-5">
          <div className="hidden h-28 w-20 shrink-0 sm:block">
            <Ayumi variant="sm" decorative />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <Field label="Name" htmlFor="consultant-name">
              <Input
                id="consultant-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Title" htmlFor="consultant-title">
              <Input
                id="consultant-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Greeting" htmlFor="consultant-greeting">
              <Input
                id="consultant-greeting"
                value={form.greeting}
                onChange={(e) => setForm({ ...form, greeting: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
            <Field
              label="Behaviour notes"
              htmlFor="consultant-behavior"
              hint="Guidance applied to every answer. It cannot override the grounding or citation rules."
            >
              <Textarea
                id="consultant-behavior"
                rows={3}
                value={form.behaviorNotes}
                onChange={(e) => setForm({ ...form, behaviorNotes: e.target.value })}
                disabled={!canEdit}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Answer defaults</CardTitle>
        </CardHeader>

        <SwitchField
          label={t('consult.knowledgeOnly')}
          description="Answer only from approved sources."
          checked={answers.knowledgeOnly}
          onCheckedChange={(checked) => setAnswers({ ...answers, knowledgeOnly: checked })}
          disabled={!canEdit}
        />
        <SwitchField
          label={t('consult.askWhenUncertain')}
          description="Ask a precise follow-up rather than guessing when evidence is thin."
          checked={answers.askWhenUncertain}
          onCheckedChange={(checked) => setAnswers({ ...answers, askWhenUncertain: checked })}
          disabled={!canEdit}
        />
        <SwitchField
          label={t('consult.generalFallback')}
          description="Off by default. When on, any statement not drawn from your sources is labelled in the answer."
          checked={answers.generalModelFallback}
          onCheckedChange={(checked) => setAnswers({ ...answers, generalModelFallback: checked })}
          disabled={!canEdit}
        />
        <SwitchField
          label="Require citations"
          description="Refuse to present a material claim that has no verified citation."
          checked={answers.requireCitations}
          onCheckedChange={(checked) => setAnswers({ ...answers, requireCitations: checked })}
          disabled={!canEdit}
        />

        <Field
          label={`Minimum evidence threshold: ${Math.round(answers.minimumEvidenceThreshold * 100)}%`}
          htmlFor="evidence-threshold"
          hint="Below this coverage, Ayumi abstains and says so instead of answering."
          className="mt-3"
        >
          <input
            id="evidence-threshold"
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(answers.minimumEvidenceThreshold * 100)}
            onChange={(e) =>
              setAnswers({ ...answers, minimumEvidenceThreshold: Number(e.target.value) / 100 })
            }
            disabled={!canEdit}
            className="w-full accent-[var(--uxe-cobalt)]"
          />
        </Field>

        {canEdit && (
          <Button
            variant="primary"
            className="mt-4 self-start"
            loading={save.isPending}
            onClick={() => save.mutate({ consultant: form, answers })}
          >
            {t('settings.save')}
          </Button>
        )}
      </Card>
    </div>
  );
}

function ModelsSection({ models, canEdit }: { models: ModelConfiguration[]; canEdit: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const test = useMutation({
    mutationFn: (id: string) => api.post<ModelConfiguration>(`/settings/models/${id}/test`),
    onSuccess: (result) => {
      push({
        tone: result.health === 'healthy' ? 'success' : 'error',
        title: `${result.provider} ${result.model}`,
        description:
          result.healthDetail ??
          (result.health === 'healthy' ? 'Reachable and authorised.' : result.health),
      });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Test failed', description: error.message }),
  });

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.models')}</CardTitle>
        </CardHeader>
        {!canEdit && <ReadOnlyNotice />}

        <p className="mb-4 text-[13px] text-[var(--uxe-text-secondary)]">
          The <strong>deterministic</strong> engine is always available and needs no credentials: it
          answers by selecting and quoting passages that were actually retrieved, so every sentence
          is verifiable. Configure a hosted provider to enable abstractive drafting; its output is
          still held to the same citation-verification gate.
        </p>

        {models.length === 0 ? (
          <p className="text-[14px] text-[var(--uxe-text-secondary)]">
            No provider has been configured. The deterministic engine is in use.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {models.map((model) => (
              <li
                key={model.id}
                className="flex flex-wrap items-center gap-3 rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5"
              >
                <span
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]"
                >
                  <Cpu className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-[var(--uxe-text)]">
                    {model.provider} · {model.model}
                  </p>
                  <p className="text-[12px] text-[var(--uxe-text-secondary)]">
                    {model.capability}
                    {model.reasoningEffort && ` · ${model.reasoningEffort} effort`}
                    {model.isPrimary && ' · primary'}
                    {model.isFallback && ' · fallback'}
                    {model.lastCheckedAt && ` · checked ${formatRelative(model.lastCheckedAt)}`}
                  </p>
                </div>
                <HealthBadge health={model.health} detail={model.healthDetail} />
                {model.hasCredential && (
                  <Badge
                    tone="neutral"
                    size="sm"
                    icon={<KeyRound className="h-3 w-3" aria-hidden />}
                  >
                    Key saved
                  </Badge>
                )}
                {canEdit && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => test.mutate(model.id)}
                    loading={test.isPending && test.variables === model.id}
                  >
                    {t('settings.testConnection')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canEdit && <AddModelCard />}
    </div>
  );
}

function HealthBadge({
  health,
  detail,
}: {
  health: ModelConfiguration['health'];
  detail: string | null;
}) {
  const { t } = useI18n();
  const map = {
    healthy: { tone: 'success' as const, label: t('settings.providerHealthy'), Icon: CheckCircle2 },
    degraded: {
      tone: 'warning' as const,
      label: t('settings.providerDegraded'),
      Icon: AlertTriangle,
    },
    unconfigured: {
      tone: 'neutral' as const,
      label: t('settings.providerUnconfigured'),
      Icon: XCircle,
    },
    circuit_open: {
      tone: 'danger' as const,
      label: t('settings.providerCircuitOpen'),
      Icon: XCircle,
    },
    unknown: { tone: 'neutral' as const, label: 'Not tested', Icon: AlertTriangle },
  };
  const entry = map[health];

  return (
    <span title={detail ?? undefined}>
      <Badge tone={entry.tone} size="sm" icon={<entry.Icon className="h-3 w-3" aria-hidden />}>
        {entry.label}
      </Badge>
    </span>
  );
}

/** What this form starts with before anybody has chosen anything. */
const PLACEHOLDER_MODELS = new Set(['claude-sonnet-5', 'gpt-4.1', 'uxe-extractive-v1']);

function AddModelCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [provider, setProvider] = useState('anthropic');
  const [capability, setCapability] = useState('chat');
  const [model, setModel] = useState('claude-sonnet-5');
  /*
   * 'default' rather than an empty string: Radix refuses an item with an empty value, and
   * the distinction is real anyway — sending no reasoning_effort at all is what a model
   * without a reasoning mode needs, and is not the same as the provider's own 'none'.
   */
  const [reasoningEffort, setReasoningEffort] = useState('default');
  const [apiKey, setApiKey] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [available, setAvailable] = useState<AvailableModelsResponse['models']>([]);

  const load = useMutation({
    mutationFn: () =>
      api.post<AvailableModelsResponse>('/settings/models/available', {
        provider,
        capability,
        // A key typed here but not yet saved is still the key to ask with.
        ...(apiKey ? { apiKey } : {}),
      }),
    onSuccess: (result) => {
      setAvailable(result.models);
      if (result.models.length === 0) {
        push({
          tone: 'info',
          title: 'No models for this capability',
          description: 'This key serves none that match. Try another capability.',
        });
        return;
      }
      // Newest first. A value the user typed or picked is kept; one of this form's own
      // starting guesses is replaced, because those are placeholders rather than choices
      // and leaving one selected is how somebody ends up saving a model they never chose.
      const newest = result.models[0];
      if (newest) {
        setModel((current) =>
          PLACEHOLDER_MODELS.has(current) || !result.models.some((m) => m.id === current)
            ? newest.id
            : current,
        );
      }
      push({ tone: 'success', title: `${result.models.length} model(s) available` });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not read the model list', description: error.message }),
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/settings/models', {
        capability,
        provider,
        model,
        reasoningEffort: reasoningEffort === 'default' ? null : reasoningEffort,
        isPrimary: true,
        isFallback: false,
        enabled: true,
        apiKey: apiKey || null,
      }),
    onSuccess: () => {
      push({
        tone: 'success',
        title: 'Provider saved',
        description: 'Run Test connection to verify it.',
      });
      setApiKey('');
      setFieldErrors({});
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: ApiError) => {
      setFieldErrors(error.fieldErrors);
      push({ tone: 'error', title: 'Could not save provider', description: error.message });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add or update a provider</CardTitle>
      </CardHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Capability" htmlFor="capability">
          <Select
            value={capability}
            onValueChange={(value) => {
              setCapability(value);
              setAvailable([]);
            }}
            ariaLabel="Capability"
            className="w-full"
            options={[
              { value: 'chat', label: 'Chat / reasoning' },
              { value: 'embedding', label: 'Embeddings' },
              { value: 'rerank', label: 'Reranking' },
              { value: 'ocr', label: 'OCR / vision' },
              { value: 'document_generation', label: 'Document generation' },
            ]}
          />
        </Field>

        <Field label="Provider" htmlFor="provider">
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value);
              setAvailable([]);
              setReasoningEffort('default');
              setModel(
                value === 'anthropic'
                  ? 'claude-sonnet-5'
                  : value === 'openai'
                    ? 'gpt-4.1'
                    : 'uxe-extractive-v1',
              );
            }}
            ariaLabel="Provider"
            className="w-full"
            options={[
              { value: 'deterministic', label: 'Deterministic (local, extractive)' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'openai', label: 'OpenAI' },
            ]}
          />
        </Field>

        <Field
          label="Model"
          htmlFor="model-name"
          hint={
            available.length > 0
              ? `${available.length} model(s) offered by this key`
              : 'Load the list to choose from what this key can actually use.'
          }
        >
          {available.length > 0 ? (
            <Select
              value={model}
              onValueChange={setModel}
              ariaLabel="Model"
              className="w-full"
              options={available.map((entry) => ({ value: entry.id, label: entry.label }))}
            />
          ) : (
            <Input id="model-name" value={model} onChange={(e) => setModel(e.target.value)} />
          )}
        </Field>

        <Field
          label="Reasoning effort"
          htmlFor="reasoning-effort"
          hint={
            provider === 'openai'
              ? 'How hard a reasoning model thinks before answering. Leave on Model default unless the model has a reasoning mode — one that does not will reject the setting.'
              : 'Only OpenAI models take this setting.'
          }
        >
          <Select
            value={reasoningEffort}
            onValueChange={setReasoningEffort}
            ariaLabel="Reasoning effort"
            className="w-full"
            disabled={provider !== 'openai'}
            options={[
              { value: 'default', label: 'Model default' },
              { value: 'none', label: 'None' },
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'Extra high' },
            ]}
          />
        </Field>

        <Field
          label={t('settings.apiKey')}
          htmlFor="api-key"
          hint={t('settings.apiKeyHint')}
          error={fieldErrors.apiKey?.[0]}
        >
          <Input
            id="api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'deterministic' ? 'Not required' : 'sk-…'}
            disabled={provider === 'deterministic'}
            invalid={Boolean(fieldErrors.apiKey)}
            iconLeft={<KeyRound className="h-4 w-4" aria-hidden />}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          {t('settings.save')}
        </Button>

        {/*
          Ask the provider rather than guess.
          
          A list written into this file goes stale the week after it is written, and a
          typed identifier that does not exist fails at the first request with an error
          nobody can act on. This asks the account which models it will actually serve.
        */}
        {provider !== 'deterministic' && (
          <Button
            variant="secondary"
            loading={load.isPending}
            onClick={() => load.mutate()}
            disabled={load.isPending}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Load available models
          </Button>
        )}
      </div>
    </Card>
  );
}

function SecuritySection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useSyncedState(settings.security);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.security')}</CardTitle>
      </CardHeader>
      {!canEdit && <ReadOnlyNotice />}

      <div className="flex flex-col gap-4">
        <Field label="Two-factor authentication policy" htmlFor="mfa-policy">
          <Select
            value={form.mfaPolicy}
            onValueChange={(value) =>
              setForm({ ...form, mfaPolicy: value as typeof form.mfaPolicy })
            }
            ariaLabel="MFA policy"
            disabled={!canEdit}
            className="w-full"
            options={[
              {
                value: 'optional',
                label: 'Optional',
                description: 'Users may enrol; enrolled users are always challenged.',
              },
              { value: 'required_admins', label: 'Required for Admins and Owners' },
              { value: 'required_all', label: 'Required for everyone' },
            ]}
          />
        </Field>

        <Field label="Idle session timeout (minutes)" htmlFor="idle-minutes">
          <Input
            id="idle-minutes"
            type="number"
            min={5}
            max={1440}
            value={form.sessionIdleMinutes}
            onChange={(e) => setForm({ ...form, sessionIdleMinutes: Number(e.target.value) })}
            disabled={!canEdit}
          />
        </Field>

        <Field
          label="Absolute session lifetime (hours)"
          htmlFor="absolute-hours"
          hint="A session dies at this age no matter how active it is."
        >
          <Input
            id="absolute-hours"
            type="number"
            min={1}
            max={720}
            value={form.sessionAbsoluteHours}
            onChange={(e) => setForm({ ...form, sessionAbsoluteHours: Number(e.target.value) })}
            disabled={!canEdit}
          />
        </Field>

        <Field
          label="Allowed email domains"
          htmlFor="domains"
          hint="Comma separated. Leave empty to allow any invited address."
        >
          <Input
            id="domains"
            value={form.allowedEmailDomains.join(', ')}
            onChange={(e) =>
              setForm({
                ...form,
                allowedEmailDomains: e.target.value
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean),
              })
            }
            disabled={!canEdit}
            placeholder="example.com, partner.co"
          />
        </Field>

        {canEdit && (
          <Button
            variant="primary"
            className="self-start"
            loading={save.isPending}
            onClick={() => save.mutate({ security: form })}
          >
            {t('settings.save')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function RetentionSection({
  settings,
  canEdit,
}: {
  settings: WorkspaceSettings;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useSyncedState(settings.retention);
  const [notifications, setNotifications] = useSyncedState(settings.notifications);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.retention')}</CardTitle>
        </CardHeader>
        {!canEdit && <ReadOnlyNotice />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Consultations (days)" htmlFor="retain-consultations">
            <Input
              id="retain-consultations"
              type="number"
              min={1}
              value={form.consultationDays}
              onChange={(e) => setForm({ ...form, consultationDays: Number(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Artifacts (days)" htmlFor="retain-artifacts">
            <Input
              id="retain-artifacts"
              type="number"
              min={1}
              value={form.artifactDays}
              onChange={(e) => setForm({ ...form, artifactDays: Number(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Audit events (days)" htmlFor="retain-audit">
            <Input
              id="retain-audit"
              type="number"
              min={30}
              value={form.auditDays}
              onChange={(e) => setForm({ ...form, auditDays: Number(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
          <Field
            label="Purge grace period (days)"
            htmlFor="grace"
            hint="Deleted items stay recoverable, and their citations resolvable for audit, for this long."
          >
            <Input
              id="grace"
              type="number"
              min={0}
              value={form.purgeGraceDays}
              onChange={(e) => setForm({ ...form, purgeGraceDays: Number(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
        </div>

        <SwitchField
          className="mt-2"
          label="Legal hold"
          description="While on, nothing in this workspace is purged regardless of age."
          checked={form.legalHold}
          onCheckedChange={(checked) => setForm({ ...form, legalHold: checked })}
          disabled={!canEdit}
        />

        {canEdit && (
          <Button
            variant="primary"
            className="mt-4 self-start"
            loading={save.isPending}
            onClick={() => save.mutate({ retention: form })}
          >
            {t('settings.save')}
          </Button>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Bell className="h-4 w-4" aria-hidden />
              {t('settings.notifications')}
            </span>
          </CardTitle>
        </CardHeader>

        <SwitchField
          label="Job completion"
          description="Email when a review, report or corrected document finishes."
          checked={notifications.jobCompletion}
          onCheckedChange={(checked) =>
            setNotifications({ ...notifications, jobCompletion: checked })
          }
          disabled={!canEdit}
        />
        <SwitchField
          label="Critical findings"
          description="Email when a review produces a critical gap."
          checked={notifications.criticalFindings}
          onCheckedChange={(checked) =>
            setNotifications({ ...notifications, criticalFindings: checked })
          }
          disabled={!canEdit}
        />
        <SwitchField
          label="Weekly digest"
          checked={notifications.weeklyDigest}
          onCheckedChange={(checked) =>
            setNotifications({ ...notifications, weeklyDigest: checked })
          }
          disabled={!canEdit}
        />

        {canEdit && (
          <Button
            variant="primary"
            className="mt-4 self-start"
            loading={save.isPending}
            onClick={() => save.mutate({ notifications })}
          >
            {t('settings.save')}
          </Button>
        )}
      </Card>
    </div>
  );
}

export { Palette };

/* -------------------------------------------------------------------------- */
/* Connectors                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The file stores this workspace can attach.
 *
 * Three states, kept visibly distinct because each has a different person and a different
 * fix behind it: connected, ready to connect, and not set up for this deployment at all.
 * A single greyed-out button would tell an administrator none of that.
 */
function ConnectorsSection({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [pending, setPending] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const query = useQuery<ConnectorsResponse, ApiError>({
    queryKey: ['connectors'],
    queryFn: () => api.get<ConnectorsResponse>('/connectors'),
  });

  // The provider sends the browser back here with its answer in the URL. Reported once
  // and then cleared, so a refresh does not repeat a message about something already done.
  // In an effect rather than in render: it both shows a toast and rewrites the URL, and
  // neither belongs in the middle of producing markup.
  useEffect(() => {
    const outcome = searchParams.get('connector');
    if (!outcome) return;

    if (outcome === 'connected') {
      push({ title: t('connectors.connected'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
    } else if (outcome === 'cancelled') {
      push({ title: t('connectors.cancelled'), tone: 'info' });
    } else {
      push({
        title: t('connectors.failed'),
        description: t(reasonKey(searchParams.get('reason'))),
        tone: 'error',
      });
    }

    const next = new URLSearchParams(searchParams);
    next.delete('connector');
    next.delete('kind');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, push, queryClient, t]);

  const connect = useMutation({
    mutationFn: (kind: string) =>
      api.post<{ authorizeUrl: string }>(`/connectors/${kind}/authorize`, {
        returnTo: '/settings/connectors',
      }),
    onMutate: (kind: string) => setPending(kind),
    onSuccess: (result) => {
      // A full navigation, not a popup: the consent screen refuses to render in a frame,
      // and a blocked popup would look like a button that does nothing.
      window.location.assign(result.authorizeUrl);
    },
    onError: (error: ApiError) => {
      setPending(null);
      push({ title: t('connectors.connectFailed'), description: error.message, tone: 'error' });
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.delete(`/connectors/${id}`),
    onSuccess: () => {
      push({ title: t('connectors.disconnected'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
    onError: (error: ApiError) => push({ title: error.message, tone: 'error' }),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/connectors/${id}/sync`, {}, newIdempotencyKey()),
    onMutate: (id: string) => setSyncingId(id),
    onSettled: () => setSyncingId(null),
    onSuccess: () => {
      push({ title: t('connectors.syncStarted'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (error: ApiError) => push({ title: error.message, tone: 'error' }),
  });

  if (query.isLoading) {
    return (
      <LoadingRegion label={t('connectors.title')}>
        <Skeleton className="h-64 w-full rounded-[var(--uxe-radius-card)]" />
      </LoadingRegion>
    );
  }
  if (query.error) {
    return (
      <ErrorState
        message={query.error.message}
        traceId={query.error.traceId}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('connectors.title')}</CardTitle>
        </CardHeader>
        <p className="px-5 pb-5 text-[13px] text-[var(--uxe-text-secondary)]">
          {t('connectors.description')}
        </p>
      </Card>

      {(query.data?.providers ?? []).map((provider) => (
        <ConnectorCard
          key={provider.kind}
          provider={provider}
          canEdit={canEdit}
          busy={pending === provider.kind}
          syncing={syncingId === provider.connection?.id}
          onConnect={() => connect.mutate(provider.kind)}
          onDisconnect={(id) => disconnect.mutate(id)}
          onSync={(id) => sync.mutate(id)}
        />
      ))}
    </div>
  );
}

function ConnectorCard({
  provider,
  canEdit,
  busy,
  syncing,
  onConnect,
  onDisconnect,
  onSync,
}: {
  provider: ConnectorProvider;
  canEdit: boolean;
  busy: boolean;
  syncing: boolean;
  onConnect: () => void;
  onDisconnect: (id: string) => void;
  onSync: (id: string) => void;
}) {
  const { t } = useI18n();
  const connection = provider.connection;

  return (
    <Card>
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-[var(--uxe-text-secondary)]" aria-hidden />
            <h3 className="text-[15px] font-semibold text-[var(--uxe-text)]">{provider.label}</h3>
            {connection ? (
              <Badge
                tone={connection.status === 'error' ? 'danger' : 'success'}
                size="sm"
                icon={
                  connection.status === 'error' ? (
                    <XCircle className="h-3 w-3" aria-hidden />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" aria-hidden />
                  )
                }
              >
                {connection.status === 'error'
                  ? t('connectors.statusError')
                  : t('connectors.statusConnected')}
              </Badge>
            ) : provider.available ? (
              <Badge tone="neutral" size="sm">
                {t('connectors.statusNotConnected')}
              </Badge>
            ) : (
              <Badge
                tone="warning"
                size="sm"
                icon={<AlertTriangle className="h-3 w-3" aria-hidden />}
              >
                {t('connectors.statusNeedsSetup')}
              </Badge>
            )}
          </div>

          <p className="mt-1.5 text-[13px] text-[var(--uxe-text-secondary)]">
            {provider.description}
          </p>

          {connection && (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <div className="flex gap-1.5">
                <dt className="text-[var(--uxe-text-secondary)]">{t('connectors.account')}</dt>
                <dd className="font-medium text-[var(--uxe-text)]">
                  {connection.accountEmail ?? '—'}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-[var(--uxe-text-secondary)]">{t('connectors.lastSync')}</dt>
                <dd className="font-medium text-[var(--uxe-text)]">
                  {connection.lastSyncedAt
                    ? formatRelative(connection.lastSyncedAt)
                    : t('connectors.never')}
                </dd>
              </div>
            </dl>
          )}

          {connection?.lastError && (
            <p
              role="status"
              className="mt-3 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2 text-[13px] text-[var(--uxe-danger-text)]"
            >
              {connection.lastError}
            </p>
          )}

          {!provider.available && (
            <div className="mt-3 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface-sunken)] p-3 text-[13px]">
              {/* Named exactly, because the fix is an operator's and it is two variables
                  and one URL — not something to leave anybody guessing at. */}
              <p className="text-[var(--uxe-text-secondary)]">{t('connectors.setupHint')}</p>
              <ul className="mt-2 flex flex-col gap-1 font-mono text-[12px] text-[var(--uxe-text)]">
                {provider.requiredEnv.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <p className="mt-2 text-[var(--uxe-text-secondary)]">
                {t('connectors.redirectHint')}
              </p>
              <p className="mt-1 font-mono text-[12px] break-all text-[var(--uxe-text)]">
                {provider.redirectUri}
              </p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {connection ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canEdit || syncing}
                onClick={() => onSync(connection.id)}
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                {t('connectors.syncNow')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit}
                onClick={() => onDisconnect(connection.id)}
              >
                {t('connectors.disconnect')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={!canEdit || !provider.available || busy}
              onClick={onConnect}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t('connectors.connect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The provider's own reason, said in words the person reading it can act on. */
function reasonKey(reason: string | null) {
  if (reason === 'no_refresh_token') return 'connectors.reasonNoRefresh' as const;
  if (reason === 'expired') return 'connectors.reasonExpired' as const;
  if (reason === 'not_configured') return 'connectors.reasonNotConfigured' as const;
  return 'connectors.reasonGeneric' as const;
}
