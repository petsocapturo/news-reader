exports.handler = async (event) => {
  const keyword = event.queryStringParameters?.keyword || 'pemerintah Indonesia';
  const sources = event.queryStringParameters?.sources || 'detik.com,kompas.com';

  // Build site filter: (site:detik.com OR site:kompas.com)
  const siteList = sources.split(',').map(s => s.trim()).filter(Boolean);
  const siteFilter = siteList.length > 0
    ? ' (' + siteList.map(s => `site:${s}`).join(' OR ') + ')'
    : '';

  const fullQuery = keyword + siteFilter;
  const encodedKeyword = encodeURIComponent(fullQuery);
  const url = `https://news.google.com/rss/search?q=${encodedKeyword}&hl=id&gl=ID&ceid=ID:id`;

  function cleanText(raw) {
    // 1. Decode HTML entities (termasuk yang sudah di-encode di dalam RSS)
    let text = raw
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    // 2. Strip semua tag HTML
    text = text.replace(/<[^>]+>/g, ' ');
    // 3. Decode entitas yang mungkin tersisa setelah tag dibuang
    text = text
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    // 4. Rapikan whitespace
    return text.replace(/\s+/g, ' ').trim();
  }

  try {
    const response = await fetch(url);
    const xml = await response.text();

    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const itemXml = match[1];

      const rawTitle =
        itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const title = cleanText(rawTitle);

      const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const source = itemXml.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || 'Google News';

      const rawDesc =
        itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
        itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
      const description = cleanText(rawDesc).substring(0, 400);

      if (title) items.push({ title, link, pubDate, source, description });
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
