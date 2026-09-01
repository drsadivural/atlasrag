/**
 * Re-runs one compliance review against the live database and prints the verdicts.
 *
 * A harness rather than a test: it reads real drawings and a real code, so it belongs
 * beside the deployment rather than in the suite. It exists because the class of defect it
 * catches — a figure on a drawing compared against a clause it has nothing to do with —
 * only shows up on documents of that size, and reads as a plausible finding until you look
 * up the clause.
 *
 * Usage: pnpm --filter @uxe/api exec tsx scripts/probe-review.mts \
 *          <consultationId> <organizationId> <workspaceId> <ownerUserId> [maxRequirements]
 */
import { buildApp } from '../src/app.js';
import { newId } from '@uxe/db';
import { runComplianceReview, type SourceScope } from '@uxe/rag';

const [consultationId, organizationId, workspaceId, userId] = process.argv.slice(2);
const maxRequirements = Number(process.argv[6] ?? 25);
if (!consultationId || !organizationId || !workspaceId || !userId) {
  console.error(
    'usage: probe-review.mts <consultationId> <organizationId> <workspaceId> <ownerUserId> [maxRequirements]',
  );
  process.exit(2);
}

const { deps } = buildApp();

const tenant = {
  organizationId,
  workspaceId,
  userId,
  role: 'owner' as const,
  groupIds: [],
  traceId: newId(),
};

const rows = await deps.repos.consultations.listSources(tenant, consultationId);
const scope: SourceScope[] = [];
for (const r of rows) {
  const source = await deps.repos.sources.getById(tenant, r.sourceId);
  const role = r.role === 'governing' && !source.promotedToKnowledge ? 'project' : r.role;
  scope.push({
    sourceId: r.sourceId,
    sourceVersionId: r.sourceVersionId,
    role: role as 'governing' | 'project',
    title: r.title,
    version: r.version,
    pages: r.pages,
    effectiveDate: r.effectiveDate,
    tags: source.tags,
    promoted: source.promotedToKnowledge,
    superseded: source.supersededBySourceId !== null,
  });
}

console.log('scope:');
for (const s of scope) console.log(`  ${s.role.padEnd(9)} ${s.title} (promoted=${s.promoted})`);

const started = Date.now();
const result = await runComplianceReview(
  tenant,
  { repo: deps.repos.retrieval, embedder: deps.services.embeddings, chat: deps.services.chat },
  scope,
  {
    task: 'check_compliance',
    answerStyle: 'details',
    knowledgeOnly: true,
    askWhenUncertain: true,
    generalModelFallback: false,
    minimumEvidenceThreshold: 0.5,
    consultantName: 'Ayumi',
    locale: 'en',
    idFactory: newId,
    nonce: newId(),
    maxRequirements,
    scopeNote: 'probe',
  },
);

console.log(`\n${Math.round((Date.now() - started) / 1000)}s · counts:`, result.counts);
console.log('\nassumptions:');
for (const a of result.answer.assumptions) console.log(`  - ${a}`);
console.log('\nfindings:');
for (const f of result.findings) {
  console.log(`  [${f.result}] ${f.requirementReference} — ${f.finding.slice(0, 160)}`);
}
process.exit(0);
