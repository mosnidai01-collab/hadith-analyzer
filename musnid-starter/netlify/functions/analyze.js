// مُسنِد: دالة التحليل.
// الآيات: تُطابَق مع نصوص مجمع الملك فهد للروايات الثماني (lib/quran.js)، ولا تُسمّى رواية إلا بعد مقارنة التشكيل.
// دور النموذج هنا: استخراج النص وتقسيمه وتصنيفه فقط. لا يُصدر حكماً على أي نص.
// الأحكام تأتي من data/verdicts.json منقولةً كما هي ومنسوبةً إلى قائلها (الطبقة الأولى)،
// فإن لم يوجد النص فيها بُحث حيّاً في واجهة الموسوعة الحديثية بالدرر السنية (الطبقة الثانية)،
// وتُعرض نتائجها كما وردت دون تخزين، مع وسم أنها منقولة بواسطة ولم يُراجَع أصلها.

const fs = require('fs');
const path = require('path');

// النماذج تُجرَّب بالترتيب إن فشل السابق (403/404/429/عطل). تُستبدل بالمتغير GEMINI_MODEL (مفصولة بفواصل).
// الترتيب الافتراضي يبدأ بالأسرع: في مقارنة 5 أكتوبر على صور الاختبار أجاب flash-lite في 3–11 ث، وانتهت مهلة النموذجين الآخرين في أغلب الطلبات.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3-flash-preview')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OCR_CONFIDENCE_MIN = 0.6; // حد مؤقت: يُضبط بالاختبار على مجموعة الاختبار
const MATCH_EXACT = 0.95;
const MATCH_CLOSE = 0.6;
// مهلة الدوال المتزامنة في Netlify قصيرة (نحو 10 ثوانٍ في الخطة المجانية)؛ نترك هامشاً.
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS) || 8500;
const FALLBACK_STATUS = new Set([403, 404, 429, 500, 502, 503, 504]);
const ALLOWED_TYPES = new Set(['آية', 'حديث', 'قول منسوب', 'معلومة', 'حكم فقهي']);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // حد حمولة الدوال نحو 6 ميغابايت
// الطبقة الثانية: واجهة الموسوعة الحديثية الرسمية (dorar.net/article/389). تُعطَّل بـ DORAR_ENABLED=0
const DORAR_ENABLED = process.env.DORAR_ENABLED !== '0';
const DORAR_API = 'https://dorar.net/dorar_api.json';
const DORAR_MAX_SHOWN = 5;      // أقصى عدد ألفاظ تُعرض في البطاقة
const DORAR_QUERY_WORDS = 10;   // أول كلمات الادعاء تُرسل للبحث
const TOTAL_BUDGET_MS = Number(process.env.TOTAL_BUDGET_MS) || 9300; // مهلة الطلب كله

// مسار القرآن: مطابقة بالروايات الثماني من نصوص مجمع الملك فهد (lib/quran.js)
const quran = require('../../lib/quran.js');

let DB = { entries: [] };
try {
  DB = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/verdicts.json'), 'utf8'));
} catch (e) {
  console.error('تعذّرت قراءة قاعدة الأحكام', e.message);
}

const SYSTEM = `أنت وحدة استخراج نصوص فقط في أداة تحقق من المنشورات الدينية.
مهمتك: (1) قراءة النص كما هو مكتوب دون تصحيح أو إكمال، (2) فصل المنشور إلى ادعاءات مستقلة، (3) تصنيف كل ادعاء.
ممنوع عليك: الحكم على أي حديث أو أثر، أو تصحيح لفظ، أو إكمال نص ناقص، أو كتابة نص من ذاكرتك، أو الإفتاء.
أجب بـ JSON فقط دون أي نص آخر ودون علامات markdown، بهذه الحقول بالضبط:
{
 "readable": قيمة منطقية,
 "confidence": رقم من 0 إلى 1 يمثل ثقتك في قراءتك للنص كله,
 "full_text": النص الكامل كما قرأته حرفياً,
 "claims": [
  {
   "type": أحد: "آية" أو "حديث" أو "قول منسوب" أو "معلومة" أو "حكم فقهي",
   "text": مقطع منسوخ من full_text دون أي تغيير,
   "uncertain": true إن شككت في قراءة كلمة فيه وإلا false,
   "publisher_grade": حكم ذكره المنشور نفسه على هذا الحديث بعينه، أو null,
   "cited_reference": مرجع ذكره المنشور لهذا الادعاء بعينه (كتاب ورقم)، أو null,
   "attributed_to": القائل أو صيغة النسبة كما في المنشور ("كان يقال"، "قال فلان"، "من أقوال الصحابة")، أو null
  }
 ]
}
قواعد:
- انقل النص بتشكيله وأخطائه كما هو. لا تستبدله بما تحفظه من القرآن أو الحديث.
- الآيات خاصة: انسخها حرفاً حرفاً برسمها وتشكيلها وعلاماتها الصغيرة كما في الصورة (مثل ۥ ۦ ٓ ٰ ۪ ۬ ٱ)، ولو خالفت رواية حفص أو الإملاء المعتاد؛ فقد تكون برواية أخرى كورش (مثل «يُومِنُونَ» بلا همز، و«عَلَيْهِمُۥٓ» بصلة الميم). لا تضف همزة ولا حرفاً، ولا تحذف علامة، ولا تحوّل الرسم العثماني إلى إملائي.
- لا تضف تشكيلاً إلى نص غير مشكول، ولا تكمل تشكيلاً ناقصاً.
- افصل الشرح والتفسير عن النص الشرعي؛ الشرح يُصنَّف «معلومة».
- النسبة الجماعية («من أقوال الصحابة...») تُفكّ إلى ادعاء لكل قول، وتوضع العبارة الجماعية في attributed_to.
- الأذكار والحِكَم العامة والكلام الإنشائي «معلومة».
- الأحكام الفقهية الواردة في المنشور «حكم فقهي».
- قد يحمل المنشور الواحد عدة أحاديث لكل منها حكم ناشر مختلف: ضع كل حكم في ادعاء صاحبه وحده، ولا تعمّم.
- «حكم الناشر» ينقل كما كُتب ولا يكون ادعاءً مستقلاً، وهو ادعاء من الناشر وليس حقيقة.
- إن كانت الصورة غير مقروءة أو النص مشوّهاً فاجعل readable=false وconfidence منخفضة وclaims قائمة فارغة، ولا تخمّن.
- عبّر عن ثقتك في القراءة بصدق؛ النص الزخرفي الملتبس يعني ثقة منخفضة.`;

// ---------- التطبيع والمطابقة ----------
const norm = (s) =>
  (s || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0621-\u064A0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokens = (s) => norm(s).split(' ').filter(Boolean);

function dice(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  const setB = new Map();
  B.forEach((t) => setB.set(t, (setB.get(t) || 0) + 1));
  let inter = 0;
  A.forEach((t) => {
    if (setB.get(t) > 0) { inter++; setB.set(t, setB.get(t) - 1); }
  });
  return (2 * inter) / (A.length + B.length);
}

// هل كلمات المنشور متتابعة بعينها داخل لفظ المصدر؟ (منشور مقتطع من حديث أطول)
// أربع كلمات متتابعة في أي موضع من اللفظ، أو ثلاث إن كانت أول اللفظ (المنشور يقتبس مطلع الحديث).
const PARTIAL_MIN_TOKENS = 4;
const PREFIX_MIN_TOKENS = 3;
function containsRun(text, matn) {
  const A = tokens(text), B = tokens(matn);
  if (A.length < PREFIX_MIN_TOKENS || A.length >= B.length) return false;
  if (A.length < PARTIAL_MIN_TOKENS) return A.every((t, j) => B[j] === t);
  for (let i = 0; i + A.length <= B.length; i++) {
    let ok = true;
    for (let j = 0; j < A.length; j++) if (B[i + j] !== A[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function bestMatch(text) {
  let best = null;
  for (const e of DB.entries) {
    const s = dice(text, e.matn);
    if (!best || s > best.score) best = { entry: e, score: s };
  }
  if (best && best.score >= MATCH_CLOSE) {
    if (containsRun(text, best.entry.matn)) best.partial = true;
    return best;
  }
  // لا تقارب كافياً: نبحث عن لفظ يحوي نص المنشور حرفياً متتابعاً، ونختار أقصرها
  let part = null;
  for (const e of DB.entries) {
    if (containsRun(text, e.matn) && (!part || tokens(e.matn).length < tokens(part.entry.matn).length)) {
      part = { entry: e, score: dice(text, e.matn), partial: true };
    }
  }
  return part || best;
}

// ألفاظ أخرى للحديث نفسه: ما ربطه المراجع في حقل related أولاً، ثم الأقرب مطابقةً.
// يُعرض اللفظ وحده دون حكمه، لأن لكل لفظ حكمه.
const MAX_RELATED = 3;
function relatedEntries(entry, text) {
  const out = [];
  const seen = new Set([entry.id]);
  for (const r of entry.related || []) {
    const id = (String(r).match(/^V\d+/) || [])[0];
    const e = id && DB.entries.find((x) => x.id === id);
    if (e && !seen.has(e.id)) { seen.add(e.id); out.push({ id: e.id, matn: e.matn }); }
  }
  const near = DB.entries
    .filter((e) => !seen.has(e.id))
    .map((e) => ({ e, s: dice(text, e.matn) }))
    .filter((x) => x.s >= MATCH_CLOSE)
    .sort((a, b) => b.s - a.s);
  for (const x of near) {
    if (out.length >= MAX_RELATED) break;
    seen.add(x.e.id); out.push({ id: x.e.id, matn: x.e.matn });
  }
  return out;
}

function buildCard(claim) {
  const base = {
    type: claim.type,
    post_text: claim.text,
    publisher_grade: claim.publisher_grade || null,
    cited_reference: claim.cited_reference || null,
    attributed_to: claim.attributed_to || null,
    reading_warning: claim.reading_warning || null,
  };

  if (claim.type === 'معلومة') return null; // لا بطاقة

  if (claim.type === 'حكم فقهي') {
    // القاعدة هي الفيصل لا تصنيف النموذج: إن طابق النص مدخلاً حديثياً في القاعدة عُرضت بطاقته.
    const fm = bestMatch(claim.text);
    const fe = fm && (fm.score >= MATCH_CLOSE || fm.partial) ? fm.entry : null;
    const usable = fe && fe.entry_type !== 'حكم فقهي' &&
      ((fe.verdicts || []).length || (fe.takhrij_no_verdict || []).length);
    if (!usable) {
      return { ...base, state: 'out_of_scope',
        note: 'هذا حكم فقهي، والتحقق منه خارج نطاق الأداة، يُرجع فيه إلى جهة مؤهلة.' };
    }
    claim = { ...claim, type: fe.entry_type || 'حديث' };
    base.type = claim.type;
  }

  if (claim.type === 'آية') return quranCard(base, claim.text, !!claim.from_image);

  const m = bestMatch(claim.text);
  const scope = `بُحث في قاعدة الأحكام الموثقة لدى الأداة (${DB.entries.length} مدخلاً). غياب النتيجة لا يعني عدم صحة النص.`;

  if (!m || (m.score < MATCH_CLOSE && !m.partial)) {
    return { ...base, state: 'not_found', scope,
      note: 'لم يُعثر على مرجع، يُحال إلى مختص.' };
  }

  const e = m.entry;
  const exact = !m.partial && m.score >= MATCH_EXACT;
  const hasVerdicts = Array.isArray(e.verdicts) && e.verdicts.length > 0;

  if (!hasVerdicts && !(e.takhrij_no_verdict || []).length) {
    return { ...base, state: 'not_found', scope,
      note: 'لم يُعثر على مرجع، يُحال إلى مختص.' };
  }

  return {
    ...base,
    similar_entries: relatedEntries(e, claim.text),
    partial: !!m.partial,
    state: hasVerdicts ? (exact ? 'found_verdict' : 'found_different') : 'found_no_verdict',
    entry_id: e.id,
    entry_type: e.entry_type || 'حديث',
    source_text: e.matn,
    score: Math.round(m.score * 100) / 100,
    verdicts: (e.verdicts || []).map((v) => ({
      by: v.by, book: v.book, location: v.location, text: v.text,
      // «يُفتح للتأكيد»: النص من نتيجة بحث لم تُفتح صفحته بعد
      unconfirmed: /يُفتح للتأكيد/.test(v.read || ''),
    })),
    takhrij_no_verdict: (e.takhrij_no_verdict || []).map((t) => ({
      book: t.book, location: t.location, takhrij_only: t.takhrij_only,
    })),
    authentic_alternative: e.authentic_alternative || null,
    scope,
    caution: hasVerdicts ? null
      : 'لم يرد حكم منقول في المصادر المعتمدة لدى الأداة، فلا يُعتمد على هذه البطاقة في نسبته إلى النبي ﷺ، يُحال إلى مختص.',
  };
}

// ---------- بطاقة الآية (البند 8.1) ----------
const QURAN_SCOPE = 'بُحث في نص القرآن الكريم بثماني روايات من نصوص مجمع الملك فهد لطباعة المصحف الشريف كما في الموسوعة القرآنية (Quranpedia.net): حفص وشعبة عن عاصم، وورش وقالون عن نافع، والدوري والسوسي عن أبي عمرو، والبزي وقنبل عن ابن كثير. وما لم يطابقها يُراجَع مع مختص في القراءات.';
const QURAN_PREFIX_RE = /^\s*(?:(?:و?قال|يقول)\s+(?:الله|ربنا|الحق)?\s*(?:تعالى|تبارك\s+وتعالى|عز\s+وجل|سبحانه(?:\s+وتعالى)?|جل\s+(?:وعلا|جلاله))?\s*(?:في\s+(?:كتابه|محكم\s+(?:كتابه|التنزيل))(?:\s+الكريم|\s+العزيز)?)?\s*[:：،]?\s*)?(?:أعوذ\s+بالله\s+من\s+الشيطان\s+الرجيم\s*)?(?:بسم\s+الله\s+الرحمن\s+الرحيم\s*)?/;
function stripQuranWrap(text) {
  let t = String(text || '');
  let attributed = null;
  const m = t.match(QURAN_PREFIX_RE);
  if (m && m[0].trim()) { attributed = m[0].trim().replace(/[:：،]$/, '').trim(); t = t.slice(m[0].length); }
  t = t.replace(/\s*صدق\s+الله\s+(?:العظيم|العلي\s+العظيم)\s*\.?\s*$/, '')
    .replace(/[﴿﴾«»"“”()\[\]{}]/g, ' ')
    .replace(/[\s(]*\[?\s*[^\s\]]+\s*:\s*[0-9٠-٩]+(?:\s*[-–]\s*[0-9٠-٩]+)?\s*\]?\s*$/, '') // [البقرة: 255]
    .trim();
  return { text: t, attributed };
}

const locText = (l) => l.cross_sura ? `${l.sura} ${l.from} وما بعدها` : (l.from === l.to ? `${l.sura}: ${l.from}` : `${l.sura}: ${l.from}–${l.to}`);
const joinAr = (a) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join('، ') + ' و' + a[a.length - 1];

// تجميع الروايات حسب موضع الآية (لاختلاف عدّ الآي بين الروايات)
function groupLocations(results) {
  const g = new Map();
  for (const r of results) {
    const k = locText(r.best);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r.name);
  }
  return [...g.entries()].map(([where, names]) => ({ where, riwayat: names }));
}

// fromImage: النص مقروء من صورة. ثبت في الاختبار (5 أكتوبر) أن النموذج قد يكتب تشكيل الآية المعتاد من حفظه
// بدل ما في الصورة، فلا تُبنى تسمية الرواية على تشكيل مقروء من صورة، ويُكتفى بالمطابقة على الرسم.
function quranCard(base, rawText, fromImage = false) {
  const { text, attributed } = stripQuranWrap(rawText);
  if (attributed && !base.attributed_to) base.attributed_to = attributed;
  let m;
  try { m = quran.match(text); }
  catch (e) { console.error('مسار القرآن:', e.message); return { ...base, state: 'not_found', scope: QURAN_SCOPE, note: 'تعذّرت مطابقة الآية في هذه المحاولة.' }; }

  if (m.kind === 'too_short') {
    return { ...base, state: 'not_found', scope: QURAN_SCOPE,
      note: 'النص أقصر من أن يُطابَق بآية بعينها. ألصق الآية كاملة.' };
  }
  if (m.kind === 'none') {
    return { ...base, state: 'not_found', scope: QURAN_SCOPE, note: 'لم يُعثر على مرجع، يُحال إلى مختص.' };
  }
  if (m.kind === 'different') {
    return { ...base, state: 'quran_different', scope: QURAN_SCOPE,
      quran: { summary: 'لم يطابق نص المنشور أياً من الروايات المعتمدة في الأداة، وأقرب نص إليه:',
        source: { riwaya: m.riwaya, riwaya_name: m.riwaya_name, where: locText(m.location), sura_no: m.location.sura_no, text: m.source_text },
        diff: m.diff },
      caution: 'تغطي الأداة ثماني روايات فقط؛ فما لم يطابقها يُراجَع مع مختص في القراءات. والفرق المعروض فرق في اللفظ عن أقرب نص، لا حكم على المنشور.' };
  }

  const byKey = Object.fromEntries(m.results.map((r) => [r.key, r]));
  const occ = Math.max(...m.results.map((r) => r.occurrences));
  const repeated = occ > 1 ? `ورد هذا اللفظ في ${occ} مواضع من القرآن، ويُعرض أولها.` : null;

  // التنبيه الخاص بالصورة يُقصر على الآية المشكولة؛ غير المشكولة تأخذ عبارة «دون تشكيل» المعتادة
  const imageVocal = fromImage && (m.kind === 'vocal_none' || m.vocalized);
  if (imageVocal) { m.kind = 'match'; m.vocalized = false; }

  if (m.kind === 'vocal_none') {
    const near = byKey[m.nearest];
    return { ...base, state: 'quran_different', scope: QURAN_SCOPE,
      quran: { summary: 'يوافق رسمُ النص (حروفه دون تشكيل) آيةً في المصحف، لكن تشكيله لم يطابق أياً من الروايات المعتمدة في الأداة، وأقرب نص إليه:',
        source: { riwaya: near.key, riwaya_name: near.name, where: locText(near.best), sura_no: near.best.sura_no, text: near.source_text },
        word_diffs: near.diff_words, repeated },
      caution: 'تغطي الأداة ثماني روايات فقط؛ فما لم يطابقها يُراجَع مع مختص في القراءات. وقد يكون الفرق من قراءة التشكيل في الصورة، فقارنه بالأصل.' };
  }

  // وُجد
  const groups = groupLocations(m.results);
  let summary, shown, agreeing = null, others = null;
  if (m.imlaei_only) {
    summary = `يوافق الآية (${locText(m.results[0].best)}) في رواية حفص عن عاصم بالرسم الإملائي. ولا يمكن تحديد الرواية دون تشكيل.`;
    shown = m.results[0];
  } else if (!m.vocalized && imageVocal) {
    summary = 'يوافق رسم الآية في الروايات المعتمدة. ولا تُحدَّد الرواية من الصورة، لأن قراءة التشكيل من الصور غير مضمونة؛ لتحديدها الصق نص الآية مشكولاً كما في المنشور.';
    shown = byKey.hafs || m.results[0];
  } else if (!m.vocalized) {
    summary = 'يوافق رسم الآية في الروايات المعتمدة، ولا يمكن تحديد الرواية دون تشكيل.';
    shown = byKey.hafs || m.results[0];
  } else {
    agreeing = m.agree.map((k) => byKey[k].name);
    summary = agreeing.length === quran.ORDER.length ? 'موافق للروايات الثماني المعتمدة في الأداة.' : `موافق لرواية ${joinAr(agreeing)}.`;
    if (!m.agree.includes('hafs')) summary += ' ويخالف رواية حفص عن عاصم، والفرق فرق روايات لا خطأ.';
    shown = byKey[m.agree.includes('hafs') ? 'hafs' : m.agree[0]];
    others = m.results.filter((r) => !m.agree.includes(r.key))
      .map((r) => ({ riwaya_name: r.name, word_diffs: (r.diff_words || []).slice(0, 4) }));
  }
  return { ...base, state: 'quran_found', scope: QURAN_SCOPE,
    quran: { summary, groups, agreeing, repeated,
      missing: m.missing && m.missing.length ? m.missing : null,
      source: { riwaya: shown.key, riwaya_name: shown.name, where: locText(shown.best), sura_no: shown.best.sura_no, text: shown.source_text },
      others } };
}

// نص ملصق كله آية أو آيات (حروفه متصلة في المصحف): بطاقة مباشرة دون نموذج
const QURAN_DIRECT_MIN = 15;
function directQuran(raw) {
  const { text } = stripQuranWrap(raw);
  if (quran.skeletonOnly(text).length < QURAN_DIRECT_MIN) return null;
  let m;
  try { m = quran.match(text); } catch { return null; }
  if (m.kind !== 'match' && m.kind !== 'vocal_none') return null;
  return buildCard({ type: 'آية', text: raw });
}

// ---------- المطابقة المباشرة دون نموذج ----------
// تُزال صيغة النسبة في أول النص («قال رسول الله ﷺ:» ونحوها) وعلامات الاقتباس، ثم يُطابَق الباقي.
const ATTRIB_RE = /^\s*((?:عن\s+[^:،]{1,40}?\s+قال\s*[:：،,]?\s*)?(?:قال|يقول|وقال)\s+(?:رسول\s+الله|النبي|نبي\s+الله)\s*(?:ﷺ|صلى\s+الله\s+عليه\s+وسلم|\(ﷺ\))?)\s*[:：]?\s*/;
const DIRECT_MAX_TOKENS = 60;
function directMatch(raw) {
  let text = String(raw || '').trim();
  let attributed = null;
  const am = text.match(ATTRIB_RE);
  if (am) { attributed = am[1].trim(); text = text.slice(am[0].length); }
  text = text.replace(/^[\s«"“(]+|[\s»"”).]+$/g, '').trim();
  const n = tokens(text).length;
  if (!n || n > DIRECT_MAX_TOKENS) return null;
  const m = bestMatch(text);
  if (!m || !(m.partial || m.score >= MATCH_EXACT)) return null;
  const type = m.entry.entry_type || 'حديث';
  const card = buildCard({ type, text, attributed_to: attributed });
  return card && card.entry_id ? card : null;
}

// ---------- الطبقة الثانية: الموسوعة الحديثية (الدرر السنية) ----------
// لا تُخزَّن النتائج ولا تُنسخ القاعدة: استعلام حيّ عند كل طلب، والعرض بنص الموسوعة كما هو.
const stripTags = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// يُرسل النص دون تشكيل وعلامات، مع إبقاء الحروف كما هي (التطبيع الكامل يغيّر الحروف فيُفسد البحث)
const dorarQuery = (s) => String(s || '')
  .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
  .replace(/[^\u0621-\u064A0-9\s]/g, ' ')
  .split(/\s+/).filter(Boolean).slice(0, DORAR_QUERY_WORDS).join(' ');

function parseDorar(html) {
  const out = [];
  const blocks = String(html || '').split(/<div class="hadith"[^>]*>/).slice(1);
  for (const b of blocks) {
    const end = b.indexOf('</div>');
    const matn = stripTags(b.slice(0, end)).replace(/^\d+\s*-\s*/, '').replace(/\s*\.$/, '').trim();
    const info = {};
    const re = /<span class="info-subtitle">\s*([^<:]+?)\s*:\s*<\/span>([\s\S]*?)(?=<span class="info-subtitle">|<\/div>)/g;
    let m;
    while ((m = re.exec(b))) info[m[1].trim()] = stripTags(m[2]);
    if (matn) out.push({
      matn,
      rawi: info['الراوي'] || null,
      muhaddith: info['المحدث'] || null,
      book: info['المصدر'] || null,
      location: info['الصفحة أو الرقم'] || null,
      grade: info['خلاصة حكم المحدث'] || null,
    });
  }
  return out;
}

const dorarCache = new Map(); // ذاكرة مؤقتة داخل الدالة الواحدة فقط (لا تُخزَّن النصوص بين الجلسات)
async function dorarOnce(q, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${DORAR_API}?skey=${encodeURIComponent(q)}`, {
      signal: ctrl.signal,
      headers: { 'accept': 'application/json', 'accept-language': 'ar', 'user-agent': 'Mozilla/5.0 (compatible; musnid-ai hackathon)' } });
    if (!res.ok) return { error: `http ${res.status}` };
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { return { error: 'غير JSON: ' + raw.slice(0, 60).replace(/\s+/g, ' ') }; }
    return { q, results: parseDorar(data && data.ahadith && data.ahadith.result) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'time' : 'net: ' + (e.cause && e.cause.code || e.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function dorarSearch(text, timeoutMs, deadline) {
  const q = dorarQuery(text);
  if (!q || timeoutMs < 800) return { error: 'time' };
  if (dorarCache.has(q)) return dorarCache.get(q);
  let r = await dorarOnce(q, timeoutMs);
  // محاولة ثانية بعد مهلة قصيرة إن بقي وقت (ازدحام عارض أو تحديد معدل الطلبات)
  if (r.error && r.error !== 'time' && deadline && deadline - Date.now() > 1800) {
    await new Promise((ok) => setTimeout(ok, 600));
    r = await dorarOnce(q, Math.min(4000, deadline - Date.now()));
  }
  if (!r.error) dorarCache.set(q, r);
  return r;
}

// يُبقي من نتائج الموسوعة ما يطابق نص الادعاء فعلاً (لا كل ما يحوي كلماته متفرقة)،
// ولكل لفظ حكمه: لا يُنقل حكم لفظ إلى لفظ آخر.
function dorarMatches(text, results) {
  return results
    .map((r) => {
      const s = dice(text, r.matn);
      const within = containsRun(text, r.matn);      // المنشور مقتطع من لفظ الموسوعة
      const covers = containsRun(r.matn, text);      // لفظ الموسوعة جزء من المنشور
      return { ...r, score: Math.round(s * 100) / 100, same_wording: s >= MATCH_EXACT,
        within, ok: s >= MATCH_CLOSE || within || covers };
    })
    .filter((r) => r.ok && r.grade)
    .sort((a, b) => b.score - a.score)
    .slice(0, DORAR_MAX_SHOWN)
    .map(({ ok, ...r }) => r);
}

const DORAR_TYPES = new Set(['حديث', 'قول منسوب']);
async function enrichWithDorar(cards, deadline) {
  if (!DORAR_ENABLED) return;
  const todo = cards.filter((c) => c && c.state === 'not_found' && DORAR_TYPES.has(c.type));
  await Promise.all(todo.map(async (c) => {
    const r = await dorarSearch(c.post_text, Math.min(4000, deadline - Date.now()), deadline);
    const link = `https://dorar.net/hadith/search?q=${encodeURIComponent(dorarQuery(c.post_text))}`;
    if (r.error) {
      c.scope += ` وتعذّر البحث في الموسوعة الحديثية بالدرر في هذه المحاولة (${r.error}).`;
      c.dorar_link = link;
      c.dorar_failed = true;
      c.note = 'تعذّر الاتصال بالموسوعة الحديثية (الدرر) الآن، وليس معنى هذا أن الحديث لا مرجع له. افتح رابط البحث أدناه، أو أعد المحاولة بعد قليل.';
      return;
    }
    const hits = dorarMatches(c.post_text, r.results);
    c.dorar_link = link;
    if (!hits.length) {
      c.scope += ' وبُحث كذلك في الموسوعة الحديثية بالدرر السنية فلم يُعثر على لفظ مطابق.';
      return;
    }
    c.state = 'found_dorar';
    c.dorar = hits;
    c.note = null;
    c.scope = `لم يوجد في قاعدة الأحكام الموثقة لدى الأداة (${DB.entries.length} مدخلاً)، فبُحث في الموسوعة الحديثية بالدرر السنية، وتُعرض الألفاظ المطابقة وحدها.`;
    c.caution = 'منقول بواسطة الموسوعة الحديثية بالدرر السنية، ولم تُراجَع المصادر الأصلية بعد. «خلاصة حكم المحدث» من صياغة الموسوعة، وقد لا تكون لفظ المحدّث بعينه. ولكل لفظ حكمه، فلا يُنقل حكم لفظ إلى غيره.';
  }));
}

// نص ملصق قصير لم يوجد في القاعدة: إن طابق لفظاً في الموسوعة بتمامه (أو كان مقتطعاً منه)
// فهو حديث واحد، فتُعرض بطاقته دون استدعاء النموذج (توفيراً لحصة النموذج المحدودة).
async function directDorar(raw, deadline, requireWhole = true) {
  if (!DORAR_ENABLED) return null;
  let text = String(raw || '').trim();
  let attributed = null;
  const am = text.match(ATTRIB_RE);
  if (am) { attributed = am[1].trim(); text = text.slice(am[0].length); }
  text = text.replace(/^[\s«"“(]+|[\s»"”).]+$/g, '').trim();
  const n = tokens(text).length;
  if (n < PREFIX_MIN_TOKENS || n > DIRECT_MAX_TOKENS) return null;
  const card = buildCard({ type: 'حديث', text, attributed_to: attributed });
  if (!card || card.state !== 'not_found') return null;
  await enrichWithDorar([card], deadline);
  if (card.state !== 'found_dorar') return null;
  if (requireWhole && !card.dorar.some((r) => r.same_wording || r.within)) return null;
  return card;
}

// ---------- الاستدعاء (Gemini، ثم Claude احتياطاً، أو بالترتيب في MODEL_ORDER) ----------
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function parseModelJson(data) {
  const cands = data.candidates || [];
  if (!cands.length) {
    const why = (data.promptFeedback && data.promptFeedback.blockReason) || 'غير معروف';
    throw new ApiError(`لم يُرجع المزوّد نتيجة (السبب: ${why})`, 502);
  }
  const txt = ((cands[0].content && cands[0].content.parts) || []).map((p) => p.text || '').join('').trim();
  const clean = txt.replace(/```json|```/g, '').trim();
  // سبب التوقف وطول الرد وآخره يُسجَّلان لتشخيص الردود المقطوعة (لا يُسجَّل نص المنشور كاملاً)
  const why = `[finish=${cands[0].finishReason || '?'} len=${txt.length} tail=${JSON.stringify(txt.slice(-60))} usage=${JSON.stringify(data.usageMetadata || {})}]`;
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new ApiError(`رد المزوّد ليس JSON صالحاً ${why}`, 502);
  try { return JSON.parse(clean.slice(s, e + 1)); }
  catch { throw new ApiError(`رد المزوّد ليس JSON صالحاً ${why}`, 502); }
}

// تعيد قائمة مشكلات بنيوية؛ لا نصلح شيئاً بصمت.
function validateEx(ex) {
  if (!ex || typeof ex !== 'object') return ['الرد ليس كائناً'];
  const p = [];
  if (typeof ex.readable !== 'boolean') p.push('readable');
  if (typeof ex.confidence !== 'number' || ex.confidence < 0 || ex.confidence > 1) p.push('confidence');
  if (!Array.isArray(ex.claims)) { p.push('claims'); return p; }
  ex.claims.forEach((c, i) => {
    if (!c || !ALLOWED_TYPES.has(c.type)) p.push(`نوع الادعاء ${i + 1}`);
    if (!c || typeof c.text !== 'string' || !c.text.trim()) p.push(`نص الادعاء ${i + 1}`);
  });
  return p;
}

// ---------- Claude (Anthropic): مزوّد ثانٍ بالتعليمات نفسها ومخطط الرد نفسه ----------
// يُفعَّل بوجود ANTHROPIC_API_KEY، ويُتخطّى دونه. النماذج بالمتغير CLAUDE_MODEL (مفصولة بفواصل).
const CLAUDE_MODELS = (process.env.CLAUDE_MODEL || 'claude-sonnet-5-5')
  .split(',').map((s) => s.trim()).filter(Boolean);
// ترتيب المزوّدين: MODEL_ORDER=gemini,claude (الافتراضي) أو claude,gemini
// الافتراضي Claude ثم Gemini، بناءً على مقارنة 5 أكتوبر على صور الاختبار الـ24 (docs/model_comparison.md)
const PROVIDER_ORDER = (process.env.MODEL_ORDER || 'claude,gemini')
  .split(',').map((s) => s.trim().toLowerCase()).filter((p) => p === 'gemini' || p === 'claude');
// وقت يُحجز للمزوّد التالي حتى لا يستهلك الأول المهلة كلها
// إن بدأ الترتيب بـ Gemini يُحجز لـ Claude 10 ث؛ وإن بدأ بـ Claude فلا حجز (قراءته للصور تأخذ 8–20 ث)، ويُجرَّب Gemini فيما بقي.
const PROVIDER_RESERVE_MS = Number.isFinite(Number(process.env.PROVIDER_RESERVE_MS)) && process.env.PROVIDER_RESERVE_MS !== undefined && process.env.PROVIDER_RESERVE_MS !== ''
  ? Number(process.env.PROVIDER_RESERVE_MS) : (PROVIDER_ORDER[0] === 'gemini' ? 10000 : 0);
const CLAUDE_FALLBACK_STATUS = new Set([400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504, 529]);

const providerAvailable = (p) => p === 'gemini' ? !!process.env.GEMINI_API_KEY : !!process.env.ANTHROPIC_API_KEY;

function parseClaudeJson(data) {
  const why = `[stop=${data.stop_reason || '?'} usage=${JSON.stringify(data.usage || {})}]`;
  if (data.stop_reason === 'refusal') throw new ApiError(`امتنع النموذج عن الطلب ${why}`, 502);
  if (data.stop_reason === 'max_tokens') throw new ApiError(`رد النموذج مقطوع ${why}`, 502);
  const txt = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
  const clean = txt.replace(/```json|```/g, '');
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  try { return JSON.parse(a >= 0 && b > a ? clean.slice(a, b + 1) : clean); }
  catch { throw new ApiError(`رد المزوّد ليس JSON صالحاً ${why}`, 502); }
}

// مخطط الرد الإلزامي (structured outputs): تُلزَم به الإجابة نصاً بصيغة JSON.
// ملاحظة: Sonnet 5.5 وأمثاله لا يقبلون فرض أداة بعينها (tool_choice) ويردّون 400، فيُستعمل output_config بدلها.
const NULLABLE_STR = { type: ['string', 'null'] };
const CLAUDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'confidence', 'full_text', 'claims'],
  properties: {
    readable: { type: 'boolean' },
    confidence: { type: 'number', description: 'من 0 إلى 1' },
    full_text: { type: 'string' },
    claims: { type: 'array', items: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'text', 'uncertain', 'publisher_grade', 'cited_reference', 'attributed_to'],
      properties: {
        type: { type: 'string', enum: [...ALLOWED_TYPES] },
        text: { type: 'string' },
        uncertain: { type: 'boolean' },
        publisher_grade: NULLABLE_STR,
        cited_reference: NULLABLE_STR,
        attributed_to: NULLABLE_STR,
      } } },
  },
};

// محاولة واحدة لنموذج Claude؛ تعيد { ok, ex } أو { status, error }
async function callClaude(model, { text, image, mediaType }, timeoutMs, withSchema = true) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } });
  content.push({ type: 'text', text: image
    ? 'اقرأ هذا المنشور واستخرج الادعاءات وفق التعليمات.'
    : `استخرج ادعاءات هذا المنشور وفق التعليمات:\n\n${text}` });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: Number(process.env.CLAUDE_MAX_TOKENS) || 16000,
        system: SYSTEM,
        ...(withSchema ? { output_config: { format: { type: 'json_schema', schema: CLAUDE_SCHEMA } } } : {}),
        messages: [{ role: 'user', content }],
      }) });
    if (!res.ok) {
      let detail = '';
      // نوع الخطأ ورسالته من Anthropic (لا تحوي المفتاح) لتشخيص الرفض في السجل
      try { const j = await res.json(); detail = j.error ? `${j.error.type || ''}: ${String(j.error.message || '').slice(0, 200)}` : ''; } catch { /* لا شيء */ }
      return { status: res.status, error: `${res.status}${detail ? ' ' + detail : ''} من ${model}` };
    }
    try { return { ok: true, ex: parseClaudeJson(await res.json()) }; }
    catch (e) { if (e instanceof ApiError) { console.error(e.message, model); return { status: 0, error: `رد غير صالح من ${model}` }; } throw e; }
  } catch (err) {
    return { status: -1, abort: err.name === 'AbortError', error: `تعذّر الاتصال أو انتهت المهلة (${model})` };
  } finally {
    clearTimeout(timer);
  }
}

async function extract(input, hardDeadline) {
  const { text, image, mediaType } = input;
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: mediaType, data: image } });
  parts.push({ text: image
    ? 'اقرأ هذا المنشور واستخرج الادعاءات وفق التعليمات.'
    : `استخرج ادعاءات هذا المنشور وفق التعليمات:\n\n${text}` });

  // مخطط إلزامي للرد: يمنع JSON المكسور في المنشورات الطويلة متعددة الادعاءات (ثبت في P06، 5 أكتوبر)
  const STR = { type: 'STRING' }, NSTR = { type: 'STRING', nullable: true };
  const gen = { responseMimeType: 'application/json', maxOutputTokens: 32768,
    responseSchema: { type: 'OBJECT', required: ['readable', 'confidence', 'full_text', 'claims'],
      properties: { readable: { type: 'BOOLEAN' }, confidence: { type: 'NUMBER' }, full_text: STR,
        claims: { type: 'ARRAY', items: { type: 'OBJECT', required: ['type', 'text', 'uncertain'],
          properties: { type: { type: 'STRING', enum: [...ALLOWED_TYPES] }, text: STR, uncertain: { type: 'BOOLEAN' },
            publisher_grade: NSTR, cited_reference: NSTR, attributed_to: NSTR } } } } } };
  // اتركها غير مضبوطة ليبقى الافتراضي عند المزوّد؛ تُضبط من متغيرات البيئة عند الحاجة.
  if (process.env.GEMINI_TEMPERATURE) gen.temperature = Number(process.env.GEMINI_TEMPERATURE);
  if (process.env.GEMINI_THINKING_LEVEL) gen.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };
  const makeBody = (g) => JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: g,
  });
  let body = makeBody(gen);
  let schemaOn = true;

  const deadline = Math.min(Date.now() + TIME_BUDGET_MS, hardDeadline || Infinity);
  // input.only: مزوّد واحد بعينه لاختبار المقارنة (يُسمح به برمز TEST_TOKEN فقط، انظر handler)
  const providers = (input.only ? [input.only] : PROVIDER_ORDER).filter(providerAvailable);
  let last = 'لا نموذج متاح';
  let tried = 0; // عدد النماذج التي جُرّبت فعلاً
  let busy = 0; // عدد النماذج التي ردّت بازدحام أو نفاد حصة (429/503/529)
  let recitation = 0; // عدد النماذج التي امتنعت عن نسخ النص (finishReason=RECITATION)
  let rejected = 0; // رفض صريح للطلب (لا ازدحام ولا مهلة)
  // رد صالح لكنه «غير مقروء» أو منخفض الثقة: يُحفظ، ويُجرَّب المزوّد التالي إن بقي وقت؛ فإن لم يأتِ أفضل منه عُرض هو.
  let weak = null;
  const isWeak = (ex) => ex && (ex.readable === false || typeof ex.confidence !== 'number' || ex.confidence < OCR_CONFIDENCE_MIN);
  const accept = (ex, model, pi) => {
    if (!isWeak(ex) || pi >= providers.length - 1 || deadline - Date.now() < 4000) return { ex, model };
    if (!weak || (ex.confidence || 0) > (weak.ex.confidence || 0)) weak = { ex, model };
    console.error('رد منخفض الثقة، يُجرَّب المزوّد التالي:', model, ex.confidence);
    return null;
  };

  for (let pi = 0; pi < providers.length; pi++) {
    const provider = providers[pi];
    // إن بقي مزوّد بعده يُحجز له وقت، ما لم يكن الباقي أقل من أن يُقسم
    const laterExists = pi < providers.length - 1;
    const softDeadline = () => {
      const remaining = deadline - Date.now();
      return laterExists && remaining > PROVIDER_RESERVE_MS + 4000 ? deadline - PROVIDER_RESERVE_MS : deadline;
    };

    if (provider === 'claude') {
      for (const model of CLAUDE_MODELS) {
        const remaining = softDeadline() - Date.now();
        if (remaining < 1500) { last = 'انتهت المهلة'; break; }
        tried++;
        let r = await callClaude(model, input, remaining);
        // إن رُفض مخطط الرد (400) يُعاد الطلب دونه مرة واحدة، ويبقى الرد مقيداً بتعليمات JSON في SYSTEM
        if (!r.ok && r.status === 400 && softDeadline() - Date.now() > 3000) {
          console.error('Claude: رُفض مخطط الرد، يُعاد الطلب دونه:', r.error);
          r = await callClaude(model, input, softDeadline() - Date.now(), false);
        }
        if (r.ok) { const a = accept(r.ex, model, pi); if (a) return a; break; }
        console.error('Claude:', r.error);
        last = r.error;
        if (r.status === 429 || r.status === 529 || r.status === 503) busy++;
        if (r.abort) break;
        if (r.status > 0 && ![429, 500, 502, 503, 504, 529].includes(r.status)) rejected++;
        if (r.status > 0 && !CLAUDE_FALLBACK_STATUS.has(r.status)) break;
      }
      continue;
    }

    // Gemini
    for (let mi = 0; mi < MODELS.length; mi++) {
      const model = MODELS[mi];
      const remaining = softDeadline() - Date.now();
      if (remaining < 1500) { last = 'انتهت المهلة'; break; }
      tried++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), remaining);
      try {
        // المفتاح في الترويسة لا في الرابط، فلا يظهر في أي رسالة خطأ
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          { method: 'POST', signal: ctrl.signal,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body });
        if (res.ok) {
          // رد غير صالح من نموذج: يُجرَّب النموذج التالي بدل إيقاف الطلب
          try { const a = accept(parseModelJson(await res.json()), model, pi); if (a) return a; break; }
          catch (e) { if (e instanceof ApiError) { console.error(e.message, model); if (/RECITATION/.test(e.message)) recitation++; last = `رد غير صالح من ${model}`; continue; } throw e; }
        }
        // إن رفض المزوّد المخطط (400) يُعاد الطلب نفسه دون مخطط، فلا يتعطل الموقع بسببه
        if (res.status === 400 && schemaOn) {
          console.error('رُفض مخطط الرد، يُعاد الطلب دونه', model);
          schemaOn = false;
          const { responseSchema, ...rest } = gen;
          body = makeBody(rest);
          tried--; mi--; continue;
        }
        if (res.status === 429 || res.status === 503) busy++;
        last = `${res.status} من ${model}`;
        // أي رفض آخر من Gemini: يُترك للنموذج التالي أو للمزوّد التالي بدل إيقاف الطلب
        if (!FALLBACK_STATUS.has(res.status)) { console.error('Gemini:', last); rejected++; break; }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        last = `تعذّر الاتصال أو انتهت المهلة (${model})`;
        if (err.name === 'AbortError') break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (weak) return weak;
  // امتناع المزوّد عن نسخ نص منتشر في الإنترنت: يُعرض للمستخدم سببه الحقيقي
  if (recitation > 0) throw new ApiError(`امتنع المزوّد عن نسخ النص (RECITATION): ${last}`, 422);
  if (rejected > 0 && rejected === tried) throw new ApiError(`رفض المزوّد الطلب: ${last}`, 502);
  if (busy > 0 && busy === tried) throw new ApiError(`كل النماذج مزدحمة أو بلغت حصتها: ${last}`, 503);
  throw new ApiError(`فشلت كل النماذج. آخر مشكلة: ${last}`, 504);
}

// ---------- تقسيم محلي دون نموذج ----------
// يُقسَّم النص بالأسطر والترقيم وما بين علامات التنصيص، ويُطابَق كل مقطع مع القاعدة والمصحف.
// لا تُعرض بطاقة لمقطع لم يطابق شيئاً (العناوين وأحكام الناشر ونحوها).
function localSplitCards(raw) {
  const text = String(raw || '');
  const segs = new Map(); // النص ← حكم الناشر إن وُجد
  const add = (s) => {
    let t = s.replace(/^[\s\-–—•*·\d٠-٩.:،]+/, '').trim();   // ترقيم في أول السطر
    let grade = null;
    // «(نص الحديث) ضعيف»: ما بعد القوس الأخير حكم الناشر، لا جزء من النص
    const m = t.match(/^(.*)[)\]»]\s*([^()\[\]«»]{1,30})$/);
    if (m && tokens(m[2]).length <= 4) { t = m[1]; grade = m[2].trim(); }
    t = t.replace(/^[\s(\[«"“]+|[\s)\]»"”.]+$/g, '').trim();
    if (tokens(t).length >= 2 && !segs.has(t)) segs.set(t, grade);   // الكلمتان تُقبلان بمطابقة تامة فقط (أدناه)
  };
  text.split(/\n+/).forEach(add);
  (text.match(/[«"“﴿][^«»"“”﴿﴾]{8,}[»"”﴾]/g) || []).forEach(add);
  const cards = [], seen = new Set();
  for (const [seg, grade] of segs) {
    let card = null;
    try { card = directQuran(seg); } catch { card = null; }
    if (!card) {
      const am = seg.match(ATTRIB_RE);
      const t = am ? seg.slice(am[0].length) : seg;
      const c = buildCard({ type: 'حديث', text: t, attributed_to: am ? am[1].trim() : null, publisher_grade: grade });
      if (c && c.entry_id && (tokens(t).length >= PREFIX_MIN_TOKENS || c.score >= MATCH_EXACT)) card = c;
    }
    const key = card && (card.entry_id || (card.quran && card.quran.source && card.quran.source.where));
    if (card && !seen.has(key)) { seen.add(key); cards.push(card); }
  }
  return cards;
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const t0 = Date.now();
  const deadline = t0 + TOTAL_BUDGET_MS;
  if (event.httpMethod !== 'POST') return reply(405, { error: 'الطريقة غير مدعومة' });
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) return reply(500, { error: 'لا مفتاح لمزوّد النموذج (GEMINI_API_KEY أو ANTHROPIC_API_KEY) في متغيرات البيئة' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'طلب غير صالح' }); }
  if (!body.text && !body.image) return reply(400, { error: 'أرسل نصاً أو صورة' });
  if (body.image) {
    if (typeof body.image !== 'string' || body.image.length > MAX_IMAGE_B64)
      return reply(413, { error: 'الصورة كبيرة جداً، صغّر حجمها وأعد المحاولة' });
    body.mediaType = ALLOWED_MIME.has(body.mediaType) ? body.mediaType : 'image/jpeg';
  }

  // نص ملصق يطابق مدخلاً في القاعدة مطابقة تامة أو يُحتوى فيه حرفياً: بطاقة مباشرة دون استدعاء النموذج.
  // اختبار المقارنة بين المزوّدين: يُفرض مزوّد واحد، وتُتخطّى المطابقة المباشرة، إن طابق الرمز متغير TEST_TOKEN في Netlify
  const only = process.env.TEST_TOKEN && body.test_token === process.env.TEST_TOKEN &&
    (body.provider === 'gemini' || body.provider === 'claude') ? body.provider : null;

  if (!body.image && !only) {
    const direct = directMatch(body.text);
    if (direct) return reply(200, { status: 'ok', confidence: 1, model_used: 'مطابقة مباشرة مع القاعدة (دون نموذج)', cards: [direct], skipped_info_claims: 0 });
    const dq = directQuran(body.text);
    if (dq) return reply(200, { status: 'ok', confidence: 1, model_used: 'مطابقة مباشرة مع نص المصحف (دون نموذج)', cards: [dq], skipped_info_claims: 0 });
    const viaDorar = await directDorar(body.text, Math.min(deadline, Date.now() + 3000));
    if (viaDorar) return reply(200, { status: 'ok', confidence: 1, model_used: 'بحث مباشر في الموسوعة الحديثية (دون نموذج)', cards: [viaDorar], skipped_info_claims: 0 });
  }

  try {
    // الصورة تُعالج في الذاكرة ولا تُخزَّن عندنا.
    const { ex, model } = await extract({ ...body, only }, deadline);

    const problems = validateEx(ex);
    if (problems.length) {
      console.error('مخرجات غير صالحة:', problems.join('، '));
      return reply(502, { error: 'تعذّر فهم رد النموذج. أعد المحاولة.' });
    }

    if (!ex.readable || ex.confidence < OCR_CONFIDENCE_MIN) {
      return reply(200, { status: 'unreadable',
        message: 'تعذّرت قراءة النص بوضوح، يُرجى إدخاله يدوياً.' });
    }

    // حماية من الإكمال من الذاكرة: الادعاء يجب أن يكون مقطعاً من النص المصدر.
    // في النص المُدخل نقارن بالمُدخل نفسه؛ وفي الصورة بما قرأه النموذج.
    const source = norm(body.image ? ex.full_text : body.text);
    ex.claims.forEach((c) => {
      const inSource = norm(c.text) && source.includes(norm(c.text));
      c.reading_warning = (c.uncertain || !inSource)
        ? 'قد لا يطابق هذا النص ما في المنشور حرفياً؛ قارنه بالأصل قبل الاعتماد على البطاقة.'
        : null;
      // «النسبة كما وردت في المنشور» يجب أن تكون في المنشور فعلاً (أضاف النموذج «الله عز وجل» لآية لم يُنسب فيها شيء)
      if (c.attributed_to && !source.includes(norm(c.attributed_to))) c.attributed_to = null;
    });

    const seen = new Set();
    const cards = ex.claims.map((c) => buildCard({ ...c, from_image: !!body.image })).filter(Boolean)
      .filter((c) => { const k = c.type + '|' + norm(c.post_text); if (seen.has(k)) return false; seen.add(k); return true; });
    await enrichWithDorar(cards, deadline);
    return reply(200, { status: 'ok', confidence: ex.confidence, model_used: model, elapsed_ms: Date.now() - t0, cards,
      skipped_info_claims: ex.claims.filter((c) => c.type === 'معلومة').length });
  } catch (err) {
    console.error(err.message);
    if (only) return reply(err.status || 502, { error: 'اختبار: ' + err.message });
    // نص ملصق تعذّر على النموذج تقسيمه: تُقسّمه الأداة بنفسها وتطابق كل مقطع مع القاعدة والمصحف دون نموذج.
    if (!body.image && err instanceof ApiError) {
      const local = localSplitCards(body.text);
      if (local.length) {
        return reply(200, { status: 'ok', confidence: 1, model_used: 'تقسيم محلي دون نموذج (تعذّر النموذج)', cards: local,
          skipped_info_claims: 0,
          notice: 'تعذّر تقسيم المنشور بالنموذج، فقسّمته الأداة بأسطره وعلامات تنصيصه، وتُعرض المقاطع التي طابقت قاعدة الأحكام أو المصحف وحدها؛ وما لم يطابق شيئاً لا تظهر له بطاقة.' });
      }
    }
    if (body.image && err instanceof ApiError && err.status === 422) {
      return reply(200, { status: 'recitation',
        message: 'امتنع مزوّد النموذج عن نسخ نص هذه الصورة، لأن نصها منتشر بكثرة في الإنترنت. انسخ نص المنشور والصقه في الخانة، فتقسّمه الأداة وتطابقه.' });
    }
    // إن تعذّر النموذج والنص قصير: نعرض ما يطابقه في الموسوعة إن وُجد، مع التنبيه.
    if (!body.image && err instanceof ApiError && (err.status === 503 || err.status === 504)) {
      const fb = await directDorar(body.text, deadline + 400, false).catch(() => null);
      if (fb) {
        fb.reading_warning = 'تعذّر تقسيم المنشور بالنموذج الآن، فبُحث عن النص كله بوصفه ادعاءً واحداً.';
        return reply(200, { status: 'ok', confidence: 1, model_used: 'الموسوعة الحديثية (النموذج مشغول)', cards: [fb], skipped_info_claims: 0 });
      }
    }
    if (err instanceof ApiError && err.status === 503)
      return reply(503, { error: 'الخدمة مشغولة الآن (بلغ مزوّد النموذج حدّه المؤقت). أعد المحاولة بعد دقيقة. ويمكنك لصق نص الحديث وحده، فيُطابَق مع القاعدة مباشرة دون الحاجة إلى النموذج.' });
    if (err instanceof ApiError && err.status === 504)
      return reply(504, { error: 'استغرق التحليل وقتاً أطول من المسموح. أعد المحاولة، وإن تكرر فجرّب نصاً بدل الصورة.' });
    return reply(502, { error: 'تعذّر إكمال التحليل. أعد المحاولة، وإن تكرر فجرّب نصاً بدل الصورة.' });
  }
};

// للاختبار المحلي فقط
exports._test = { localSplitCards, directQuran, quranCard, stripQuranWrap, directDorar, norm, dice, bestMatch, buildCard, validateEx, directMatch, DB, parseDorar, dorarMatches, dorarQuery, enrichWithDorar };
