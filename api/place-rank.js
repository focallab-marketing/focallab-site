// /api/place-rank.js
// 네이버 지역검색(Local Search) 오픈API를 호출해서
// 입력한 매장명이 검색 결과 상위 5개 중 몇 번째에 있는지 알려주는 서버리스 함수입니다.
//
// [사용 전 꼭 해야 할 것]
// 1) https://developers.naver.com 에서 애플리케이션 등록 후 Client ID / Secret 발급
// 2) Vercel 프로젝트 설정 > Environment Variables 에 아래 두 개 등록
//    NAVER_CLIENT_ID = 발급받은 Client ID
//    NAVER_CLIENT_SECRET = 발급받은 Client Secret
//    (코드에 직접 키를 적지 마세요. 깃허브 등에 올라가면 키가 노출됩니다.)
//
// [중요한 한계]
// 네이버 지역검색 API는 트래픽 문제로 display(출력 개수)를 최대 5개까지만 허용합니다.
// 즉 이 API로는 "상위 5위 안에 있는지, 있다면 몇 번째인지"만 알 수 있고,
// 6위 이하나 정확한 리뷰수는 이 API로 확인할 수 없습니다.

export default async function handler(req, res) {
  const { query } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'query 파라미터(매장명)가 필요합니다.' });
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 설정되지 않았습니다.'
    });
  }

  try {
    const apiUrl =
      'https://openapi.naver.com/v1/search/local.json' +
      '?query=' + encodeURIComponent(query) +
      '&display=5' +
      '&sort=random';

    const naverRes = await fetch(apiUrl, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      }
    });

    if (!naverRes.ok) {
      const text = await naverRes.text();
      throw new Error('네이버 API 요청 실패 (' + naverRes.status + '): ' + text);
    }

    const data = await naverRes.json();
    const items = data.items || [];

    // 응답 title에는 <b></b> 태그가 섞여 있어서 제거 후 비교합니다.
    const stripTags = (s) => s.replace(/<[^>]+>/g, '');
    const cleanQuery = query.replace(/\s/g, '');

    let rank = null;
    const cleanItems = items.map((item, idx) => {
      const title = stripTags(item.title);
      const titleNoSpace = title.replace(/\s/g, '');
      if (rank === null && titleNoSpace.includes(cleanQuery)) {
        rank = idx + 1;
      }
      return {
        title,
        category: item.category,
        address: item.roadAddress || item.address,
        telephone: item.telephone || null
      };
    });

    return res.status(200).json({
      query,
      rank,            // 1~5 중 하나, 못 찾으면 null (=5위 밖 또는 상호명 불일치)
      checkedTop: items.length,
      items: cleanItems
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
