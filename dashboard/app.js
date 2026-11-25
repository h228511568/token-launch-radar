'use strict';

// Token Radar dashboard: a static page over ../data.js. No network, no framework.
// State lives in the location hash so every view is a link: #p=<slug> opens a protocol,
// #category= / #chain= / #watch=1 / #live=1 / #sort=<key> describe the board.

const DATA = window.TOKEN_RADAR_DATA;
const state = { q: '', category: '', chain: '', watch: false, live: false, sort: 'rank', dir: 1 };

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(v) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function ageText(days) {
  if (days === null || days === undefined) return 'n/a';
  if (days >= 365) return `${(days / 365).toFixed(1)}y`;
  if (days >= 30) return `${Math.round(days / 30)}mo`;
  return `${days}d`;
}

function pct(p) {
  if (p === null || p === undefined) return '<span class="sub">n/a</span>';
  const cls = p >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${p >= 0 ? '+' : ''}${p.toFixed(2)}%</span>`;
}

function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  state.category = h.get('category') || '';
  state.chain = h.get('chain') || '';
  state.watch = h.get('watch') === '1';
  state.live = h.get('live') === '1';
  state.sort = h.get('sort') || 'rank';
  return h.get('p');
}

function writeHash(slug) {
  const h = new URLSearchParams();
  if (slug) h.set('p', slug);
  if (state.category) h.set('category', state.category);
  if (state.chain) h.set('chain', state.chain);
  if (state.watch) h.set('watch', '1');
  if (state.live) h.set('live', '1');
  if (state.sort !== 'rank') h.set('sort', state.sort);
  const s = h.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname);
}

function renderHeader() {
  $('#top').innerHTML = `
    <div>
      <div class="brand"><span class="dot"></span> Token Radar <span class="meta">Snapshot ${esc(DATA.as_of)} &nbsp; ${esc(DATA.source)} &nbsp; ${esc(DATA.model_version)} model</span></div>
      <h1>Every pre-token protocol, ranked by implied value</h1>
      <p class="lede">The watchlist is the floor: ${DATA.watchlist_size} protocols with at least $50M of TVL and no
      token on record. This radar scores all ${DATA.board_size} rankable pre-token protocols in the snapshot,
      early ones included, and sets the ${DATA.live.length} live-token protocols aside. Implied value is a model, not a promise.</p>
    </div>
    <div class="stats">
      <div class="row"><span>Watchlist covered</span><b>${DATA.watchlist_size} / ${DATA.watchlist_size}</b></div>
      <div class="row"><span>Pre-token rows scored</span><b>${DATA.board_size}</b></div>
      <div class="row"><span>Early rows below the floor</span><b>${DATA.early_size}</b></div>
      <div class="row"><span>Calibrated multiple (median of ${DATA.live_samples} live)</span><b>${DATA.global_multiple.toFixed(4)}x</b></div>
    </div>`;
}

function optionsFor(values, current, allLabel) {
  const opts = [`<option value="">${allLabel}</option>`];
  for (const v of values) opts.push(`<option ${v === current ? 'selected' : ''} value="${esc(v)}">${esc(v)}</option>`);
  return opts.join('');
}

function renderControls() {
  const cats = [...new Set(DATA.rows.map((r) => r.category))].sort();
  const chains = [...new Set(DATA.rows.flatMap((r) => r.chains))].sort();
  $('#controls').innerHTML = `
    <div class="field"><label for="q">Search</label>
      <input type="search" id="q" placeholder="Search name, category or chain" value="${esc(state.q)}"></div>
    <div class="field"><label for="cat">Category</label>
      <select id="cat">${optionsFor(cats, state.category, 'All categories')}</select></div>
    <div class="field"><label for="chain">Chain</label>
      <select id="chain">${optionsFor(chains, state.chain, 'All chains')}</select></div>
    <label class="check"><input type="checkbox" id="watch" ${state.watch ? 'checked' : ''}> Watchlist only</label>
    <div class="field"><label>Token status</label>
      <div class="toggle">
        <button id="tPre" class="${state.live ? '' : 'on'}">Pre-token</button>
        <button id="tLive" class="${state.live ? 'on' : ''}">Live token</button>
      </div></div>
    <div class="count" id="count"></div>`;
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('#cat').addEventListener('change', (e) => { state.category = e.target.value; writeHash(openSlug); renderBoard(); });
  $('#chain').addEventListener('change', (e) => { state.chain = e.target.value; writeHash(openSlug); renderBoard(); });
  $('#watch').addEventListener('change', (e) => { state.watch = e.target.checked; writeHash(openSlug); renderBoard(); });
  $('#tPre').addEventListener('click', () => { state.live = false; writeHash(openSlug); renderControls(); renderBoard(); });
  $('#tLive').addEventListener('click', () => { state.live = true; writeHash(openSlug); renderControls(); renderBoard(); });
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const src = state.live ? DATA.live : DATA.rows;
  return src.filter((r) => {
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.watch && !state.live && !r.watchlist) return false;
    if (q && !`${r.name} ${r.category} ${r.chains.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const SORTS = {
  rank: (a, b) => a.rank - b.rank,
  tvl: (a, b) => b.tvl_usd - a.tvl_usd,
  change: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
  age: (a, b) => b.age_days - a.age_days,
  multiple: (a, b) => (b.base_multiple ?? b.ratio) - (a.base_multiple ?? a.ratio),
  farm: (a, b) => (b.farm_score ?? 0) - (a.farm_score ?? 0),
  implied: (a, b) => (b.implied_value_usd ?? b.mcap_usd) - (a.implied_value_usd ?? a.mcap_usd),
};

function sortHead(key, label, cls) {
  const arrow = state.sort === key ? ' v' : '';
  return `<th class="${cls || ''}" data-sort="${key}">${label}${arrow}</th>`;
}

function renderBoard() {
  const rows = filtered().sort(SORTS[state.sort] || SORTS.rank);
  $('#count').textContent = `${rows.length} rows shown`;
  const maxImplied = Math.max(...DATA.rows.map((r) => r.implied_value_usd), 1);
  let html;
  if (state.live) {
    html = `<table><caption>Live-token protocols from the same snapshot, the set the multiple is calibrated from. Select a row for its numbers.</caption>
      <thead><tr>${sortHead('rank', 'Rank')}<th>Protocol</th>${sortHead('tvl', 'TVL', 'num')}${sortHead('implied', 'Market cap', 'num')}${sortHead('multiple', 'Mcap / TVL', 'num')}${sortHead('change', '7d', 'num')}${sortHead('age', 'Age', 'num')}<th>Token</th></tr></thead><tbody>`;
    for (const r of rows) {
      html += `<tr data-slug="${esc(r.slug)}"><td>${r.rank}</td>
        <td><span class="name">${esc(r.name)}</span><div class="sub">${esc(r.category)} on ${esc(r.chains.slice(0, 2).join(', '))}</div></td>
        <td class="num">${money(r.tvl_usd)}</td><td class="num">${money(r.mcap_usd)}</td>
        <td class="num">${r.ratio.toFixed(2)}x</td><td class="num">${pct(r.change_7d)}</td>
        <td class="num">${ageText(r.age_days)}</td><td class="token-yes">● has token</td></tr>`;
    }
  } else {
    html = `<table><caption>Pre-token protocols, strongest implied value first. WL marks a watchlist protocol. Farm eff. is implied value per dollar of farm capital per day held. Select a row for its model and farm plan.</caption>
      <thead><tr>${sortHead('rank', 'Rank')}<th>Protocol</th>${sortHead('tvl', 'TVL', 'num')}${sortHead('change', '7d', 'num')}${sortHead('age', 'Age', 'num')}${sortHead('multiple', 'Multiple', 'num')}${sortHead('farm', 'Farm eff.', 'num')}${sortHead('implied', 'Implied value', 'num')}<th>Token</th></tr></thead><tbody>`;
    for (const r of rows) {
      const w = Math.max(2, Math.round((r.implied_value_usd / maxImplied) * 100));
      html += `<tr data-slug="${esc(r.slug)}"><td>${r.rank}</td>
        <td><span class="name">${esc(r.name)}</span>${r.watchlist ? '<span class="wl">WL</span>' : ''}<div class="sub">${esc(r.category)} on ${esc(r.chains.slice(0, 2).join(', '))}</div></td>
        <td class="num">${money(r.tvl_usd)}</td><td class="num">${pct(r.change_7d)}</td>
        <td class="num">${ageText(r.age_days)}</td><td class="num">${r.base_multiple.toFixed(2)}x</td>
        <td class="num">${Math.round(r.farm_score).toLocaleString('en-US')}</td>
        <td class="num"><span class="bar"><i style="width:${w}%"></i></span>${money(r.implied_value_usd)}</td>
        <td class="token-no">● no token</td></tr>`;
    }
  }
  $('#board').innerHTML = `${html}</tbody></table>`;
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => { state.sort = th.dataset.sort; writeHash(openSlug); renderBoard(); });
  });
  document.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => openDrawer(tr.dataset.slug));
  });
}

let openSlug = null;

function stepHtml(step) {
  const at = step.indexOf(' Cost: ');
  if (at < 0) return `<span class="step">${esc(step)}</span>`;
  return `<span class="step">${esc(step.slice(0, at))}</span><span class="note">Cost: ${esc(step.slice(at + 7))}</span>`;
}

function openDrawer(slug) {
  const row = DATA.rows.find((r) => r.slug === slug) || DATA.live.find((r) => r.slug === slug);
  if (!row) return;
  openSlug = slug;
  writeHash(slug);
  const d = $('#drawer');
  if ('implied_value_usd' in row) {
    const check = Math.round(row.tvl_usd * row.base_multiple * row.growth_multiplier * row.maturity_multiplier * row.chain_multiplier);
    d.innerHTML = `
      <button class="close" id="close">Close</button>
      <div class="rank">Rank ${row.rank} of ${DATA.board_size}${row.watchlist ? ' · watchlist' : ''}</div>
      <h2>${esc(row.name)}</h2>
      <div class="sub">${esc(row.category)} on ${esc(row.chains.join(', '))}</div>
      <h3>Implied value</h3>
      <div class="kv"><span>TVL</span><b>${money(row.tvl_usd)}</b></div>
      <div class="kv"><span>Multiple (${esc(multipleSource(row))})</span><b>${row.base_multiple.toFixed(4)}x</b></div>
      <div class="kv"><span>Seven-day growth</span><b>${row.change_7d === null ? 'n/a' : `${row.change_7d.toFixed(2)}%`}</b></div>
      <div class="kv"><span>Age with no token</span><b>${row.age_days === null ? 'unknown (scored as 1y)' : ageText(row.age_days)}</b></div>
      <div class="kv"><span>Growth multiplier</span><b>${row.growth_multiplier.toFixed(3)}</b></div>
      <div class="kv"><span>Maturity multiplier</span><b>${row.maturity_multiplier.toFixed(4)}</b></div>
      <div class="kv"><span>Chain multiplier (${row.chains.length} chains)</span><b>${row.chain_multiplier.toFixed(2)}</b></div>
      <div class="kv"><span>Implied value</span><b>${money(row.implied_value_usd)}</b></div>
      <div class="kv"><span>Farm plan: capital / hold</span><b>$${row.capital_usd} / ${row.hold_days}d</b></div>
      <div class="kv"><span>Farm efficiency</span><b>${Math.round(row.farm_score).toLocaleString('en-US')} per $ per day</b></div>
      <p class="note">Model ${esc(DATA.model_version)}: the same function scores every protocol. The page recomputes
      this row as ${money(check)}, the same number board.json carries. This is an estimate, not a price.</p>
      <h3>Farm plan</h3>
      <ol>${row.farm_steps.map((s) => `<li>${stepHtml(s)}</li>`).join('')}</ol>`;
  } else {
    d.innerHTML = `
      <button class="close" id="close">Close</button>
      <div class="rank">Live token · rank ${row.rank} of ${DATA.live.length} by market cap</div>
      <h2>${esc(row.name)}</h2>
      <div class="sub">${esc(row.category)} on ${esc(row.chains.join(', '))}</div>
      <h3>Live numbers</h3>
      <div class="kv"><span>TVL</span><b>${money(row.tvl_usd)}</b></div>
      <div class="kv"><span>Market cap</span><b>${money(row.mcap_usd)}</b></div>
      <div class="kv"><span>Mcap / TVL</span><b>${row.ratio.toFixed(4)}x</b></div>
      <div class="kv"><span>Seven-day growth</span><b>${row.change_7d === null ? 'n/a' : `${row.change_7d.toFixed(2)}%`}</b></div>
      <div class="kv"><span>Age</span><b>${ageText(row.age_days)}</b></div>
      <p class="note">This protocol already has a token, so it is not on the radar board. It is part of the
      live set the radar's multiple is calibrated from.</p>`;
  }
  d.hidden = false;
  $('#scrim').hidden = false;
  $('#close').addEventListener('click', closeDrawer);
}

function closeDrawer() {
  openSlug = null;
  writeHash(null);
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

function multipleSource(row) {
  const own = DATA.multiples[row.category];
  if (own !== undefined && Math.abs(own - row.base_multiple) < 1e-12) {
    return `category median of ${DATA.category_samples[row.category]}`;
  }
  return `global median of ${DATA.live_samples}`;
}

function renderModel() {
  $('#model').innerHTML = `
    <h2>The model (${esc(DATA.model_version)})</h2>
    <p>The multiple is the market's own price for a dollar of TVL, measured on this snapshot: the median
    market-cap / TVL ratio across its ${DATA.live_samples} live-token protocols with a sane ratio
    (outliers beyond 0.02x-20x are dropped, exchange tokens excluded), <code>${DATA.global_multiple.toFixed(4)}x</code>. Where a category has at
    least four live samples, the category's own median prices its pre-token rows instead. Growth uses the
    7-day TVL change, clamped to -60%..+120% at half weight; maturity rewards protocols that have run
    longer without a token; breadth adds 3% per extra chain, up to four. Wrapped, staked and bridged
    forms of an existing asset are never ranked: their launch already happened.</p>
    <p><code>implied = TVL x multiple x growth x maturity x chains</code></p>
    <ul>${Object.entries(DATA.multiples).map(([cat, m]) => `<li>${esc(cat)}: ${m.toFixed(4)}x (${DATA.category_samples[cat]} live)</li>`).join('')}</ul>`;
}

const slugFromHash = readHash();
renderHeader();
renderControls();
renderBoard();
renderModel();
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
if (slugFromHash) openDrawer(slugFromHash);
