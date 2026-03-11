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

  try {
    const response = await fetch(url);
    const xml = await response.text();

    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

    for (const match of itemMatches) {
      const itemXml = match[1];

      const title = (
        itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        itemXml.match(/<title>(.*?)<\/title>/)?.[1] || ''
      ).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const source = itemXml.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || 'Google News';

      const rawDesc =
        itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ||
        itemXml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
      const description = rawDesc.replace(/<[^>]+>/g, '').trim().substring(0, 400);

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
