import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../graph/pipeline';
import { runSingleAgent } from '../single/singleAgent';
import { env } from '../config/env';

type Mode = 'single' | 'multi';

type Row = {
  id: number;
  category: string;
  query: string;
};

function parseCsv(filePath: string): Row[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(',');
  const idxId = cols.indexOf('id');
  const idxCat = cols.indexOf('category');
  const idxQuery = cols.indexOf('query');
  return lines.map((line) => {
    // naive CSV split: our queries have no commas
    const parts = line.split(',');
    return {
      id: Number(parts[idxId]),
      category: String(parts[idxCat]),
      query: String(parts[idxQuery]),
    };
  });
}

function expectedIntent(category: string): string {
  // Map test categories to controller intent labels
  switch (category) {
    case 'order_status':
      return 'order_status';
    case 'billing_dispute':
      return 'billing_dispute';
    case 'product_recommendation':
      return 'product_recommendation';
    case 'return_policy':
      return 'return_policy';
    case 'refund_policy':
      return 'refund_policy';
    case 'warranty':
      return 'warranty';
    case 'shipping':
      return 'shipping';
    case 'account_issue':
      return 'account_issue';
    case 'multi_step':
      return 'multi_step';
    default:
      return 'general';
  }
}

function isPolicyCategory(cat: string): boolean {
  return (
    cat === 'return_policy' ||
    cat === 'refund_policy' ||
    cat === 'warranty' ||
    cat === 'shipping' ||
    cat === 'account_issue'
  );
}

function isDbCategory(cat: string): boolean {
  return (
    cat === 'order_status' ||
    cat === 'billing_dispute' ||
    cat === 'product_recommendation'
  );
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

async function runOne(mode: Mode, q: string) {
  const apiKey = process.env.EVAL_CHAT_KEY || env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing EVAL_CHAT_KEY or OPENAI_API_KEY for chat calls.');

  const input = {
    query: q,
    platform: 'openai' as const,
    model: process.env.EVAL_CHAT_MODEL || 'gpt-4o-mini',
    apiKey,
    mode,
  };
  return mode === 'single' ? runSingleAgent(input) : runPipeline(input);
}

async function main() {
  const filePath = path.join(process.cwd(), 'dataset', 'eval_queries.csv');
  if (!fs.existsSync(filePath)) throw new Error(`Missing: ${filePath}`);

  // Enable baseline evaluator scoring in single-agent runs
  process.env.ECMA_BASELINE_EVAL = '1';

  const rows = parseCsv(filePath);
  const modes: Mode[] = ['single', 'multi'];

  const results: Record<Mode, any[]> = { single: [], multi: [] };

  for (const mode of modes) {
    for (const r of rows) {
      const exp = expectedIntent(r.category);
      const out = await runOne(mode, r.query);
      results[mode].push({
        id: r.id,
        category: r.category,
        expected_intent: exp,
        intent: out.meta.intent,
        dataSource: out.meta.dataSource || 'none',
        evalScore: out.meta.evalScore,
        evalPassed: out.meta.evalPassed,
        refinementCount: out.meta.refinementCount,
        latencyMs: out.meta.latencyMs,
      });
      process.stdout.write('.');
    }
    process.stdout.write('\n');
  }

  function summarize(mode: Mode) {
    const rows = results[mode];
    const n = rows.length;
    const intentAcc =
      rows.filter((r) => String(r.intent) === String(r.expected_intent)).length / n;

    const routingCorrect = rows.filter((r) => {
      const cat = r.category as string;
      const src = String(r.dataSource || 'none');
      if (isPolicyCategory(cat)) return src === 'policy' || src === 'mixed';
      if (isDbCategory(cat)) return src === 'orders' || src === 'billing' || src === 'catalog' || src === 'mixed';
      if (cat === 'multi_step') return src === 'mixed' || src === 'orders' || src === 'billing' || src === 'policy' || src === 'catalog';
      return true;
    }).length / n;

    const dbHit = rows.filter((r) => {
      if (!isDbCategory(r.category)) return true;
      return String(r.dataSource) !== 'none';
    }).length / rows.filter((r) => isDbCategory(r.category)).length;

    const policyRows = rows.filter((r) => isPolicyCategory(r.category));
    const policyHit = policyRows.filter((r) => String(r.dataSource) === 'policy' || String(r.dataSource) === 'mixed').length / policyRows.length;

    const policyTop1 = policyRows
      .map((r) => Number(r.evalScore)) // proxy not used; keep NaN safe
      .filter((x) => Number.isFinite(x));

    const scores = rows.map((r) => Number(r.evalScore)).filter((x) => Number.isFinite(x));
    const compliance = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN;
    const success = rows.filter((r) => r.evalPassed === true).length / n;

    const lat = rows.map((r) => Number(r.latencyMs)).filter((x) => Number.isFinite(x)).map((ms) => ms / 1000);
    const p50 = percentile(lat, 50);
    const p95 = percentile(lat, 95);

    const avgLoops =
      mode === 'multi'
        ? rows.map((r) => Number(r.refinementCount)).filter((x) => Number.isFinite(x)).reduce((a, b) => a + b, 0) / n
        : NaN;

    return { intentAcc, routingCorrect, dbHit, policyHit, compliance, success, p50, p95, avgLoops };
  }

  const s = summarize('single');
  const m = summarize('multi');

  console.log(JSON.stringify({ single: s, multi: m }, null, 2));

  // Save raw results for paper appendix
  fs.writeFileSync(
    path.join(process.cwd(), 'dataset', 'eval_results.json'),
    JSON.stringify(results, null, 2),
    'utf-8'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

