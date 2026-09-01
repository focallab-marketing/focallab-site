/* ============================================================================
 * server.js (v7) — 포컬랩 진단 백엔드 (좌표기반 1km 경쟁 진단)
 *
 *   GET /api/search?query=아이템안경원                          → 후보 매장 목록
 *   GET /api/diagnose?coords=위도,경도&store=매장명&place_id=…  → 진단 (1km 경쟁)
 *   GET /health
 *
 * v7 핵심 변경 (경쟁 진단 정확도):
 *   - 진단 시 "상호명"이 아니라 "안경원" 일반 키워드 + 매장 좌표로 검색
 *     → 그 좌표 주변의 실제 다른 안경원들이 나온다 (동일상호 다른지점 문제 해결)
 *   - 반경 1km 필터 (RADIUS_KM) → 진짜 경쟁권만 남김
 *   - 내 매장은 place_id로 정확 매칭 (없으면 최근접=중심 매장으로 폴백)
 *   - 네이버 노출 순서 = 지역 검색 순위로 rank 재부여
 *   - 표시용 지역 라벨(동/구)을 주소에서 추출해 result.query로 반환
 *
 * v6 기반 유지:
 *   - Puppeteer(크롬) 없음. 네이버 instant-search를 순수 HTTPS로 호출.
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
const RADIUS_KM = 1.0;                      // 경쟁 반경 (1km 고정)
const MIN_STORES = 5;                       // 1km 내가 적으면 가까운 순으로 최소 이만큼 채움

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
/* coords는 필수. 없으면 기본 좌표(서울시청)를 사용 — 좌표는 거리 계산·주변
   검색 기준이 된다. */
const DEFAULT_COORDS = '37.5666103,126.9783882';  // 서울시청

function naverInstantSearch(query, coords) {
  return new Promise((resolve, reject) => {
    const co = coords || DEFAULT_COORDS;
    let path = '/p/api/search/instant-search?query=' + encodeURIComponent(query) +
               '&coords=' + encodeURIComponent(co);
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

/* 두 좌표 사이 거리(km) — Haversine. 네이버 dist가 없을 때 백업용 */
function haversineKm(lat1, lng1, lat2, lng2){
  if ([lat1, lng1, lat2, lng2].some(v => v == null || isNaN(v))) return null;
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* 주소에서 표시용 지역 라벨(동 > 읍/면 > 구/군) 추출 */
function areaLabel(addr){
  if (!addr) return '인근';
  let m = addr.match(/([가-힣]+\d?동)(?![가-힣])/); if (m) return m[1];
  m = addr.match(/([가-힣]+[읍면])(?![가-힣])/);     if (m) return m[1];
  m = addr.match(/([가-힣]+[구군])(?![가-힣])/);     if (m) return m[1];
  return '인근';
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

/* 스마트 검색: 검색어 변형 시도 (후보 검색용 — /api/search) */
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

/* ============ 진단: 좌표기반 "안경원" 검색 → 1km 경쟁 순위 ============ */
async function crawlDiagnose(query, myStore, coords, myPlaceId) {
  let centerLat = null, centerLng = null;
  let stores;

  if (coords) {
    const parts = coords.split(',').map(Number);
    centerLat = parts[0]; centerLng = parts[1];
    // ★ 핵심: 상호가 아니라 "안경원" 일반 키워드 + 매장 좌표로 검색
    stores = await fetchStores('안경원', coords);
  } else {
    // 좌표가 없으면 (구버전 프론트 호환) 기존 상호 검색 방식으로 폴백
    stores = await fetchStores(query, coords);
  }

  let list = stores.filter(isEyewear);
  if (!list.length) list = stores;
  if (!list.length) throw new Error('순위 수집 실패 (차단/구조변경 가능)');

  const norm = (x) => String(x || '').replace(/\s/g, '');

  // 거리 보정: 네이버 dist 없으면 haversine으로 계산 (중심좌표 기준)
  list.forEach((s) => {
    if ((s.dist == null || isNaN(s.dist)) && centerLat != null) {
      s.dist = haversineKm(centerLat, centerLng, s.lat, s.lng);
    }
  });

  // 내 매장 식별: place_id 우선 → 상호 → 최근접(중심=내 매장)
  let me = null;
  if (myPlaceId) me = list.find((s) => String(s.place_id) === String(myPlaceId));
  if (!me && myStore) me = list.find((s) => norm(s.name).includes(norm(myStore)));
  if (!me && coords) {
    // 좌표 중심에 가장 가까운 매장 = 내 매장으로 간주
    me = list.slice().sort((a, b) => (a.dist ?? 9e9) - (b.dist ?? 9e9))[0] || null;
  }

  // 반경 1km 필터 (내 매장은 항상 포함)
  let area = list.filter((s) => (s.dist != null && s.dist <= RADIUS_KM) || (me && s === me));

  // 1km 내가 MIN_STORES 미만이면 → 1km 밖에서 '가장 가까운' 매장으로 채워 최소 개수 확보
  if (area.length < MIN_STORES) {
    const extra = list
      .filter((s) => !area.includes(s))
      .sort((a, b) => (a.dist ?? 9e9) - (b.dist ?? 9e9));
    for (const s of extra) {
      if (area.length >= MIN_STORES) break;
      area.push(s);
    }
  }
  // 표시 순서 = 네이버 검색 노출 순서 (거리순 아님). 원래 순서 기준 정렬 후 rank 부여
  area.sort((a, b) => list.indexOf(a) - list.indexOf(b));

  // 네이버 노출 순서 유지 = 지역 검색 순위. rank 재부여
  area = area.map((s, i) => ({ ...s, rank: i + 1 }));

  // area 안에서 내 매장 재조회 (rank가 반영된 객체)
  let meInArea = null;
  if (myPlaceId) meInArea = area.find((s) => String(s.place_id) === String(myPlaceId));
  if (!meInArea && me) meInArea = area.find((s) => s.place_id === me.place_id) || null;
  const myRank = meInArea ? meInArea.rank : null;

  const myDetail = meInArea ? {
    place_id: meInArea.place_id,
    reviews: meInArea.reviews,
    hasBooking: meInArea.hasBooking,
    descLength: 0,   // 소개글 길이는 instant-search엔 없음 (심층진단 영역)
  } : null;

  // 표시용 지역 라벨 (내 매장 주소 기준)
  const label = meInArea ? areaLabel(meInArea.address) : areaLabel(query);

  return {
    query: label,                 // 프론트 표시용: "자곡동" 등
    myStore: (meInArea && meInArea.name) || myStore,
    myRank,
    totalInArea: area.length,
    radiusKm: RADIUS_KM,
    topStores: area.slice(0, TOP_N),
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
  const coords = (req.query.coords || '').trim();      // "위도,경도"
  const placeId = (req.query.place_id || '').trim();   // 선택한 매장의 네이버 place id
  // coords 또는 query 중 하나는 있어야 함
  if (!coords && !query) return res.status(400).json({ success: false, error: 'coords 또는 query 필요' });

  // 캐시 키: 매장(place_id)+좌표 기준 (동일상호 충돌 방지)
  const key = 'diag::' + (placeId || store) + '::' + coords;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, result: hit.data });
  }
  if (inflight.has(key)) {
    try { const data = await inflight.get(key);
      return res.json({ success: true, cached: false, result: data }); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  }
  const p = crawlDiagnose(query, store, coords, placeId)
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
  res.json({ ok: true, version: 'v7', radiusKm: RADIUS_KM, cacheSize: cache.size, searchCacheSize: searchCache.size }));

app.listen(PORT, () => { console.log('서버 실행 중 (v7 · 좌표기반 1km 경쟁진단) - 포트 ' + PORT); });
