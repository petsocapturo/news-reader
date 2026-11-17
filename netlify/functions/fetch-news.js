// netlify/functions/fetch-news.js
// PANTAU — ambil berita dari Google News RSS
//
// v2 (Opsi A):
// - Deteksi halaman blokir Google ("We're sorry...") supaya tidak lagi
//   diam-diam mengembalikan daftar kosong
// - Batas waktu per percobaan + 1x retry, tetap di bawah batas 10 detik function
// - Cache di CDN Netlify (5 menit) supaya klik filter/refresh berulang
//   tidak selalu menembak Google
// - Data cadangan in-memory: kalau Google sedang memblokir, kirim hasil
//   terakhir yang berhasil untuk query yang sama (maks. 6 jam)

const UPSTREAM_TIMEOUT_MS = 5000;   // batas satu percobaan ke Google
const TOTAL_BUDGET_MS     = 8500;   // total waktu kerja, di bawah batas 10 detik Netlify
const RETRY_DELAY_MS      = 700;

const CDN_OK    = 'public, durable, max-age=300, stale-while-revalidate=900'; // 5 mnt segar, +15 mnt boleh basi sambil diperbarui
const CDN_EMPTY = 'public, durable, max-age=60';
const CDN_STALE = 'public, max-age=60';                                        // data cadangan: cepat dicoba ulang

const STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MEMO_MAX_ENTRIES = 60;

// Bertahan selama container function masih "hangat". Tidak dijamin ada,
// jadi hanya dipakai sebagai cadangan saat Google memblokir.
const memo = new Map(); // url -> { items, fetchedAt }

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PANTAU-RSS/1.0; +https://pantau-brief.netlify.app)',
  'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.7',
};

const ERROR_MESSAGES = {
  blocked: 'Google News sedang membatasi akses dari server PANTAU.',
  timeout: 'Google News tidak merespons tepat waktu.',
  invalid: 'Google News mengirim respons yang bukan RSS.',
  default: 'Gagal mengambil RSS dari Google News.',
};

exports.handler = async (event) => {
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const keyword  = event.queryStringParameters?.keyword  || 'pemerintah Indonesia';
  const sources  = event.queryStringParameters?.sources  || 'detik.com,kompas.com';
  const dateFrom = event.queryStringParameters?.dateFrom || ''; // YYYY-MM-DD (inclusive)
  const dateTo   = event.queryStringParameters?.dateTo   || ''; // YYYY-MM-DD (exclusive, sudah +1 hari dari client)

  // ── Site filter ────────────────────────────────────────────────────
  const siteList   = sources.split(',').map(s => s.trim()).filter(Boolean);
  const siteFilter = siteList.length > 0
    ? ' (' + siteList.map(s => `site:${s}`).join(' OR ') + ')'
    : '';

  // ── Date filter (operator pencarian Google News) ───────────────────
  // after:/before: bersifat eksklusif. Supaya dateFrom ikut, kirim sehari
  // sebelumnya. dateTo sudah +1 hari dari client.
  let dateFilter = '';
  if (dateFrom) {
    const d = new Date(dateFrom + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    dateFilter += ` after:${d.toISOString().split('T')[0]}`;
  }
  if (dateTo) dateFilter += ` before:${dateTo}`;

  const fullQuery = keyword + siteFilter + dateFilter;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}&hl=id&gl=ID&ceid=ID:id`;

  // ── 1. Coba ambil dari Google ──────────────────────────────────────
  const upstream = await fetchRss(url, deadline);

  if (upstream.ok) {
    try {
      const items     = parseItems(upstream.body, dateFrom, dateTo);
      const fetchedAt = new Date().toISOString();
      remember(url, items, fetchedAt);
      return respond(200, items, {
        cdn: items.length ? CDN_OK : CDN_EMPTY,
        fetchedAt,
        source: 'live',
      });
    } catch (err) {
      console.error('[fetch-news] parse error:', err.message);
      upstream.ok = false;
      upstream.reason = 'invalid';
    }
  }

  console.warn(`[fetch-news] upstream gagal (${upstream.reason}) untuk query: ${fullQuery}`);

  // ── 2. Google gagal → pakai hasil terakhir yang berhasil, kalau ada ─
  const cached = memo.get(url);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < STALE_MAX_AGE_MS) {
    return respond(200, cached.items, {
      cdn: CDN_STALE,
      fetchedAt: cached.fetchedAt,
      source: 'stale',
      reason: upstream.reason,
    });
  }

  // ── 3. Tidak ada cadangan → kirim error yang jelas (tidak di-cache) ─
  const status = upstream.reason === 'blocked' ? 503
               : upstream.reason === 'timeout' ? 504
               : 502;
  return respond(status, {
    error: upstream.reason,
    message: ERROR_MESSAGES[upstream.reason] || ERROR_MESSAGES.default,
  }, { reason: upstream.reason });
};

// ═══════════════════════════════════════════════════════════════════
// UPSTREAM
// ═══════════════════════════════════════════════════════════════════
async function fetchRss(url, deadline) {
  let reason = 'network';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(UPSTREAM_TIMEOUT_MS, remaining - 300));

    try {
      const res  = await fetch(url, { headers: REQUEST_HEADERS, signal: ctrl.signal, redirect: 'follow' });
      const body = await res.text();

      if (looksBlocked(res, body))       reason = 'blocked';
      else if (!res.ok)                  reason = `http_${res.status}`;
      else if (!looksLikeRss(body))      reason = 'invalid';
      else return { ok: true, body };
    } catch (err) {
      reason = err.name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }

    if (attempt === 1) await sleep(RETRY_DELAY_MS + Math.random() * 400);
  }

  return { ok: false, reason };
}

function looksBlocked(res, body) {
  if ([403, 429, 503].includes(res.status)) return true;
  if (res.url && res.url.includes('/sorry/')) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return head.includes('/sorry/')
      || head.includes('unusual traffic')
      || head.includes('automated queries');
}

function looksLikeRss(body) {
  return /<rss[\s>]/i.test(body) || /<channel[\s>]/i.test(body);
}

// ═══════════════════════════════════════════════════════════════════
// PARSING (logika sama dengan versi sebelumnya)
// ═══════════════════════════════════════════════════════════════════
function parseItems(xml, dateFrom, dateTo) {
  const fromTs = dateFrom ? ymdToTs(dateFrom) : null;
  const toTs   = dateTo   ? ymdToTs(dateTo)   : null; // eksklusif

  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const itemXml = match[1];

    const rawTitle =
      itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const title = cleanText(rawTitle);
    if (!title) continue;

    const link    = itemXml.match(/<link>(.*?)<\/link>/)?.[1]       || '';
    const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const source  = cleanText(itemXml.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '') || 'Google News';

    const rawDesc =
      itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
      itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
    const description = cleanText(rawDesc).substring(0, 400);

    // Penjaga tanggal di server (cadangan kalau operator Google tidak konsisten)
    if (fromTs !== null || toTs !== null) {
      const pubTs = pubDate ? new Date(pubDate).getTime() : null;
      if (pubTs) {
        if (fromTs !== null && pubTs < fromTs) continue;
        if (toTs   !== null && pubTs >= toTs)  continue;
      }
    }

    items.push({ title, link, pubDate, source, description });
  }
  return items;
}

function cleanText(raw) {
  const decode = s => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  let text = decode(raw);
  text = text.replace(/<[^>]+>/g, ' ');
  text = decode(text);
  return text.replace(/\s+/g, ' ').trim();
}

function ymdToTs(ymd) {
  return ymd ? new Date(ymd + 'T00:00:00Z').getTime() : null;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════
function remember(key, items, fetchedAt) {
  memo.delete(key);
  memo.set(key, { items, fetchedAt });
  while (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value);
}

function respond(statusCode, body, { cdn, fetchedAt, source, reason } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Pantau-Fetched-At, X-Pantau-Source, X-Pantau-Reason',
    // Browser selalu cek ulang; yang menyimpan cache adalah CDN Netlify
    'Cache-Control': cdn ? 'public, max-age=0, must-revalidate' : 'no-store',
    'Netlify-CDN-Cache-Control': cdn || 'no-store',
  };
  if (fetchedAt) headers['X-Pantau-Fetched-At'] = fetchedAt;
  if (source)    headers['X-Pantau-Source']     = source;
  if (reason)    headers['X-Pantau-Reason']     = reason;
  if (statusCode === 503) headers['Retry-After'] = '30';

  return { statusCode, headers, body: JSON.stringify(body) };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
