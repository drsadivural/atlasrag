import { useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  Cpu,
  KeyRound,
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
import type { ModelConfiguration, WorkspaceSettings } from '@uxe/contracts';
import { ApiError, api } from '../lib/api.js';
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

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('settings.title')} className="lg:sticky lg:top-[calc(var(--uxe-header-height)+1.5rem)] lg:self-start">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {SECTIONS.map((entry) => (
              <li key={entry.key}>
                <NavLink
                  to={`/settings/${entry.key}`}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 whitespace-nowrap rounded-[var(--uxe-radius-control-lg)] px-3 py-2.5 text-[14px] font-medium transition-colors',
                      isActive
                        ? 'bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]'
                        : 'text-[var(--uxe-text-secondary)] hover:bg-[var(--uxe-surface-hover)]',
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
          ) : query.error ? (
            <ErrorState message={query.error.message} traceId={query.error.traceId} onRetry={() => void query.refetch()} />
          ) : query.data ? (
            section === 'models' ? (
              <ModelsSection models={query.data.models} canEdit={can('settings:models')} />
            ) : section === 'consultant' ? (
              <ConsultantSection settings={query.data.settings} canEdit={can('settings:update')} />
            ) : section === 'security' ? (
              <SecuritySection settings={query.data.settings} canEdit={can('settings:security')} />
            ) : section === 'retention' ? (
              <RetentionSection settings={query.data.settings} canEdit={can('settings:retention')} />
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
    <p className="mb-4 flex items-center gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-info-border)] bg-[var(--uxe-info-bg)] px-3 py-2.5 text-[13px] text-[var(--uxe-info)]">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      {t('common.permissionDeniedBody')}
    </p>
  );
}

function GeneralSection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const { preference, setPreference } = useTheme();
  const [name, setName] = useState(settings.general.workspaceName);
  const [timezone, setTimezone] = useState(settings.general.timezone);

  useEffect(() => {
    setName(settings.general.workspaceName);
    setTimezone(settings.general.timezone);
  }, [settings.general]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.general')}</CardTitle>
      </CardHeader>
      {!canEdit && <ReadOnlyNotice />}

      <div className="flex flex-col gap-4">
        <Field label="Workspace name" htmlFor="workspace-name">
          <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
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

        <Field label="Timezone" htmlFor="timezone" hint="Used for dates in reports and the activity log.">
          <Input id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit} />
        </Field>

        <div>
          <p className="mb-2 text-[13px] font-medium text-[var(--uxe-text)]">{t('settings.theme')}</p>
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

function ConsultantSection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useState(settings.consultant);
  const [answers, setAnswers] = useState(settings.answers);

  useEffect(() => {
    setForm(settings.consultant);
    setAnswers(settings.answers);
  }, [settings]);

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
            onChange={(e) => setAnswers({ ...answers, minimumEvidenceThreshold: Number(e.target.value) / 100 })}
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
        description: result.healthDetail ?? (result.health === 'healthy' ? 'Reachable and authorised.' : result.health),
      });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: ApiError) => push({ tone: 'error', title: 'Test failed', description: error.message }),
  });

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.models')}</CardTitle>
        </CardHeader>
        {!canEdit && <ReadOnlyNotice />}

        <p className="mb-4 text-[13px] text-[var(--uxe-text-secondary)]">
          The <strong>deterministic</strong> engine is always available and needs no credentials: it answers by
          selecting and quoting passages that were actually retrieved, so every sentence is verifiable.
          Configure a hosted provider to enable abstractive drafting; its output is still held to the same
          citation-verification gate.
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
                    {model.isPrimary && ' · primary'}
                    {model.isFallback && ' · fallback'}
                    {model.lastCheckedAt && ` · checked ${formatRelative(model.lastCheckedAt)}`}
                  </p>
                </div>
                <HealthBadge health={model.health} detail={model.healthDetail} />
                {model.hasCredential && (
                  <Badge tone="neutral" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden />}>
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

function HealthBadge({ health, detail }: { health: ModelConfiguration['health']; detail: string | null }) {
  const { t } = useI18n();
  const map = {
    healthy: { tone: 'success' as const, label: t('settings.providerHealthy'), Icon: CheckCircle2 },
    degraded: { tone: 'warning' as const, label: t('settings.providerDegraded'), Icon: AlertTriangle },
    unconfigured: { tone: 'neutral' as const, label: t('settings.providerUnconfigured'), Icon: XCircle },
    circuit_open: { tone: 'danger' as const, label: t('settings.providerCircuitOpen'), Icon: XCircle },
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

function AddModelCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [provider, setProvider] = useState('anthropic');
  const [capability, setCapability] = useState('chat');
  const [model, setModel] = useState('claude-sonnet-5');
  const [apiKey, setApiKey] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      api.post('/settings/models', {
        capability,
        provider,
        model,
        isPrimary: true,
        isFallback: false,
        enabled: true,
        apiKey: apiKey || null,
      }),
    onSuccess: () => {
      push({ tone: 'success', title: 'Provider saved', description: 'Run Test connection to verify it.' });
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
            onValueChange={setCapability}
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
              setModel(value === 'anthropic' ? 'claude-sonnet-5' : value === 'openai' ? 'gpt-4.1' : 'uxe-extractive-v1');
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

        <Field label="Model" htmlFor="model-name">
          <Input id="model-name" value={model} onChange={(e) => setModel(e.target.value)} />
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

      <Button variant="primary" className="mt-4 self-start" loading={save.isPending} onClick={() => save.mutate()}>
        {t('settings.save')}
      </Button>
    </Card>
  );
}

function SecuritySection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useState(settings.security);

  useEffect(() => setForm(settings.security), [settings.security]);

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
            onValueChange={(value) => setForm({ ...form, mfaPolicy: value as typeof form.mfaPolicy })}
            ariaLabel="MFA policy"
            disabled={!canEdit}
            className="w-full"
            options={[
              { value: 'optional', label: 'Optional', description: 'Users may enrol; enrolled users are always challenged.' },
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
          <Button variant="primary" className="self-start" loading={save.isPending} onClick={() => save.mutate({ security: form })}>
            {t('settings.save')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function RetentionSection({ settings, canEdit }: { settings: WorkspaceSettings; canEdit: boolean }) {
  const { t } = useI18n();
  const save = useSaveSettings();
  const [form, setForm] = useState(settings.retention);
  const [notifications, setNotifications] = useState(settings.notifications);

  useEffect(() => {
    setForm(settings.retention);
    setNotifications(settings.notifications);
  }, [settings]);

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
          <Button variant="primary" className="mt-4 self-start" loading={save.isPending} onClick={() => save.mutate({ retention: form })}>
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
          onCheckedChange={(checked) => setNotifications({ ...notifications, jobCompletion: checked })}
          disabled={!canEdit}
        />
        <SwitchField
          label="Critical findings"
          description="Email when a review produces a critical gap."
          checked={notifications.criticalFindings}
          onCheckedChange={(checked) => setNotifications({ ...notifications, criticalFindings: checked })}
          disabled={!canEdit}
        />
        <SwitchField
          label="Weekly digest"
          checked={notifications.weeklyDigest}
          onCheckedChange={(checked) => setNotifications({ ...notifications, weeklyDigest: checked })}
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
