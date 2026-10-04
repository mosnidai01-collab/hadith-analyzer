// مُسنِد AI: مطابقة الآيات مع نصوص مجمع الملك فهد للروايات الثماني (البند 8.1 من وثيقة التعريف).
// المرحلة الأولى (الهيكل): تُحذف الحركات والألفات والهمزات، وتُطابَق الحروف متصلةً دون مسافات،
//   فلا يُعدّ فرق الرسم العثماني والإملائي اختلافاً («يا أيها» = «يَٰٓأَيُّهَا»، «الصلاة» = «ٱلصَّلَوٰةَ»).
// المرحلة الثانية (التشكيل): إن كان المنشور مشكولاً، تُقارَن حركات الحروف الصامتة بكل رواية،
//   ولا تُسمّى رواية إلا بعد هذه المرحلة. الألفات كلها مهملة.
// لا يُعدَّل نص الآية: يُعرض كما في ملف المجمع.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ORDER = ['hafs', 'shouba', 'warsh', 'qaloon', 'doori', 'soosi', 'bazzi', 'qumbul'];
const MIN_SKELETON = 10;      // أقل عدد حروف هيكل يُبحث به (دونه نص قصير جداً)
const VOCAL_RATIO = 0.5;      // نسبة الحروف المشكولة ليُعدّ المنشور مشكولاً
const FUZZY_MIN = 0.55;       // أقل تشابه لعرض «أقرب نص»
const MAX_LOCATIONS = 5;

let Q = null;
function load() {
  if (Q) return Q;
  // المسار يختلف بين التشغيل المحلي والدالة المحزومة في Netlify، فتُجرَّب عدة مواضع
  const cands = [path.join(__dirname, '../data/quran.json.gz'), path.join(__dirname, '../../data/quran.json.gz'),
    path.join(process.cwd(), 'data/quran.json.gz'), path.join(process.cwd(), 'musnid-starter/data/quran.json.gz')];
  if (process.env.LAMBDA_TASK_ROOT) cands.push(path.join(process.env.LAMBDA_TASK_ROOT, 'data/quran.json.gz'));
  const p = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
  if (!p) throw new Error('تعذّر العثور على data/quran.json.gz');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  Q = { suras: data.suras, source: data.source, r: {} };
  for (const key of ORDER) {
    const rw = data.riwayat[key];
    const starts = [];
    let concat = '';
    const sk = rw.ayat.map((a) => skeletonOnly(a[2]));
    sk.forEach((s) => { starts.push(concat.length); concat += s; });
    Q.r[key] = { key, name: rw.name, ayat: rw.ayat, starts, concat, sk };
  }
  // فهرس إضافي بالرسم الإملائي لرواية حفص (من ملف المجمع)، يُستعمل للعثور على الآية فقط
  if (data.hafs_imlaei) {
    const H = Q.r.hafs;
    const starts = [];
    let concat = '';
    data.hafs_imlaei.forEach((t) => { starts.push(concat.length); concat += skeletonOnly(t); });
    Q.imlaei = { key: 'hafs', name: H.name, ayat: H.ayat, starts, concat };
  }
  return Q;
}

// ---------- التحليل الحرفي ----------
const DROP = new Set(['ا', 'أ', 'إ', 'آ', 'ٱ', 'ء', 'ئ', 'ٲ', 'ٳ']);
const MAP = { '\u06E7': 'ي', 'ؤ': 'و', 'ى': 'ي', 'ے': 'ي', 'ی': 'ي', 'ة': 'ت', 'ک': 'ك' };
const isLetter = (c) => (c >= 'ء' && c <= 'ي' && c !== 'ـ') || 'ٱےیکٲٳۧ'.includes(c);
const VOWEL = {
  'َ': ['a', 0], 'ً': ['a', 1], 'ٞ': ['a', 1], 'ࣰ': ['a', 1],
  'ُ': ['u', 0], 'ٌ': ['u', 1], 'ٗ': ['u', 1], 'ࣱ': ['u', 1],
  'ِ': ['i', 0], 'ٍ': ['i', 1], 'ٖ': ['i', 1], 'ࣲ': ['i', 1],
};
const SUKUN = new Set(['ْ', 'ۡ']);
const SILAH = new Set(['ۥ', 'ۦ']);

// يعيد قائمة الحروف الصامتة مع علاماتها، وقائمة الكلمات الأصلية
function parse(text) {
  const t = String(text || '');
  const out = [];
  const words = [];
  let word = '', wordIdx = -1, newWord = true, dropping = false, cur = null;
  const flushWord = () => { if (word) { words.push(word); word = ''; } };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (isLetter(c)) {
      if (newWord) { flushWord(); wordIdx = words.length; newWord = false; }
      word += c;
      if (DROP.has(c)) { dropping = true; cur = null; continue; }
      dropping = false;
      cur = { ch: MAP[c] || c, v: null, tan: 0, suk: false, sh: false, hamza: c === 'ؤ',
        silah: false, w: wordIdx, start: !out.length || out[out.length - 1].w !== wordIdx, rawCh: c };
      out.push(cur);
    } else if (c === 'ٰ') {               // ألف خنجرية
      if (newWord) continue;
      word += c;
      // واو أو ياء الرسم بلا حركة قبل الألف الخنجرية تمثّل ألفاً: «ٱلصَّلَوٰةَ»، «ٱلتَّوۡرَىٰةَ»
      if (cur && !dropping && !cur.v && !cur.suk && !cur.sh) {
        const next = t.slice(i + 1).match(/^[ً-ٟۖ-ٰۭ]*(.)/);
        const midWord = next && isLetter(next[1]);
        if (cur.rawCh === 'و' || ((cur.rawCh === 'ى' || cur.rawCh === 'ے') && midWord)) {
          out.pop(); cur = null; dropping = true;
        }
      }
    } else if (VOWEL[c] || SUKUN.has(c) || c === 'ّ' || SILAH.has(c) || (c >= 'ً' && c <= 'ٟ') || (c >= 'ۖ' && c <= 'ۭ') || c === 'ـ') {
      if (!newWord) word += c;
      if (dropping || !cur) continue;
      if (VOWEL[c]) { cur.v = VOWEL[c][0]; cur.tan = VOWEL[c][1]; }
      else if (SUKUN.has(c)) cur.suk = true;
      else if (c === 'ّ') cur.sh = true;
      else if (SILAH.has(c)) cur.silah = true;
      else if ((c === '\u06E2' || c === '\u06ED') && cur.v) cur.tan = 1;   // ميم الإقلاب بعد الحركة = تنوين
    } else {
      newWord = true; dropping = false; cur = null;
    }
  }
  flushWord();
  // الحرفان المتماثلان المتتاليان حرف واحد في الهيكل: «ٱلَّيۡلِ» = «الليل»، «يُحۡيِۦ» = «يحيي»، «يَلۡوُۥنَ» = «يلوون»
  const merged = [];
  for (const x of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.ch === x.ch) {
      if (x.v && !prev.v) prev.w = x.w;   // الحرف المشكول هو المنطوق، فيُنسب إلى كلمته
      if (x.v) { prev.v = x.v; prev.tan = x.tan; prev.suk = false; }
      prev.merged = true;
      prev.bareTail = !x.v && !x.suk && !x.sh;
      prev.sh = prev.sh || x.sh; prev.silah = prev.silah || x.silah; prev.hamza = prev.hamza || x.hamza;
      continue;
    }
    merged.push(x);
  }
  return { letters: merged, words };
}

function skeletonOnly(text) { return parse(text).letters.map((x) => x.ch).join(''); }

function vocalRatio(letters) {
  if (!letters.length) return 0;
  return letters.filter((x) => x.v || x.suk || x.sh).length / letters.length;
}

// ---------- المرحلة الأولى: الهيكل ----------
function ayaAt(R, pos) {
  let lo = 0, hi = R.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R.starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

function findAll(R, sk) {
  const occ = [];
  let i = R.concat.indexOf(sk);
  while (i >= 0 && occ.length < 60) {
    const a1 = ayaAt(R, i), a2 = ayaAt(R, i + sk.length - 1);
    occ.push({ pos: i, a1, a2 });
    i = R.concat.indexOf(sk, i + 1);
  }
  return occ;
}

// ---------- المرحلة الثانية: التشكيل ----------
function compareVocal(P, R, o, postHasHamza) {
  let src = { letters: [], words: [] };
  for (let k = o.a1; k <= o.a2; k++) {
    const p = parse(R.ayat[k][2]);
    const base = src.words.length;
    p.letters.forEach((x) => src.letters.push({ ...x, w: x.w + base, aya: k }));
    src.words.push(...p.words);
  }
  const off = o.pos - R.starts[o.a1];
  const diffs = [];
  const last = P.letters.length - 1;
  P.letters.forEach((p, j) => {
    const s = src.letters[off + j];
    if (!s) return;
    if (p.merged || s.merged) return;   // حرفان مدمجان في الهيكل: تختلف كتابتهما بين الرسمين فلا يُقارن تشكيلهما
    let bad = false;
    if (j !== last) {   // الحرف الأخير قد يُسكَّن وقفاً
      if (p.v) {
        if ((s.v && s.v !== p.v) || (!s.v && s.suk)) bad = true;
        else if (s.v === p.v && p.tan !== s.tan) bad = true;
      } else if (p.suk && s.v) bad = true;
    }
    // الحرف السابق العاري في الرسم العثماني يدل على الإدغام، فلا تُعدّ شدة المنشور فرقاً
    const sp = src.letters[off + j - 1];
    const prevBare = sp && ((!sp.v && !sp.suk && !sp.sh) || sp.bareTail);
    if (p.sh && !s.sh && !p.start && !prevBare) bad = true;
    if (postHasHamza && p.ch === 'و' && p.hamza !== s.hamza) bad = true;
    if (p.silah && !s.silah) bad = true;
    if (bad) diffs.push({ pw: p.w, sw: s.w });
  });
  // تجميع الفروق بالكلمات
  const seen = new Set();
  const words = [];
  for (const d of diffs) {
    const k = d.pw + ':' + d.sw;
    if (seen.has(k)) continue;
    seen.add(k);
    words.push({ post: P.words[d.pw], source: src.words[d.sw] });
  }
  return { count: diffs.length, words };
}

// ---------- أقرب نص (حين لا يطابق الهيكل) ----------
function trigrams(s) {
  const m = new Map();
  for (let i = 0; i + 3 <= s.length; i++) { const g = s.substr(i, 3); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function diceTri(A, B) {
  let inter = 0, na = 0, nb = 0;
  A.forEach((n) => { na += n; });
  B.forEach((n, g) => { nb += n; if (A.has(g)) inter += Math.min(n, A.get(g)); });
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

function closest(sk) {
  const H = Q.r.hafs;
  const T = trigrams(sk);
  // أفضل آية مفردة بنسبة ما تغطيه من حروف المنشور
  let best = -1, bestCov = 0;
  H.sk.forEach((s, i) => {
    if (!s) return;
    let hit = 0;
    for (let k = 0; k + 3 <= s.length; k++) if (T.has(s.substr(k, 3))) hit++;
    const cov = hit / Math.max(1, Math.min(s.length, sk.length) - 2);
    if (cov > bestCov) { bestCov = cov; best = i; }
  });
  if (best < 0) return null;
  const sura = H.ayat[best][0], ayaNo = H.ayat[best][1];
  let top = null;
  for (const key of ORDER) {
    const R = Q.r[key];
    for (let i = 0; i < R.ayat.length; i++) {
      if (R.ayat[i][0] !== sura || Math.abs(R.ayat[i][1] - ayaNo) > 3) continue;
      let s = '';
      for (let j = i; j < R.ayat.length && R.ayat[j][0] === sura && j - i < 6; j++) {
        s += R.sk[j];
        const sc = diceTri(T, trigrams(s));
        if (!top || sc > top.score) top = { key, a1: i, a2: j, score: sc };
        if (s.length > sk.length * 1.6) break;
      }
    }
  }
  return top;
}

// فروق الكلمات بين نصين (على الهيكل)، بخوارزمية أطول متتالية مشتركة
function wordDiff(a, b) {
  const A = parse(a).words, B = parse(b).words;
  const ka = A.map(skeletonOnly), kb = B.map(skeletonOnly);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = ka[i] === kb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const post = [], source = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { post.push([A[i++], 0]); source.push([B[j++], 0]); }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) source.push([B[j++], 1]);
    else post.push([A[i++], 1]);
  }
  return { post, source };
}

// ---------- الواجهة ----------
const loc = (R, a1, a2) => ({
  sura_no: R.ayat[a1][0], sura: Q.suras[String(R.ayat[a1][0])],
  from: R.ayat[a1][1], to: R.ayat[a2][1],
  cross_sura: R.ayat[a1][0] !== R.ayat[a2][0],
});
const textOf = (R, a1, a2) => R.ayat.slice(a1, a2 + 1).map((a) => a[2] + ' ﴿' + String(a[1]).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]) + '﴾').join(' ');

function match(text) {
  load();
  const P = parse(text);
  const sk = P.letters.map((x) => x.ch).join('');
  if (sk.length < MIN_SKELETON) return { kind: 'too_short' };
  const vocalized = vocalRatio(P.letters) >= VOCAL_RATIO;
  const postHasHamza = /[ؤئأإء]/.test(text);

  const per = {};
  for (const key of ORDER) {
    const occ = findAll(Q.r[key], sk);
    if (occ.length) per[key] = occ;
  }
  const keys = Object.keys(per);

  if (!keys.length && Q.imlaei) {
    const occ = findAll(Q.imlaei, sk);
    if (occ.length) {
      const R = Q.r.hafs, o = occ[0];
      return { kind: 'match', vocalized: false, imlaei_only: true, missing: [],
        results: [{ key: 'hafs', name: R.name, occurrences: occ.length,
          locations: occ.slice(0, MAX_LOCATIONS).map((x) => loc(R, x.a1, x.a2)),
          best: loc(R, o.a1, o.a2), source_text: textOf(R, o.a1, o.a2), vocal_diffs: null, diff_words: null }] };
    }
  }

  if (!keys.length) {
    const c = closest(sk);
    if (!c || c.score < FUZZY_MIN) return { kind: 'none' };
    const R = Q.r[c.key];
    const st = textOf(R, c.a1, c.a2);
    return { kind: 'different', riwaya: c.key, riwaya_name: R.name, location: loc(R, c.a1, c.a2),
      source_text: st, score: Math.round(c.score * 100) / 100, diff: wordDiff(text, R.ayat.slice(c.a1, c.a2 + 1).map((a) => a[2]).join(' ')) };
  }

  const results = keys.map((key) => {
    const R = Q.r[key];
    const occ = per[key];
    let best = occ[0], vocal = null;
    if (vocalized) {
      for (const o of occ.slice(0, 20)) {
        const v = compareVocal(P, R, o, postHasHamza);
        if (!vocal || v.count < vocal.count) { vocal = v; best = o; }
        if (!v.count) break;
      }
    }
    return { key, name: R.name, occurrences: occ.length,
      locations: occ.slice(0, MAX_LOCATIONS).map((o) => loc(R, o.a1, o.a2)),
      best: loc(R, best.a1, best.a2), source_text: textOf(R, best.a1, best.a2),
      vocal_diffs: vocal ? vocal.count : null, diff_words: vocal ? vocal.words : null };
  });

  const out = { kind: 'match', vocalized, results, missing: ORDER.filter((k) => !per[k]).map((k) => Q.r[k].name) };
  if (vocalized) {
    out.agree = results.filter((r) => r.vocal_diffs === 0).map((r) => r.key);
    if (!out.agree.length) {
      const near = results.slice().sort((a, b) => a.vocal_diffs - b.vocal_diffs)[0];
      out.kind = 'vocal_none';
      out.nearest = near.key;
    }
  }
  return out;
}

// هل النص كله آية أو آيات؟ (للمطابقة المباشرة دون نموذج)
function isWholeQuran(text) {
  const m = match(text);
  return (m.kind === 'match' || m.kind === 'vocal_none') ? m : null;
}

module.exports = { match, isWholeQuran, parse, skeletonOnly, load, ORDER };
