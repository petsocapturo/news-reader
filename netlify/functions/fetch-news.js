exports.handler = async (event) => {
  const keyword  = event.queryStringParameters?.keyword  || 'pemerintah Indonesia';
  const sources  = event.queryStringParameters?.sources  || 'detik.com,kompas.com';
  const dateFrom = event.queryStringParameters?.dateFrom || ''; // YYYY-MM-DD (inclusive)
  const dateTo   = event.queryStringParameters?.dateTo   || ''; // YYYY-MM-DD (exclusive, already +1 day from client)

  // ── Site filter ────────────────────────────────────────────────────
  const siteList   = sources.split(',').map(s => s.trim()).filter(Boolean);
  const siteFilter = siteList.length > 0
    ? ' (' + siteList.map(s => `site:${s}`).join(' OR ') + ')'
    : '';

  // ── Date filter (Google News search operators) ─────────────────────
  // Google uses after:/before: (exclusive). To include dateFrom itself,
  // we pass the day before. dateTo is already +1 day from client, so
  // `before:dateTo` correctly excludes it.
  let dateFilter = '';
  if (dateFrom) {
    const d = new Date(dateFrom + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const dayBefore = d.toISOString().split('T')[0];
    dateFilter += ` after:${dayBefore}`;
  }
  if (dateTo) {
    dateFilter += ` before:${dateTo}`;
  }

  const fullQuery      = keyword + siteFilter + dateFilter;
  const encodedKeyword = encodeURIComponent(fullQuery);
  const url = `https://news.google.com/rss/search?q=${encodedKeyword}&hl=id&gl=ID&ceid=ID:id`;

  // ── Helpers ────────────────────────────────────────────────────────
  function cleanText(raw) {
    let text = raw
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  // Convert YYYY-MM-DD to midnight UTC timestamp
  function ymdToTs(ymd) {
    if (!ymd) return null;
    return new Date(ymd + 'T00:00:00Z').getTime();
  }

  try {
    const response = await fetch(url);
    const xml      = await response.text();

    const fromTs = dateFrom ? ymdToTs(dateFrom) : null;
    const toTs   = dateTo   ? ymdToTs(dateTo)   : null; // exclusive

    const items       = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const itemXml = match[1];

      const rawTitle =
        itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const title = cleanText(rawTitle);

      const link    = itemXml.match(/<link>(.*?)<\/link>/)?.[1]       || '';
      const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const source  = itemXml.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || 'Google News';

      const rawDesc =
        itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
        itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
      const description = cleanText(rawDesc).substring(0, 400);

      if (!title) continue;

      // ── Server-side date guard (backup for operator inconsistency) ──
      if (fromTs !== null || toTs !== null) {
        const pubTs = pubDate ? new Date(pubDate).getTime() : null;
        if (pubTs) {
          if (fromTs !== null && pubTs < fromTs) continue;
          if (toTs   !== null && pubTs >= toTs)  continue;
        }
      }

      items.push({ title, link, pubDate, source, description });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(items),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
