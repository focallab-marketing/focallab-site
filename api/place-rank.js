// /api/place-rank.js
// Vercel Serverless Function — 네이버 지역검색 API를 호출해 "노출 진단" 데이터를 돌려줍니다.
//
// [환경변수] Vercel 대시보드 > Settings > Environment Variables 에 아래 두 개를 등록하세요.
//   NAVER_CLIENT_ID     = 네이버 개발자센터에서 발급받은 Client ID
//   NAVER_CLIENT_SECRET = 네이버 개발자센터에서 발급받은 Client Secret
// ※ Client Secret은 절대 프론트엔드(html/js)에 넣지 마세요. 여기(백엔드)에만 둡니다.
//
// [호출 방식] GET /api/place-rank?query=덕운동안경원
//   query 에는 매장명 또는 "지역명 안경원" 형태 둘 다 들어올 수 있습니다.

export default async function handler(req, res) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  // 프론트엔드가 다른 도메인에서 호출할 수도 있으니 CORS 허용 (같은 도메인이면 없어도 됨)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!clientId || !clientSecret) {
    res.status(500).json({ ok: false, error: 'NAVER API 키가 서버에 설정되지 않았습니다.' });
    return;
  }

  const rawQuery = (req.query.query || '').toString().trim();
  if (!rawQuery) {
    res.status(400).json({ ok: false, error: '매장명을 입력해주세요.' });
    return;
  }

  // 네이버 지역검색 API는 display 최대 5개가 상한입니다. (그 이상 요청해도 5개만 옴)
  const url = 'https://openapi.naver.com/v1/search/local.json'
    + '?query=' + encodeURIComponent(rawQuery)
    + '&display=5&sort=random';

  try {
    const naverRes = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    if (!naverRes.ok) {
      const body = await naverRes.text();
      res.status(502).json({ ok: false, error: '네이버 API 오류', detail: body });
      return;
    }

    const data = await naverRes.json();
    const items = Array.isArray(data.items) ? data.items : [];

    // 네이버가 돌려주는 title 에는 <b> 태그가 섞여 있어 제거합니다.
    const strip = (s) => (s || '').replace(/<[^>]*>/g, '').trim();

    // 상위 노출된 매장 리스트 (최대 5개)
    const top5 = items.map((it, idx) => ({
      pos: idx + 1,
      name: strip(it.title),
      category: strip(it.category),
      address: strip(it.roadAddress || it.address),
    }));

    // 입력한 매장명이 상위 5개 안에 있는지 매칭
    // 사용자가 "지역명 안경원"으로 넣으면 정확 매칭이 어려우므로,
    // 매장명 핵심 토큰(공백 제거 후 부분포함)으로 느슨하게 비교합니다.
    const norm = (s) => strip(s).replace(/\s+/g, '');
    const q = norm(rawQuery);

    let matchedPos = null;
    for (const t of top5) {
      const n = norm(t.name);
      if (n && (n.includes(q) || q.includes(n))) {
        matchedPos = t.pos;
        break;
      }
    }

    res.status(200).json({
      ok: true,
      query: rawQuery,
      exposed: matchedPos !== null,   // 상위 5개 안에 노출되는가
      position: matchedPos,           // 몇 번째인지 (1~5), 없으면 null
      totalFound: top5.length,        // 검색된 매장 수 (0~5)
      competitors: top5,              // 상위 노출 매장 목록 (경쟁사 보여주기용)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: '서버 오류', detail: String(err) });
  }
}
