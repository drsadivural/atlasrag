/**
 * Retrieval accuracy against a real indexed corpus.
 *
 *   pnpm accuracy                       # 120 passages of the default document
 *   SAMPLE=300 DOC='uae_code_en' pnpm accuracy
 *
 * Reads whatever `DATABASE_URL` points at, and changes nothing.
 *
 * The gold set is drawn from the index itself: a passage is sampled, a query is built from
 * it, and retrieval is asked to find it again. No hand labelling, and nothing invented —
 * the right answer is the passage the query came from.
 *
 * Two numbers, because they answer different questions. `chunk` is whether that exact
 * passage came back, which is what a ranking change moves. `content` is whether ANY
 * returned passage contains the phrase the query was drawn from, which is what actually
 * decides whether an answer can be grounded — a code repeats boilerplate, and finding the
 * same sentence under a different clause is a hit for grounding and a miss for ranking.
 */
import { createDb, RetrievalRepository, type TenantContext } from '../packages/db/src/index.js';
import {
  DeterministicEmbeddingProvider,
  retrieve,
  type SourceScope,
} from '../packages/rag/src/index.js';

const K = Number(process.env.K ?? 10);
const SAMPLE = Number(process.env.SAMPLE ?? 120);
const SEED = Number(process.env.SEED ?? 7);
const DOC = process.env.DOC ?? 'uae_code_en';

/** Deterministic PRNG so a rerun measures the same questions. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const STOP = new Set(
  'the a an and or of to in for on at by with be is are was were shall must may not this that these those as it its from any all each such other which where when who whom whose than then there their'.split(
    ' ',
  ),
);

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.;:])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 220);
}

function keywords(text: string, n = 6): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    if (STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
    if (words.length >= n) break;
  }
  return words.join(' ');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const handle = createDb({ url });
  const repo = new RetrievalRepository(handle.db);
  const embedder = new DeterministicEmbeddingProvider();

  const versions = (await handle.db.execute(
    `SELECT c.source_version_id, c.source_id, c.workspace_id, s.organization_id, s.title,
            count(*)::int AS chunks
       FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE s.title = '${DOC.replace(/'/g, "''")}'
      GROUP BY 1,2,3,4,5 ORDER BY chunks DESC LIMIT 1`,
  )) as unknown as Array<Record<string, string | number>>;
  const target = versions[0];
  if (!target) throw new Error(`No indexed chunks for "${DOC}"`);
  console.log(`corpus: ${target.title} — ${target.chunks} chunks`);

  const ctx: TenantContext = {
    organizationId: String(target.organization_id),
    workspaceId: String(target.workspace_id),
    userId: 'eval',
    role: 'owner',
    groupIds: [],
    traceId: 'eval',
  };
  const scope: SourceScope[] = [
    {
      sourceId: String(target.source_id),
      sourceVersionId: String(target.source_version_id),
      role: 'governing',
      title: String(target.title),
      version: 'v1',
      pages: null,
      effectiveDate: null,
      tags: [],
      promoted: true,
      superseded: false,
    },
  ];

  const pool = (await handle.db.execute(
    `SELECT id, content, clause FROM source_chunks
      WHERE source_version_id = '${String(target.source_version_id)}'
        AND length(content) BETWEEN 200 AND 2000
      ORDER BY ordinal`,
  )) as unknown as Array<{ id: string; content: string; clause: string | null }>;
  console.log(`usable passages: ${pool.length}`);

  const next = rng(SEED);
  const picked: typeof pool = [];
  const takenIds = new Set<string>();
  while (picked.length < SAMPLE && takenIds.size < pool.length) {
    const row = pool[Math.floor(next() * pool.length)];
    if (!row || takenIds.has(row.id)) continue;
    if (sentences(row.content).length === 0) {
      takenIds.add(row.id);
      continue;
    }
    takenIds.add(row.id);
    picked.push(row);
  }

  type Kind = 'sentence' | 'keywords' | 'clause';
  const results: Array<{
    kind: Kind;
    rank: number;
    contentRank: number;
    clauseRank: number;
    query: string;
    id: string;
  }> = [];

  for (const row of picked) {
    const sentence = sentences(row.content)[0]!;
    const cases: Array<[Kind, string, string]> = [
      ['sentence', sentence, sentence],
      ['keywords', keywords(row.content), sentence],
    ];
    if (row.clause) cases.push(['clause', `clause ${row.clause}`, sentence]);

    for (const [kind, query, phrase] of cases) {
      if (!query.trim()) continue;
      /*
       * The settings the answering path actually uses. `maxPerSource` defaults to 4, which
       * on a single-document corpus caps the whole result at four candidates and makes
       * R@10 unmeasurable; the compliance path passes 12.
       */
      const outcome = await retrieve(ctx, repo, embedder, query, scope, {
        finalLimit: K,
        channelLimit: 60,
        maxPerSource: K,
      });
      const rank = outcome.candidates.findIndex((c) => c.chunkId === row.id);
      // Both sides collapsed the same way: the sampled sentence has already had its
      // newlines squeezed to spaces, and the stored content has not. Comparing the two raw
      // reported a miss for a passage that had in fact been returned.
      const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ');
      const needle = flat(phrase).slice(0, 120);
      const contentRank = outcome.candidates.findIndex((c) => flat(c.content).includes(needle));
      /*
       * For a clause lookup the right answer is not one particular passage. A clause number
       * is shared by up to 35 chunks in this code, so any chunk carrying the number asked
       * for is a correct result — and that, not chunk identity, is what somebody typing
       * "clause 2.2.5" needs back.
       */
      const clauseRank =
        kind === 'clause' && row.clause
          ? outcome.candidates.findIndex((c) => c.clause === row.clause)
          : rank;
      results.push({ kind, rank, contentRank, clauseRank, query, id: row.id });
    }
  }

  const report = (
    label: string,
    subset: typeof results,
    field: 'rank' | 'contentRank' | 'clauseRank',
  ) => {
    if (subset.length === 0) return;
    const at = (n: number) =>
      subset.filter((r) => r[field] >= 0 && r[field] < n).length / subset.length;
    const mrr =
      subset.reduce((sum, r) => sum + (r[field] >= 0 ? 1 / (r[field] + 1) : 0), 0) / subset.length;
    console.log(
      `${label.padEnd(22)} n=${String(subset.length).padStart(4)}  ` +
        `R@1 ${(at(1) * 100).toFixed(1).padStart(5)}%  ` +
        `R@5 ${(at(5) * 100).toFixed(1).padStart(5)}%  ` +
        `R@${K} ${(at(K) * 100).toFixed(1).padStart(5)}%  ` +
        `MRR ${mrr.toFixed(3)}`,
    );
  };

  console.log(`\n--- exact passage (ranking) ---`);
  for (const kind of ['sentence', 'keywords', 'clause'] as const) {
    report(
      kind,
      results.filter((r) => r.kind === kind),
      'rank',
    );
  }
  report('ALL', results, 'rank');

  console.log(`\n--- answerable (the passage asked for, or one carrying the clause) ---`);
  for (const kind of ['sentence', 'keywords', 'clause'] as const) {
    report(
      kind,
      results.filter((r) => r.kind === kind),
      'clauseRank',
    );
  }
  report('ALL', results, 'clauseRank');

  console.log(`\n--- phrase present (grounding) ---`);
  for (const kind of ['sentence', 'keywords', 'clause'] as const) {
    report(
      kind,
      results.filter((r) => r.kind === kind),
      'contentRank',
    );
  }
  report('ALL', results, 'contentRank');

  const worst = results.filter((r) => r.rank === -1).slice(0, 8);
  if (worst.length > 0) {
    console.log(`\n--- misses (first ${worst.length}) ---`);
    for (const r of worst) console.log(`  [${r.kind}] ${r.query.slice(0, 100)}`);
  }

  await handle.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
