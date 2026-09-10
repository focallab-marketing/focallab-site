/* ============================================================================
 * server.js (v8) — 포컬랩 진단 백엔드 (좌표기반 1km 경쟁 진단) + 관리자 API
 *
 *   GET  /api/search?query=아이템안경원                          → 후보 매장 목록
 *   GET  /api/diagnose?coords=위도,경도&store=매장명&place_id=…  → 진단 (1km 경쟁)
 *   GET  /health
 *
 *   ── v8에서 추가된 관리자 기능 (기존 v7 로직은 전혀 건드리지 않음) ──
 *   POST   /admin/login                 → 로그인 (아이디/비번) → 토큰 발급
 *   GET    /admin/inquiries             → 문의 신청자 목록 (구글시트 연동)
 *   GET    /admin/inquiry-status        → 문의별 상태(연락완료 등) 조회
 *   POST   /admin/inquiry-status        → 문의별 상태 저장
 *   GET    /admin/admins                → 관리자 계정 목록 (슈퍼관리자 전용)
 *   POST   /admin/admins                → 관리자 계정 추가 (슈퍼관리자 전용)
 *   PATCH  /admin/admins/:username      → 역할/비밀번호 변경 (슈퍼관리자 전용)
 *   DELETE /admin/admins/:username      → 관리자 계정 삭제 (슈퍼관리자 전용)
 *
 *   설계 메모:
 *   - 새 npm 패키지를 추가하지 않기 위해 비밀번호 해시(scrypt)와 로그인 토큰
 *     서명(HMAC-SHA256, JWT와 동일 구조)을 Node 내장 crypto 모듈만으로 구현함.
 *     → 지금까지의 배포 방식(GitHub에 파일 하나 올리고 curl로 받아서 pm2
 *       restart)을 그대로 유지할 수 있음. npm install 불필요.
 *   - 관리자 계정은 DB 없이 서버의 admins.json 파일에 저장 (비밀번호는 해시로만 저장).
 *   - 문의 신청자 원본 데이터는 여전히 구글 스프레드시트에 있음. 서버는 매번
 *     Google Apps Script 웹앱(JSON API)을 호출해서 가져올 뿐, 서버에 복제 저장하지 않음.
 *   - "연락완료" 같은 처리 상태만 서버의 inquiry-status.json에 저장 (구글시트는 건드리지 않음).
 * ========================================================================== */
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());

const CACHE_TTL_MS = 48 * 60 * 60 * 1000;   // 진단 캐시 48시간
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;  // 검색 캐시 24시간
const TOP_N = 10;
const RADIUS_KM = 1.0;                      // 경쟁 반경 (1km 고정)
const MIN_STORES = 5;                       // 1km 내가 적으면 가까운 순으로 최소 이만큼 채움
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || '';  // 카카오 로컬 API 키 (환경변수)

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

/* ============ 카카오 로컬: 최근접 지하철역 (공식 API) ============ */
/* 매장 좌표(lat,lng) 주변에서 가장 가까운 지하철역 1곳을 반환.
   실패해도 진단은 계속되도록 항상 resolve(null)로 처리. */
function kakaoNearestStation(lat, lng) {
  return new Promise((resolve) => {
    if (!KAKAO_REST_KEY || lat == null || lng == null) return resolve(null);
    const path = '/v2/local/search/category.json?category_group_code=SW8'
      + '&x=' + encodeURIComponent(lng)   // x = 경도
      + '&y=' + encodeURIComponent(lat)   // y = 위도
      + '&radius=20000&sort=distance&size=1';
    const options = {
      hostname: 'dapi.kakao.com', path, method: 'GET',
      headers: { 'Authorization': 'KakaoAK ' + KAKAO_REST_KEY },
      timeout: 8000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const d = j.documents && j.documents[0];
          if (d) resolve({ name: d.place_name, distanceM: Number(d.distance) || null });
          else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/* 카카오 카테고리 장소 개수 (좌표 반경 내). meta.total_count 사용.
   실패해도 0으로 처리해 진단은 계속된다. */
function kakaoCategoryCount(lat, lng, code, radiusM) {
  return new Promise((resolve) => {
    if (!KAKAO_REST_KEY || lat == null || lng == null) return resolve(0);
    const path = '/v2/local/search/category.json?category_group_code=' + code
      + '&x=' + encodeURIComponent(lng) + '&y=' + encodeURIComponent(lat)
      + '&radius=' + radiusM + '&size=1';
    const options = {
      hostname: 'dapi.kakao.com', path, method: 'GET',
      headers: { 'Authorization': 'KakaoAK ' + KAKAO_REST_KEY }, timeout: 8000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve((j.meta && j.meta.total_count) || 0); }
        catch (e) { resolve(0); }
      });
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

/* 여러 카테고리 코드를 합산 (예: 학원+학교) */
async function kakaoCategoryGroup(lat, lng, codes, radiusM) {
  let sum = 0;
  for (const c of codes) sum += await kakaoCategoryCount(lat, lng, c, radiusM);
  return sum;
}

/* 매장 반경 내 상권 지표 (학원·병원·음식점·편의점 등) */
async function localBusiness(lat, lng, radiusM) {
  if (!KAKAO_REST_KEY || lat == null || lng == null) return null;
  const [edu, medical, food, conv] = await Promise.all([
    kakaoCategoryGroup(lat, lng, ['AC5', 'SC4'], radiusM),  // 학원·학교
    kakaoCategoryGroup(lat, lng, ['HP8', 'PM9'], radiusM),  // 병원·약국
    kakaoCategoryGroup(lat, lng, ['FD6', 'CE7'], radiusM),  // 음식점·카페
    kakaoCategoryGroup(lat, lng, ['CS2', 'MT1'], radiusM),  // 편의점·마트
  ]);
  return { edu, medical, food, conv };
}
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

/* ── 아파트 세대수 데이터 (배치로 구축한 apartments.json) ── */
let APARTMENTS = [];
try {
  APARTMENTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'apartments.json'), 'utf8'));
  console.log('아파트 데이터 로드: ' + APARTMENTS.length + '개 단지');
} catch (e) {
  console.log('아파트 데이터 없음 (apartments.json 미존재) — 세대수 표시는 비활성');
}

/* 매장 좌표 반경 내 아파트 단지 수·세대수 합산.
   커버 안 된 지역(단지 0개)이면 null 반환 → 화면에 세대수 줄 안 띄움 */
function aptWithin(lat, lng, radiusKm){
  if (!APARTMENTS.length || lat == null || lng == null) return null;
  let count = 0, households = 0;
  for (const a of APARTMENTS){
    if (a.lat == null || a.lng == null) continue;
    const d = haversineKm(lat, lng, a.lat, a.lng);
    if (d != null && d <= radiusKm){ count++; households += (a.households || 0); }
  }
  if (!count) return null;
  return { count, households, radiusKm };
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

  // 상권 정보: 최근접 지하철역 (카카오 로컬 API). 실패해도 null로 진행
  const stCenterLat = (meInArea && meInArea.lat != null) ? meInArea.lat : centerLat;
  const stCenterLng = (meInArea && meInArea.lng != null) ? meInArea.lng : centerLng;
  const nearestStation = await kakaoNearestStation(stCenterLat, stCenterLng);

  // 상권 정보: 반경 1km 아파트 단지 수·세대수 (배치 데이터 기반, API 호출 없음)
  const localApt = aptWithin(stCenterLat, stCenterLng, RADIUS_KM);

  // 상권 지표: 반경 1km 학원·병원·음식점·편의점 개수 (카카오 카테고리)
  const localBiz = await localBusiness(stCenterLat, stCenterLng, RADIUS_KM * 1000);

  return {
    query: label,                 // 프론트 표시용: "자곡동" 등
    myStore: (meInArea && meInArea.name) || myStore,
    myRank,
    totalInArea: area.length,
    radiusKm: RADIUS_KM,
    topStores: area.slice(0, TOP_N),
    myDetail,
    nearestStation,               // { name, distanceM } 또는 null
    localApt,                     // { count, households, radiusKm } 또는 null
    localBiz,                     // { edu, medical, food, conv } 또는 null
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
  res.json({ ok: true, version: 'v8', radiusKm: RADIUS_KM, kakao: !!KAKAO_REST_KEY, apartments: APARTMENTS.length, cacheSize: cache.size, searchCacheSize: searchCache.size }));


/* ============================================================================
 * ▼▼▼ 여기서부터 v8 관리자 기능 추가분 ▼▼▼
 * ========================================================================== */

/* ---------- 설정 (환경변수) ---------- */
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || '';          // 토큰 서명용 비밀키 (필수)
const ADMIN_INIT_USERNAME = process.env.ADMIN_INIT_USERNAME || '';    // 최초 부팅시 슈퍼관리자 계정 생성용
const ADMIN_INIT_PASSWORD = process.env.ADMIN_INIT_PASSWORD || '';    // (admins.json이 없을 때만 사용됨)
const SHEET_API_URL = process.env.SHEET_API_URL || '';                // Apps Script 웹앱 URL
const SHEET_API_TOKEN = process.env.SHEET_API_TOKEN || '';            // Apps Script 인증 토큰
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 로그인 토큰 유효시간: 12시간

const ADMINS_FILE = path.join(__dirname, 'admins.json');
const STATUS_FILE = path.join(__dirname, 'inquiry-status.json');

if (!ADMIN_JWT_SECRET) {
  console.warn('⚠ ADMIN_JWT_SECRET 환경변수가 없습니다. 관리자 로그인이 동작하지 않습니다.');
}

/* ---------- 비밀번호 해시 (scrypt, 내장 crypto만 사용) ---------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // 타이밍 공격 방지를 위해 길이가 다르면 즉시 false, 같으면 timingSafeEqual
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------- 로그인 토큰 (JWT와 동일 구조, jsonwebtoken 패키지 없이 구현) ---------- */
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}
function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', ADMIN_JWT_SECRET).update(h + '.' + p).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return h + '.' + p + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', ADMIN_JWT_SECRET).update(h + '.' + p).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(p)); } catch (e) { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload; // { username, role, iat, exp }
}

/* ---------- 관리자 계정 저장/로드 (admins.json) ---------- */
function loadAdmins() {
  try {
    return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveAdmins(list) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
/* 서버 최초 기동시, admins.json이 없고 초기 계정 환경변수가 있으면
   슈퍼관리자 1명을 자동 생성. 이후에는 이 환경변수가 있어도 무시됨
   (admins.json이 이미 있으므로) — 안전을 위해 최초 1회만 동작. */
(function ensureBootstrapAdmin() {
  const existing = loadAdmins();
  if (existing.length > 0) return;
  if (!ADMIN_INIT_USERNAME || !ADMIN_INIT_PASSWORD) {
    console.warn('⚠ admins.json이 비어있고 ADMIN_INIT_USERNAME/ADMIN_INIT_PASSWORD도 없어 ' +
      '관리자 계정이 하나도 없습니다. pm2 restart 시 두 환경변수를 넣어 최초 슈퍼관리자를 생성하세요.');
    return;
  }
  const admin = {
    username: ADMIN_INIT_USERNAME,
    passwordHash: hashPassword(ADMIN_INIT_PASSWORD),
    role: 'super_admin',
    createdAt: new Date().toISOString(),
  };
  saveAdmins([admin]);
  console.log('✅ 최초 슈퍼관리자 계정 생성 완료: ' + ADMIN_INIT_USERNAME);
})();

/* ---------- 로그인 시도 제한 (무차별 대입 방지, 메모리 기반) ---------- */
const loginAttempts = new Map(); // key: ip+username → { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000; // 10분 잠금
function attemptKey(req, username) { return (req.ip || '') + '::' + username; }
function isLocked(key) {
  const a = loginAttempts.get(key);
  return a && a.lockedUntil && Date.now() < a.lockedUntil;
}
function registerFailure(key) {
  const a = loginAttempts.get(key) || { count: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = Date.now() + LOCK_MS;
  loginAttempts.set(key, a);
}
function clearFailures(key) { loginAttempts.delete(key); }

/* ---------- 인증 미들웨어 ---------- */
const ROLE_RANK = { admin: 1, super_admin: 2 };
function requireAuth(minRole) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ success: false, error: '로그인이 필요합니다 (토큰 만료/무효)' });
    if (minRole && (ROLE_RANK[payload.role] || 0) < ROLE_RANK[minRole]) {
      return res.status(403).json({ success: false, error: '권한이 없습니다' });
    }
    req.admin = payload;
    next();
  };
}

/* ---------- POST /admin/login ---------- */
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: '아이디/비밀번호를 입력하세요' });

  const key = attemptKey(req, username);
  if (isLocked(key)) {
    return res.status(429).json({ success: false, error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.' });
  }

  const admins = loadAdmins();
  const found = admins.find((a) => a.username === username);
  if (!found || !verifyPassword(password, found.passwordHash)) {
    registerFailure(key);
    return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다' });
  }
  clearFailures(key);
  const token = signToken({ username: found.username, role: found.role });
  res.json({ success: true, token, username: found.username, role: found.role });
});

/* ---------- GET /admin/me (토큰 유효성 확인용) ---------- */
app.get('/admin/me', requireAuth(), (req, res) => {
  res.json({ success: true, username: req.admin.username, role: req.admin.role });
});

/* ---------- 구글시트 문의 목록 가져오기 ---------- */
function fetchSheetRows() {
  return new Promise((resolve, reject) => {
    if (!SHEET_API_URL) return reject(new Error('SHEET_API_URL 환경변수가 설정되지 않았습니다'));
    const url = SHEET_API_URL + (SHEET_API_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(SHEET_API_TOKEN);
    https.get(url, { timeout: 15000 }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.success) return reject(new Error(j.error || '시트 응답 오류'));
          resolve(j.rows || []);
        } catch (e) { reject(new Error('시트 응답 파싱 실패')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('시트 요청 시간 초과')); });
  });
}

/* 폼 "이름" 칸에 진단정보가 함께 저장되는 규칙(인수인계 메모 참고)을 분리:
   자가진단 → "이름 [진단: NN점, 놓치는손님..., 개선필요:...]"
   순위진단 → "이름 [순위진단 · "검색어" N위 · 리뷰 NN]"
   그 외    → 순수 상담 신청 (일반) */
function parseInquiryName(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*\[(.+)\]\s*$/);
  if (!m) return { name: s, type: '일반상담', detail: '' };
  const name = m[1].trim();
  const bracket = m[2].trim();
  if (bracket.includes('순위진단')) return { name, type: '순위진단', detail: bracket };
  if (bracket.startsWith('진단')) return { name, type: '자가진단', detail: bracket };
  return { name, type: '일반상담', detail: bracket };
}

/* ---------- 문의별 상태(연락완료 등) 저장 ---------- */
function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveStatus(obj) { fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2), 'utf8'); }
function inquiryKey(row) { return row.timestamp + '::' + row.phone; }

/* ---------- GET /admin/inquiries ---------- */
app.get('/admin/inquiries', requireAuth(), async (req, res) => {
  try {
    const rows = await fetchSheetRows();
    const status = loadStatus();
    const list = rows.map((r) => {
      const parsed = parseInquiryName(r.name);
      const key = inquiryKey(r);
      return {
        key,
        timestamp: r.timestamp,
        phone: r.phone,
        name: parsed.name,
        type: parsed.type,
        detail: parsed.detail,
        status: status[key] || '신규',
      };
    });
    // 최신 신청 순
    list.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    res.json({ success: true, count: list.length, rows: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ---------- GET/POST /admin/inquiry-status ---------- */
app.get('/admin/inquiry-status', requireAuth(), (req, res) => {
  res.json({ success: true, status: loadStatus() });
});
app.post('/admin/inquiry-status', requireAuth(), (req, res) => {
  const { key, status } = req.body || {};
  if (!key || !status) return res.status(400).json({ success: false, error: 'key/status 필요' });
  const all = loadStatus();
  all[key] = status;
  saveStatus(all);
  res.json({ success: true });
});

/* ---------- 관리자 계정 관리 (슈퍼관리자 전용) ---------- */
app.get('/admin/admins', requireAuth('super_admin'), (req, res) => {
  const admins = loadAdmins().map((a) => ({ username: a.username, role: a.role, createdAt: a.createdAt }));
  res.json({ success: true, admins });
});

app.post('/admin/admins', requireAuth('super_admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ success: false, error: 'username/password/role 필요' });
  if (!['admin', 'super_admin'].includes(role)) return res.status(400).json({ success: false, error: 'role은 admin 또는 super_admin' });
  if (password.length < 8) return res.status(400).json({ success: false, error: '비밀번호는 8자 이상' });

  const admins = loadAdmins();
  if (admins.find((a) => a.username === username)) {
    return res.status(409).json({ success: false, error: '이미 존재하는 아이디입니다' });
  }
  admins.push({ username, passwordHash: hashPassword(password), role, createdAt: new Date().toISOString() });
  saveAdmins(admins);
  res.json({ success: true });
});

app.patch('/admin/admins/:username', requireAuth('super_admin'), (req, res) => {
  const { username } = req.params;
  const { password, role } = req.body || {};
  const admins = loadAdmins();
  const found = admins.find((a) => a.username === username);
  if (!found) return res.status(404).json({ success: false, error: '계정을 찾을 수 없습니다' });

  if (role) {
    if (!['admin', 'super_admin'].includes(role)) return res.status(400).json({ success: false, error: 'role은 admin 또는 super_admin' });
    // 마지막 슈퍼관리자를 강등하는 것 방지
    if (found.role === 'super_admin' && role !== 'super_admin') {
      const superCount = admins.filter((a) => a.role === 'super_admin').length;
      if (superCount <= 1) return res.status(400).json({ success: false, error: '마지막 슈퍼관리자는 강등할 수 없습니다' });
    }
    found.role = role;
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ success: false, error: '비밀번호는 8자 이상' });
    found.passwordHash = hashPassword(password);
  }
  saveAdmins(admins);
  res.json({ success: true });
});

app.delete('/admin/admins/:username', requireAuth('super_admin'), (req, res) => {
  const { username } = req.params;
  const admins = loadAdmins();
  const found = admins.find((a) => a.username === username);
  if (!found) return res.status(404).json({ success: false, error: '계정을 찾을 수 없습니다' });
  if (username === req.admin.username) return res.status(400).json({ success: false, error: '자기 자신은 삭제할 수 없습니다' });
  if (found.role === 'super_admin') {
    const superCount = admins.filter((a) => a.role === 'super_admin').length;
    if (superCount <= 1) return res.status(400).json({ success: false, error: '마지막 슈퍼관리자는 삭제할 수 없습니다' });
  }
  saveAdmins(admins.filter((a) => a.username !== username));
  res.json({ success: true });
});

/* ============================================================================
 * ▲▲▲ v8 관리자 기능 추가분 끝 ▲▲▲
 * ========================================================================== */

app.listen(PORT, () => { console.log('서버 실행 중 (v8 · 좌표기반 1km 경쟁진단 + 관리자 API) - 포트 ' + PORT); });
