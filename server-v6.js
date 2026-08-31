/* ============================================================================
 * server.js (v6) — 포컬랩 진단 백엔드 (크롬 제거 · HTTP API 직접 호출)
 *
 *   GET /api/search?query=아이템안경원   → 후보 매장 목록
 *   GET /api/diagnose?query=지역키워드&store=매장명 → 진단
 *   GET /health
 *
 * v6 대전환:
 *   - Puppeteer(크롬) 완전 제거 → 좀비 크롬·메모리 폭발 문제 원천 소멸
 *   - 네이버 instant-search API를 순수 HTTPS 요청으로 직접 호출
 *     (map.naver.com/p/api/search/instant-search)
 *   - place 배열에 id·이름·좌표·주소·카테고리·리뷰수·예약여부 모두 포함
 *   - 초경량·초고속·차단위험 대폭 감소
 *   - Node 내장 https 모듈만 사용 (버전 무관 호환)
 * ========================================================================== */
const express = require('express');
const cors = require('cors');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));

const CACHE_TTL_MS = 48 * 60 * 60 * 1000;   // 진단 캐시 48시간
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;  // 검색 캐시 24시간
const TOP_N = 10;

const cache = new Map();
const searchCache = new Map();
const inflight = new Map();

/* 랜덤 대기 (요청 사이 간격 — 차단 방지) */
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 여러 모바일 UA 풀에서 랜덤 선택 */
const UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];
const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

/* ============ 네이버 instant-search API 호출 (순수 HTTPS) ============ */
function naverInstantSearch(query, coords) {
  return new Promise((resolve, reject) => {
    let path = '/p/api/search/instant-search?query=' + encodeURIComponent(query);
    if (coords) path += '&coords=' + encodeURIComponent(coords);
    const options = {
      hostname: 'map.naver.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': pickUA(),
        'Referer': 'https://map.naver.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('네이버 응답 ' + res.statusCode));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON 파싱 실패 (차단/구조변경 가능)'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.end();
  });
}

/* instant-search 응답의 place 항목 → 표준 형태로 변환 */
function normalize(p, rank) {
  return {
    rank,
    name: p.title || '',
    place_id: String(p.id || p.sid || ''),
    reviews: Number((p.review && p.review.count) || 0) || 0,
    category: p.ctg || '',
    address: p.roadAddress || p.jibunAddress || (p.shortAddress && p.shortAddress[0]) || '',
    lat: Number(p.y) || null,
    lng: Number(p.x) || null,
    hasBooking: !!p.hasBooking,
    dist: (typeof p.dist === 'number') ? p.dist : null,
  };
}

/* 안경 관련 업종/이름만 남기기 */
function isEyewear(s){
  const c = (s.category||'') + ' ' + (s.name||'');
  return /안경|렌즈|아이웨어|선글라스|콘택트|eyewear|optic/i.test(c);
}

/* 네이버 검색 → 매장 배열 (안경 필터 적용) */
async function fetchStores(query, coords) {
  const json = await naverInstantSearch(query, coords);
  const rawPlaces = (json && json.place) || [];
  const seen = new Set();
  const stores = [];
  rawPlaces.forEach((p) => {
    const id = String(p.id || p.sid || p.title || '');
    if (seen.has(id)) return;
    seen.add(id);
    stores.push(normalize(p, stores.length + 1));
  });
  return stores;
}

/* 스마트 검색: 검색어 변형 시도 (안경 결과 나올 때까지) */
function searchVariants(q){
  const base = q.trim();
  const out = [];
  const hasAngyeong = /안경|렌즈|아이웨어|선글라스/.test(base);
  out.push(hasAngyeong ? base : (base + ' 안경'));
  const t = base.replace(/(원|점)\s*$/,'').trim();
  const t2 = hasAngyeong ? t : (t + ' 안경');
  if (t2 && !out.includes(t2)) out.push(t2);
  if (!out.includes(base)) out.push(base);
  return out.filter(Boolean);
}

async function searchEyewear(query){
  const variants = searchVariants(query);
  for (let i = 0; i < variants.length; i++) {
    const stores = await fetchStores(variants[i]);
    const eye = stores.filter(isEyewear);
    if (eye.length) return { stores: eye, used: variants[i] };
    if (i < variants.length - 1) await sleep(rand(400, 900));
  }
  // 폴백: 필터 없이라도 결과 반환
  const stores = await fetchStores(query);
  return { stores, used: query };
}

/* 진단: 지역 검색으로 순위 + 매장별 정보 (전부 place 배열에 포함) */
async function crawlDiagnose(query, myStore, coords) {
  const stores = await fetchStores(query, coords);
  const ranking = stores.filter(isEyewear).length
    ? stores.filter(isEyewear).map((s, i) => ({ ...s, rank: i + 1 }))
    : stores;
  if (!ranking.length) throw new Error('순위 수집 실패 (차단/구조변경 가능)');

  const norm = (x) => String(x || '').replace(/\s/g, '');
  const me = myStore
    ? ranking.find((s) => norm(s.name).includes(norm(myStore)))
    : null;
  const myRank = me ? me.rank : null;

  // 내 매장 상세 (instant-search place에 이미 리뷰·예약·주소 다 있음)
  const myDetail = me ? {
    place_id: me.place_id,
    reviews: me.reviews,
    hasBooking: me.hasBooking,
    descLength: 0,   // 소개글 길이는 instant-search엔 없음 (심층진단 영역)
  } : null;

  return {
    query, myStore, myRank,
    totalInArea: ranking.length,
    topStores: ranking.slice(0, TOP_N),
    myDetail,
    collectedAt: new Date().toISOString(),
  };
}

/* ============ GET /api/search ============ */
app.get('/api/search', async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) return res.status(400).json({ success: false, error: 'query 필요' });
  const hit = searchCache.get(query);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    return res.json({ success: true, cached: true, candidates: hit.data });
  }
  const key = 'search::' + query;
  if (inflight.has(key)) {
    try { const data = await inflight.get(key);
      return res.json({ success: true, cached: false, candidates: data }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }
  const p = searchEyewear(query)
    .then(({ stores }) => {
      const candidates = stores.slice(0, 6).map((s) => ({
        name: s.name, place_id: s.place_id, category: s.category,
        address: s.address, reviews: s.reviews, lat: s.lat, lng: s.lng,
      }));
      if (candidates.length) searchCache.set(query, { data: candidates, at: Date.now() });
      return candidates;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  try {
    const data = await p;
    res.json({ success: true, cached: false, candidates: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ============ GET /api/diagnose ============ */
app.get('/api/diagnose', async (req, res) => {
  const query = (req.query.query || '').trim();
  const store = (req.query.store || '').trim();
  const coords = (req.query.coords || '').trim();  // 선택: "위도,경도"
  if (!query) return res.status(400).json({ success: false, error: 'query 필요' });
  const key = query + '::' + store;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, result: hit.data });
  }
  if (inflight.has(key)) {
    try { const data = await inflight.get(key);
      return res.json({ success: true, cached: false, result: data }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }
  const p = crawlDiagnose(query, store, coords)
    .then((data) => { cache.set(key, { data, at: Date.now() }); return data; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  try {
    const data = await p;
    res.json({ success: true, cached: false, result: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, version: 'v6', cacheSize: cache.size, searchCacheSize: searchCache.size }));

app.listen(PORT, () => { console.log('서버 실행 중 (v6 · 크롬 제거) - 포트 ' + PORT); });
