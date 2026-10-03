// مُسنِد: دالة التحليل.
// دور النموذج هنا: استخراج النص وتقسيمه وتصنيفه فقط. لا يُصدر حكماً على أي نص.
// الأحكام تأتي من data/verdicts.json منقولةً كما هي ومنسوبةً إلى قائلها (الطبقة الأولى)،
// فإن لم يوجد النص فيها بُحث حيّاً في واجهة الموسوعة الحديثية بالدرر السنية (الطبقة الثانية)،
// وتُعرض نتائجها كما وردت دون تخزين، مع وسم أنها منقولة بواسطة ولم يُراجَع أصلها.

const fs = require('fs');
const path = require('path');

// النماذج تُجرَّب بالترتيب إن فشل السابق (403/404/429/عطل). تُستبدل بالمتغير GEMINI_MODEL (مفصولة بفواصل).
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3-flash-preview,gemini-3.5-flash-lite')
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

  if (claim.type === 'آية') {
    // مسار القرآن (الروايات الثماني) يُبنى في اليوم الأول من التحدي.
    return { ...base, state: 'quran_pending',
      note: 'مطابقة الآيات بالروايات الثماني قيد التطوير في هذه النسخة.' };
  }

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

async function dorarSearch(text, timeoutMs) {
  const q = dorarQuery(text);
  if (!q || timeoutMs < 800) return { error: 'time' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${DORAR_API}?skey=${encodeURIComponent(q)}`, {
      signal: ctrl.signal, headers: { 'user-agent': 'musnid-ai (hackathon; contact via GitHub)' } });
    if (!res.ok) return { error: `http ${res.status}` };
    const data = await res.json();
    return { q, results: parseDorar(data && data.ahadith && data.ahadith.result) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'time' : 'net' };
  } finally {
    clearTimeout(timer);
  }
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
    const r = await dorarSearch(c.post_text, Math.min(4000, deadline - Date.now()));
    const link = `https://dorar.net/hadith/search?q=${encodeURIComponent(dorarQuery(c.post_text))}`;
    if (r.error) {
      c.scope += ' وتعذّر البحث في الموسوعة الحديثية بالدرر في هذه المحاولة.';
      c.dorar_link = link;
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

// ---------- الاستدعاء (Gemini) ----------
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
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new ApiError('رد المزوّد ليس JSON صالحاً', 502);
  try { return JSON.parse(clean.slice(s, e + 1)); }
  catch { throw new ApiError('رد المزوّد ليس JSON صالحاً', 502); }
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

async function extract({ text, image, mediaType }, hardDeadline) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: mediaType, data: image } });
  parts.push({ text: image
    ? 'اقرأ هذا المنشور واستخرج الادعاءات وفق التعليمات.'
    : `استخرج ادعاءات هذا المنشور وفق التعليمات:\n\n${text}` });

  const gen = { responseMimeType: 'application/json' };
  // اتركها غير مضبوطة ليبقى الافتراضي عند المزوّد؛ تُضبط من متغيرات البيئة عند الحاجة.
  if (process.env.GEMINI_TEMPERATURE) gen.temperature = Number(process.env.GEMINI_TEMPERATURE);
  if (process.env.GEMINI_THINKING_LEVEL) gen.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: gen,
  });

  const deadline = Math.min(Date.now() + TIME_BUDGET_MS, hardDeadline || Infinity);
  let last = 'لا نموذج متاح';
  let busy = 0; // عدد النماذج التي ردّت بازدحام أو نفاد حصة (429/503)
  for (const model of MODELS) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) { last = 'انتهت المهلة'; break; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      // المفتاح في الترويسة لا في الرابط، فلا يظهر في أي رسالة خطأ
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body });
      if (res.ok) return { ex: parseModelJson(await res.json()), model };
      if (FALLBACK_STATUS.has(res.status)) {
        if (res.status === 429 || res.status === 503) busy++;
        last = `${res.status} من ${model}`; continue;
      }
      throw new ApiError(`رفض المزوّد الطلب (${res.status})`, 502);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      last = `تعذّر الاتصال أو انتهت المهلة (${model})`;
      if (err.name === 'AbortError') break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (busy > 0 && busy === MODELS.length) throw new ApiError(`كل النماذج مزدحمة أو بلغت حصتها: ${last}`, 503);
  throw new ApiError(`فشلت كل النماذج. آخر مشكلة: ${last}`, 504);
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
  if (!process.env.GEMINI_API_KEY) return reply(500, { error: 'مفتاح GEMINI_API_KEY غير مضبوط في متغيرات البيئة' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'طلب غير صالح' }); }
  if (!body.text && !body.image) return reply(400, { error: 'أرسل نصاً أو صورة' });
  if (body.image) {
    if (typeof body.image !== 'string' || body.image.length > MAX_IMAGE_B64)
      return reply(413, { error: 'الصورة كبيرة جداً، صغّر حجمها وأعد المحاولة' });
    body.mediaType = ALLOWED_MIME.has(body.mediaType) ? body.mediaType : 'image/jpeg';
  }

  // نص ملصق يطابق مدخلاً في القاعدة مطابقة تامة أو يُحتوى فيه حرفياً: بطاقة مباشرة دون استدعاء النموذج.
  if (!body.image) {
    const direct = directMatch(body.text);
    if (direct) return reply(200, { status: 'ok', confidence: 1, model_used: 'مطابقة مباشرة مع القاعدة (دون نموذج)', cards: [direct], skipped_info_claims: 0 });
    const viaDorar = await directDorar(body.text, Math.min(deadline, Date.now() + 3000));
    if (viaDorar) return reply(200, { status: 'ok', confidence: 1, model_used: 'بحث مباشر في الموسوعة الحديثية (دون نموذج)', cards: [viaDorar], skipped_info_claims: 0 });
  }

  try {
    // الصورة تُعالج في الذاكرة ولا تُخزَّن عندنا.
    const { ex, model } = await extract(body, deadline);

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
    });

    const cards = ex.claims.map(buildCard).filter(Boolean);
    await enrichWithDorar(cards, deadline);
    return reply(200, { status: 'ok', confidence: ex.confidence, model_used: model, cards,
      skipped_info_claims: ex.claims.filter((c) => c.type === 'معلومة').length });
  } catch (err) {
    console.error(err.message);
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
exports._test = { directDorar, norm, dice, bestMatch, buildCard, validateEx, directMatch, DB, parseDorar, dorarMatches, dorarQuery, enrichWithDorar };
