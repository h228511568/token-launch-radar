// The token launch radar model (radar-2), written for the make.fun token-radar-01 entry.
//
// One sealed snapshot of the DefiLlama protocol index goes in; a ranked board of pre-token
// protocols comes out. A protocol counts as pre-token only when the snapshot has no token
// on record for it at all: no market cap, no symbol, no CoinGecko id. Plenty of famous
// protocols carry a symbol but no priced market cap in the index; they launched already
// and are not farm targets, so the symbol check is the one that keeps the board honest.
//
// The ranking multiple is not a constant anyone picked: it is calibrated from the snapshot
// itself, as the median market-cap / TVL ratio of the live-token protocols in the same
// snapshot (exchange tokens excluded; their "TVL" is custodial reserves, not protocol
// value). A category's own median prices its rows when the category has at least four live
// samples; the global median is the fallback. Wrapped, staked and bridged forms of someone
// else's asset are never ranked, for the same reason the snapshot's own watchlist skips
// them: their token already exists, so there is nothing to launch.
//
// Everything here is deterministic: no clock, no randomness, no network. The same snapshot
// always produces the same board, byte for byte.

export interface Protocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvlUsd: number;
  /** Seven-day TVL change, in percent (the snapshot's own unit). */
  change7d: number | null;
  mcapUsd: number | null;
  listedAt: string | null;
  geckoId: string | null;
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
  watchlist: boolean;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  age_days: number | null;
  implied_value_usd: number;
  farm_score: number;
  model: {
    base_multiple: number;
    growth_pct: number | null;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {
  capital_usd: number;
  hold_days: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

export interface LiveRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
  age_days: number | null;
}

export interface Calibration {
  global_multiple: number;
  live_samples: number;
  multiples: Record<string, number>;
  category_samples: Record<string, number>;
}

export interface Board {
  as_of: string;
  source: string;
  model: string;
  rows: BoardRow[];
}

export interface Radar {
  board: Board;
  rows: RadarRow[];
  live: LiveRow[];
  calibration: Calibration;
  watchlist_size: number;
  early_size: number;
}

export const MODEL_VERSION = 'radar-2';
export const MODEL_FORMULA =
  'implied = TVL x base multiple (category median of live mcap/TVL, global median as fallback) ' +
  'x growth (7d TVL change, clamped, half weight) x maturity (age without a token) x chains';

const DAY_MS = 86_400_000;
const UNKNOWN_AGE_DAYS = 365;

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
      geckoId: typeof p.gecko_id === 'string' ? p.gecko_id : null,
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

/** Pre-token means no token on record at all: no market cap, no symbol, no CoinGecko id. */
export function isPreToken(p: Protocol): boolean {
  return p.mcapUsd === null && p.symbol === null && p.geckoId === null;
}

/** Whole days between listing and the snapshot date; null when the listing date is unknown. */
export function ageDays(p: Protocol, asOf: string): number | null {
  if (p.listedAt === null) return null;
  const listed = Date.parse(p.listedAt);
  const snap = Date.parse(asOf);
  if (Number.isNaN(listed) || Number.isNaN(snap) || snap < listed) return null;
  return Math.floor((snap - listed) / DAY_MS);
}

/** The age the model scores with: an unknown listing date counts as one year of history. */
export function effectiveAge(p: Protocol, asOf: string): number {
  return ageDays(p, asOf) ?? UNKNOWN_AGE_DAYS;
}

/** Multiples are quoted at four decimals, the precision the board publishes and scores with. */
function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
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
 * Ratios outside [0.02, 20] are data errors and meme outliers; exchange tokens are
 * excluded because an exchange's TVL is custodial reserves, not protocol value.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcapUsd === null || p.tvlUsd <= 0 || p.category === 'CEX') continue;
    const ratio = p.mcapUsd / p.tvlUsd;
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
    all.push(ratio);
    const list = byCategory.get(p.category) ?? [];
    list.push(ratio);
    byCategory.set(p.category, list);
  }
  const multiples: Record<string, number> = {};
  const categorySamples: Record<string, number> = {};
  for (const category of [...byCategory.keys()].sort()) {
    const ratios = byCategory.get(category)!;
    if (ratios.length >= CATEGORY_MIN_SAMPLES) {
      multiples[category] = round4(median(ratios));
      categorySamples[category] = ratios.length;
    }
  }
  return {
    global_multiple: all.length > 0 ? round4(median(all)) : 0,
    live_samples: all.length,
    multiples,
    category_samples: categorySamples,
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

/** A name that is just another asset with a version tag: a trailing v2, or a ticker ending in 0. */
function hasVersionSuffix(name: string): boolean {
  return /\bv\d+$/i.test(name) || /^[a-z]+0$/i.test(name);
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

const GROWTH_FLOOR_PCT = -60;
const GROWTH_CAP_PCT = 120;
const GROWTH_WEIGHT = 0.5;
const MATURITY_BASE = 0.6;
const MATURITY_SPAN = 0.4;
const MATURITY_FULL_DAYS = 1095;
const CHAIN_STEP = 0.03;
const CHAIN_MAX_EXTRA = 4;

/** The snapshot's change_7d is in percent; the model clamps it to [-60%, +120%] at half weight. */
export function growthMultiplier(changePct: number | null): number {
  if (changePct === null) return 1;
  const clamped = Math.min(GROWTH_CAP_PCT, Math.max(GROWTH_FLOOR_PCT, changePct)) / 100;
  return 1 + GROWTH_WEIGHT * clamped;
}

export function maturityMultiplier(age: number): number {
  return MATURITY_BASE + (Math.min(age, MATURITY_FULL_DAYS) / MATURITY_FULL_DAYS) * MATURITY_SPAN;
}

export function chainMultiplier(chainCount: number): number {
  return 1 + CHAIN_STEP * Math.min(Math.max(chainCount - 1, 0), CHAIN_MAX_EXTRA);
}

/**
 * Farm budget: bigger protocols justify more capital. The hold runs the other way from
 * intuition: a protocol that has already run a year without a token is closer to launch,
 * so the plan holds it for less time than a young one that needs a longer runway.
 */
export function farmBudget(tvlUsd: number, age: number): { capital: number; holdDays: number } {
  const capital = tvlUsd >= 1_000_000_000 ? 150 : tvlUsd >= 100_000_000 ? 100 : 50;
  const holdDays = age >= 365 ? 30 : age >= 180 ? 45 : 60;
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function scoreRow(
  p: Protocol,
  snapshot: Snapshot,
  calibration: Calibration,
  watchlist: Set<string>,
): RadarRow {
  const age = ageDays(p, snapshot.asOf);
  const effAge = effectiveAge(p, snapshot.asOf);
  const categoryMultiple = calibration.multiples[p.category];
  const baseMultiple = categoryMultiple ?? calibration.global_multiple;
  const growth = growthMultiplier(p.change7d);
  const maturity = maturityMultiplier(effAge);
  const chains = chainMultiplier(p.chains.length);
  const implied = Math.round(p.tvlUsd * baseMultiple * growth * maturity * chains);
  const { capital, holdDays } = farmBudget(p.tvlUsd, effAge);
  const model = {
    base_multiple: baseMultiple,
    growth_pct: p.change7d,
    growth_multiplier: growth,
    maturity_multiplier: maturity,
    chain_multiplier: chains,
    age_days: age,
  };
  return {
    rank: 0,
    slug: p.slug,
    watchlist: watchlist.has(p.slug),
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: Math.round(p.tvlUsd),
    change_7d: p.change7d,
    mcap_usd: null,
    listed_at: p.listedAt,
    gecko_id: p.geckoId,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: age,
    implied_value_usd: implied,
    farm_score: round2(implied / (capital * holdDays)),
    model,
    farm_steps: farmSteps(p, capital, holdDays),
    capital_usd: capital,
    hold_days: holdDays,
    base_multiple: baseMultiple,
    growth_multiplier: growth,
    maturity_multiplier: maturity,
    chain_multiplier: chains,
  };
}

function toBoardRow(r: RadarRow): BoardRow {
  return {
    rank: r.rank,
    slug: r.slug,
    watchlist: r.watchlist,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    mcap_usd: r.mcap_usd,
    listed_at: r.listed_at,
    gecko_id: r.gecko_id,
    symbol: r.symbol,
    token_status: r.token_status,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    farm_score: r.farm_score,
    model: r.model,
    farm_steps: r.farm_steps,
  };
}

/** Build the full radar: the pre-token board, the live-token comparison set, the calibration. */
export function buildRadar(snapshot: Snapshot): Radar {
  const calibration = calibrate(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const rows: RadarRow[] = [];
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
        change_7d: p.change7d,
        ratio: p.tvlUsd > 0 ? p.mcapUsd / p.tvlUsd : 0,
        age_days: ageDays(p, snapshot.asOf),
      });
      continue;
    }
    if (!isPreToken(p)) continue;
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
  const board: Board = {
    as_of: snapshot.asOf,
    source: snapshot.source,
    model: MODEL_VERSION,
    rows: rows.map(toBoardRow),
  };
  return {
    board,
    rows,
    live,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    early_size: rows.filter((r) => !r.watchlist).length,
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
    floor_usd: 50_000_000,
    model: MODEL_FORMULA,
    model_version: MODEL_VERSION,
    watchlist_size: radar.watchlist_size,
    board_size: radar.board.rows.length,
    early_size: radar.early_size,
    live_size: radar.live.length,
    global_multiple: radar.calibration.global_multiple,
    live_samples: radar.calibration.live_samples,
    multiples: radar.calibration.multiples,
    category_samples: radar.calibration.category_samples,
    rows: radar.rows,
    live: radar.live,
  };
  return `window.TOKEN_RADAR_DATA = ${JSON.stringify(payload)};\n`;
}
