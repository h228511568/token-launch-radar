// The token launch radar model (radar-2), written for the make.fun token-radar-01 entry.
//
// One sealed snapshot of the DefiLlama protocol index goes in; a ranked board of pre-token
// protocols comes out. The ranking multiple is not a constant anyone picked: it is calibrated
// from the snapshot itself, as the median market-cap / TVL ratio of the protocols in the same
// snapshot that already have a token. Category medians win when a category has enough live
// samples; the global median is the fallback. Wrapped, staked and bridged forms of someone
// else's asset are never ranked, for the same reason the snapshot's own watchlist skips them:
// their token already exists, so there is nothing to launch.
//
// Everything here is deterministic: no clock, no randomness, no network. The same snapshot
// always produces the same board, byte for byte.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  mcapUsd: number | null;
  listedAt: string | null;
  symbol: string | null;
}

export interface Snapshot {
  asOf: string;
  source: string;
  floorUsd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  multiple: number;
  multiple_source: string;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  implied_value_usd: number;
  farm_capital_usd: number;
  farm_hold_days: number;
  farm_score: number;
  farm_steps: string[];
  watchlist: boolean;
}

export interface LiveRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
  age_days: number;
}

export interface Calibration {
  global_multiple: number;
  live_sample_count: number;
  category_multiples: { category: string; multiple: number; samples: number }[];
}

export interface Board {
  as_of: string;
  source: string;
  model: string;
  rows: BoardRow[];
}

export interface Radar {
  board: Board;
  live: LiveRow[];
  calibration: Calibration;
  watchlist_total: number;
  pre_token_total: number;
  early_rows: number;
}

export const MODEL_VERSION = 'radar-2';

const DAY_MS = 86_400_000;

/** Parse and normalize the sealed snapshot; throws on anything malformed. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (typeof raw.as_of !== 'string' || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: expected as_of, protocols and watchlist');
  }
  const protocols: Protocol[] = raw.protocols.map((entry, i) => {
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error(`snapshot: protocol ${i} is missing slug, name or tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : 'Other',
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvlUsd: p.tvl_usd,
      change7d: typeof p.change_7d === 'number' ? p.change_7d : null,
      mcapUsd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
      listedAt: typeof p.listed_at === 'string' ? p.listed_at : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    asOf: raw.as_of,
    source: typeof raw.source === 'string' ? raw.source : 'DefiLlama protocol index',
    floorUsd: typeof raw.floor_usd === 'number' ? raw.floor_usd : 0,
    protocols,
    watchlist: raw.watchlist.filter((s): s is string => typeof s === 'string'),
  };
}

/** Whole days between a protocol's listing date and the snapshot date; 0 when unknown. */
export function ageDays(p: Protocol, asOf: string): number {
  if (p.listedAt === null) return 0;
  const listed = Date.parse(p.listedAt);
  const snap = Date.parse(asOf);
  if (Number.isNaN(listed) || Number.isNaN(snap) || snap < listed) return 0;
  return Math.floor((snap - listed) / DAY_MS);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const RATIO_MIN = 0.02;
const RATIO_MAX = 20;
const CATEGORY_MIN_SAMPLES = 4;

/**
 * Calibrate the implied-value multiple from the snapshot's own live-token protocols.
 * Ratios outside [0.02, 20] are data errors and meme outliers; they teach the model nothing.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcapUsd === null || p.tvlUsd <= 0) continue;
    const ratio = p.mcapUsd / p.tvlUsd;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
    all.push(ratio);
    const list = byCategory.get(p.category) ?? [];
    list.push(ratio);
    byCategory.set(p.category, list);
  }
  const categoryMultiples = [...byCategory.entries()]
    .filter(([, ratios]) => ratios.length >= CATEGORY_MIN_SAMPLES)
    .map(([category, ratios]) => ({ category, multiple: median(ratios), samples: ratios.length }))
    .sort((a, b) => a.category.localeCompare(b.category));
  return {
    global_multiple: all.length > 0 ? median(all) : 0,
    live_sample_count: all.length,
    category_multiples: categoryMultiples,
  };
}

const PRODUCT_FORM_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const PRODUCT_FORM_WORDS = /\b(wrapped|staked|staking)\b/i;

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name that is just another asset with a version tag, e.g. a v2 or 0-suffixed wrapper token. */
function hasVersionSuffix(name: string): boolean {
  return /\bv\d+$/i.test(name) || /\s\d+$/.test(name) === false && /[a-z]0$/i.test(name);
}

/**
 * True when the "protocol" is a product form of an asset that already has a token:
 * a bridge or staking wrapper, an exchange's own staked coin, a renamed re-issue.
 * The snapshot's watchlist is built on the same idea; the radar mirrors it so the
 * board never ranks a launch that already happened.
 */
export function isProductForm(p: Protocol): boolean {
  if (PRODUCT_FORM_CATEGORIES.has(p.category)) return true;
  if (PRODUCT_FORM_WORDS.test(p.name)) return true;
  if (EXCHANGE_PREFIXES.some((ex) => p.name === ex || p.name.startsWith(`${ex} `) || p.name.startsWith(`${ex}-`))) return true;
  if (hasVersionSuffix(p.name)) return true;
  return false;
}

const GROWTH_FLOOR = -0.6;
const GROWTH_CAP = 1.2;
const GROWTH_WEIGHT = 0.5;
const MATURITY_BASE = 0.6;
const MATURITY_SPAN = 0.4;
const MATURITY_FULL_DAYS = 1095;
const CHAIN_STEP = 0.03;
const CHAIN_MAX_EXTRA = 4;

export function growthMultiplier(change7d: number | null): number {
  if (change7d === null) return 1;
  const clamped = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, change7d));
  return 1 + GROWTH_WEIGHT * clamped;
}

export function maturityMultiplier(age: number): number {
  return MATURITY_BASE + (Math.min(age, MATURITY_FULL_DAYS) / MATURITY_FULL_DAYS) * MATURITY_SPAN;
}

export function chainMultiplier(chainCount: number): number {
  return 1 + CHAIN_STEP * Math.min(Math.max(chainCount - 1, 0), CHAIN_MAX_EXTRA);
}

/** Farm budget tiers: bigger, older protocols justify more capital and a longer hold. */
export function farmBudget(p: Protocol, age: number): { capital: number; holdDays: number } {
  const capital = p.tvlUsd >= 1_000_000_000 ? 150 : p.tvlUsd >= 250_000_000 ? 100 : p.tvlUsd >= 50_000_000 ? 50 : 25;
  const holdDays = age >= 540 ? 45 : age >= 180 ? 30 : 21;
  return { capital, holdDays };
}

/** The second, category-specific action in a farm plan: what a real user does after depositing. */
function secondActionFor(category: string, name: string, chain: string): string {
  switch (category) {
    case 'Lending':
      return `Borrow a small amount against the deposit on ${chain} and repay it a few days later, so the wallet shows a full borrow-and-repay cycle. Cost: about $4 of gas plus a few cents of interest. Time: 15 minutes.`;
    case 'Dexs':
    case 'Derivatives':
      return `Make two small swaps through ${name} on ${chain} on different days, in sizes a normal user would trade, not dust. Cost: about $5 of gas and slippage. Time: 15 minutes.`;
    case 'Bridge':
    case 'Canonical Bridge':
      return `Bridge a small amount back from ${chain} to the chain it came from, completing a round trip instead of a one-way visit. Cost: about $6 of gas and bridge fees. Time: 20 minutes.`;
    case 'Yield':
    case 'Yield Aggregator':
      return `Claim any harvested yield inside ${name} and re-deposit it once, so the position compounds the way a long-term user would run it. Cost: about $3 of gas. Time: 10 minutes.`;
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
      return `Split a second, smaller deposit into a different ${name} vault on ${chain}, so the wallet is not tied to a single strategy. Cost: the deposit amount plus about $5 of gas. Time: 15 minutes.`;
    case 'CDP':
      return `Mint a small amount of the stablecoin against the collateral on ${chain} and repay part of it a week later, showing both sides of the position. Cost: about $5 of gas. Time: 15 minutes.`;
    case 'Perps':
    case 'Options':
      return `Open and close one small position on ${name} with strict size limits, the way a cautious first-time trader would test it. Cost: about $5 of fees and slippage. Time: 20 minutes.`;
    default:
      return `Use the main ${name} feature on ${chain} a second time in a different week, in a normal size, so the wallet reads as a returning user. Cost: about $4 of gas. Time: 15 minutes.`;
  }
}

/**
 * A seven-step farm plan for one protocol, derived from its category, chains, size and age.
 * Every step names the action, what it costs and how long it takes; nothing here is financial
 * advice, it is the checklist a careful farmer would actually run before a launch.
 */
export function farmSteps(p: Protocol, capital: number, holdDays: number): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const chainNote = p.chains.length > 1 ? ` It also runs on ${p.chains[1]}, which is a fine second home for the same wallet.` : '';
  return [
    `Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `Deposit $${capital} into ${p.name} on ${chain} and keep the position open.${chainNote} Cost: $${capital} of capital and about $8 of gas. Time: 15 minutes to set up.`,
    `Repeat the main action once more on a later day on ${chain}, so the wallet shows a pattern of use rather than a single visit. Cost: about $3 of gas. Time: 10 minutes.`,
    secondActionFor(p.category, p.name, chain),
    `Make one qualifying action every week while you hold: a small deposit, a claim, or a repeat of the main action. Cost: a few dollars of gas each week. Time: 5 minutes a week.`,
    `Check the official ${p.name} site and its official channels for a points, waitlist or rewards program, and join it with the same wallet if one exists. Cost: free. Time: 10 minutes.`,
    `Hold the position for about ${holdDays} days, reviewing it once a month. If a token launches, claim with this same wallet first and decide about selling only after the claim is settled. Cost: the ${holdDays}-day hold itself. Time: 10 minutes a month.`,
  ];
}

function scoreRow(
  p: Protocol,
  snapshot: Snapshot,
  calibration: Calibration,
  watchlist: Set<string>,
): BoardRow {
  const age = ageDays(p, snapshot.asOf);
  const categoryMultiple = calibration.category_multiples.find((c) => c.category === p.category);
  const multiple = categoryMultiple ? categoryMultiple.multiple : calibration.global_multiple;
  const growth = growthMultiplier(p.change7d);
  const maturity = maturityMultiplier(age);
  const chains = chainMultiplier(p.chains.length);
  const implied = Math.round(p.tvlUsd * multiple * growth * maturity * chains);
  const { capital, holdDays } = farmBudget(p, age);
  return {
    rank: 0,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: Math.round(p.tvlUsd),
    change_7d: p.change7d,
    age_days: age,
    multiple,
    multiple_source: categoryMultiple ? `category median of ${categoryMultiple.samples}` : 'global median',
    growth_multiplier: growth,
    maturity_multiplier: maturity,
    chain_multiplier: chains,
    implied_value_usd: implied,
    farm_capital_usd: capital,
    farm_hold_days: holdDays,
    farm_score: Math.round(implied / (capital * holdDays)),
    farm_steps: farmSteps(p, capital, holdDays),
    watchlist: watchlist.has(p.slug),
  };
}

/** Build the full radar: the pre-token board, the live-token comparison set, the calibration. */
export function buildRadar(snapshot: Snapshot): Radar {
  const calibration = calibrate(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const rows: BoardRow[] = [];
  const live: LiveRow[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcapUsd !== null) {
      live.push({
        rank: 0,
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: Math.round(p.tvlUsd),
        mcap_usd: Math.round(p.mcapUsd),
        ratio: p.tvlUsd > 0 ? p.mcapUsd / p.tvlUsd : 0,
        change_7d: p.change7d,
        age_days: ageDays(p, snapshot.asOf),
      });
      continue;
    }
    if (isProductForm(p)) continue;
    rows.push(scoreRow(p, snapshot, calibration, watchlist));
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  live.sort((a, b) => b.mcap_usd - a.mcap_usd || a.slug.localeCompare(b.slug));
  live.forEach((row, i) => {
    row.rank = i + 1;
  });
  const board: Board = { as_of: snapshot.asOf, source: snapshot.source, model: MODEL_VERSION, rows };
  return {
    board,
    live,
    calibration,
    watchlist_total: snapshot.watchlist.length,
    pre_token_total: rows.length,
    early_rows: rows.filter((r) => !r.watchlist).length,
  };
}

/** Convenience for callers that only need the board half of the radar. */
export function buildBoard(snapshot: Snapshot): Board {
  return buildRadar(snapshot).board;
}

/** Null when the board is fit to ship; otherwise the reason it is not. Mirrors the gate's shape. */
export function boardIssue(board: Board, snapshot: Snapshot): string | null {
  const rows = board.rows;
  if (rows.length < 100 || rows.length > 4000) return `board has ${rows.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  const inSnapshot = new Set(snapshot.protocols.map((p) => p.slug));
  for (const [i, row] of rows.entries()) {
    if (row.rank !== i + 1) return `row ${row.slug}: rank ${row.rank} at position ${i + 1}`;
    if (slugs.has(row.slug)) return `duplicate slug ${row.slug}`;
    slugs.add(row.slug);
    if (!inSnapshot.has(row.slug)) return `slug ${row.slug} is not in the snapshot`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `row ${row.slug}: bad implied value`;
    if (i > 0 && rows[i - 1]!.implied_value_usd < row.implied_value_usd) return `implied value rises at rank ${row.rank}`;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug}: ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug}: a farm step is ${len} chars`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's dataset, as a script the static page can load with no network at all. */
export function dataScript(radar: Radar): string {
  const payload = {
    as_of: radar.board.as_of,
    source: radar.board.source,
    model: radar.board.model,
    calibration: {
      global_multiple: radar.calibration.global_multiple,
      live_sample_count: radar.calibration.live_sample_count,
      category_multiples: radar.calibration.category_multiples,
    },
    watchlist_total: radar.watchlist_total,
    pre_token_total: radar.pre_token_total,
    early_rows: radar.early_rows,
    rows: radar.board.rows,
    live: radar.live,
  };
  return `window.TOKEN_RADAR_DATA = ${JSON.stringify(payload)};\n`;
}
