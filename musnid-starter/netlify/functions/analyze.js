// مُسنِد: دالة التحليل.
// دور النموذج هنا: استخراج النص وتقسيمه وتصنيفه فقط. لا يُصدر حكماً على أي نص.
// الأحكام تأتي حصراً من data/verdicts.json منقولةً كما هي ومنسوبةً إلى قائلها.

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

function bestMatch(text) {
  const ranked = DB.entries
    .map((e) => ({ entry: e, score: dice(text, e.matn) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  return { ...ranked[0], others: ranked.slice(1, 3).filter((r) => r.score >= MATCH_CLOSE) };
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
    return { ...base, state: 'out_of_scope',
      note: 'هذا حكم فقهي، والتحقق منه خارج نطاق الأداة، يُرجع فيه إلى جهة مؤهلة.' };
  }

  if (claim.type === 'آية') {
    // مسار القرآن (الروايات الثماني) يُبنى في اليوم الأول من التحدي.
    return { ...base, state: 'quran_pending',
      note: 'مطابقة الآيات بالروايات الثماني قيد التطوير في هذه النسخة.' };
  }

  const m = bestMatch(claim.text);
  const scope = `بُحث في قاعدة الأحكام الموثقة لدى الأداة (${DB.entries.length} مدخلاً). غياب النتيجة لا يعني عدم صحة النص.`;

  if (!m || m.score < MATCH_CLOSE) {
    return { ...base, state: 'not_found', scope,
      note: 'لم يُعثر على مرجع، يُحال إلى مختص.' };
  }

  const e = m.entry;
  const exact = m.score >= MATCH_EXACT;
  const hasVerdicts = Array.isArray(e.verdicts) && e.verdicts.length > 0;

  if (!hasVerdicts && !(e.takhrij_no_verdict || []).length) {
    return { ...base, state: 'not_found', scope,
      note: 'لم يُعثر على مرجع، يُحال إلى مختص.' };
  }

  return {
    ...base,
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
    // ألفاظ قريبة أخرى في القاعدة: الحكم يخص لفظ المصدر وحده، فنُنبّه إلى القريب منه
    similar_entries: exact ? [] : m.others.map((o) => ({
      id: o.entry.id, matn: o.entry.matn, score: Math.round(o.score * 100) / 100 })),
    scope,
    caution: hasVerdicts ? null
      : 'لم يرد حكم منقول في المصادر المعتمدة لدى الأداة، فلا يُعتمد على هذه البطاقة في نسبته إلى النبي ﷺ، يُحال إلى مختص.',
  };
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

async function extract({ text, image, mediaType }) {
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

  const deadline = Date.now() + TIME_BUDGET_MS;
  let last = 'لا نموذج متاح';
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
      if (FALLBACK_STATUS.has(res.status)) { last = `${res.status} من ${model}`; continue; }
      throw new ApiError(`رفض المزوّد الطلب (${res.status})`, 502);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      last = `تعذّر الاتصال أو انتهت المهلة (${model})`;
      if (err.name === 'AbortError') break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ApiError(`فشلت كل النماذج. آخر مشكلة: ${last}`, 504);
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
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

  try {
    // الصورة تُعالج في الذاكرة ولا تُخزَّن عندنا.
    const { ex, model } = await extract(body);

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
    return reply(200, { status: 'ok', confidence: ex.confidence, model_used: model, cards,
      skipped_info_claims: ex.claims.filter((c) => c.type === 'معلومة').length });
  } catch (err) {
    console.error(err.message);
    if (err instanceof ApiError && err.status === 504)
      return reply(504, { error: 'استغرق التحليل وقتاً أطول من المسموح. أعد المحاولة، وإن تكرر فجرّب نصاً بدل الصورة.' });
    return reply(502, { error: 'تعذّر إكمال التحليل. أعد المحاولة، وإن تكرر فجرّب نصاً بدل الصورة.' });
  }
};

// للاختبار المحلي فقط
exports._test = { norm, dice, bestMatch, buildCard, validateEx, DB };
