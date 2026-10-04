// مُسنِد: دالة التحليل.
// دور النموذج هنا: استخراج النص وتقسيمه وتصنيفه فقط. لا يُصدر حكماً على أي نص.
// الأحكام تأتي حصراً من data/verdicts.json منقولةً كما هي ومنسوبةً إلى قائلها.

const fs = require('fs');
const path = require('path');

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const OCR_CONFIDENCE_MIN = 0.6; // حد مؤقت: يُضبط بالاختبار على مجموعة الاختبار
const MATCH_EXACT = 0.95;
const MATCH_CLOSE = 0.6;

let DB = { entries: [] };
try {
  DB = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/verdicts.json'), 'utf8'));
} catch (e) {
  console.error('تعذّرت قراءة قاعدة الأحكام', e.message);
}

const SYSTEM = `أنت وحدة استخراج نصوص فقط في أداة تحقق من المنشورات الدينية.
مهمتك: (1) قراءة النص كما هو مكتوب دون تصحيح أو إكمال، (2) فصل المنشور إلى ادعاءات مستقلة، (3) تصنيف كل ادعاء.
ممنوع عليك: الحكم على أي حديث أو أثر، أو تصحيح لفظ، أو إكمال نص ناقص، أو كتابة نص من ذاكرتك، أو الإفتاء.
أجب بـ JSON فقط دون أي نص آخر ودون علامات markdown، بالشكل:
{"readable":true|false,"confidence":0..1,"claims":[{"type":"آية|حديث|قول منسوب|معلومة|حكم فقهي","text":"النص كما ورد حرفياً","publisher_grade":"حكم ذكره المنشور نفسه على الحديث أو null","cited_reference":"مرجع ذكره المنشور (كتاب ورقم) أو null","attributed_to":"القائل المذكور في المنشور أو null"}]}
قواعد:
- افصل الشرح والتفسير عن النص الشرعي؛ الشرح يُصنَّف «معلومة».
- النسبة الجماعية («من أقوال الصحابة...») تُفكّ إلى ادعاء لكل قول.
- الأذكار والحِكَم العامة والكلام الإنشائي «معلومة».
- الأحكام الفقهية الواردة في المنشور «حكم فقهي».
- «حكم الناشر» يوضع في publisher_grade ولا يكون ادعاءً مستقلاً.
- إن كانت الصورة غير مقروءة أو النص مشوّهاً فاجعل readable=false وconfidence منخفضة، ولا تخمّن.
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
  let best = null;
  for (const e of DB.entries) {
    const s = dice(text, e.matn);
    if (!best || s > best.score) best = { entry: e, score: s };
  }
  return best;
}

function buildCard(claim) {
  const base = {
    type: claim.type,
    post_text: claim.text,
    publisher_grade: claim.publisher_grade || null,
    cited_reference: claim.cited_reference || null,
    attributed_to: claim.attributed_to || null,
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

// ---------- الاستدعاء ----------
function parseJson(txt) {
  const clean = txt.replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  return JSON.parse(clean.slice(s, e + 1));
}

async function extract({ text, image, mediaType }) {
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } });
    content.push({ type: 'text', text: 'استخرج ادعاءات هذا المنشور وفق التعليمات.' });
  } else {
    content.push({ type: 'text', text: `استخرج ادعاءات هذا المنشور وفق التعليمات:\n\n${text}` });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`خدمة النموذج ردّت بخطأ ${res.status}`);
  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(out);
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'الطريقة غير مدعومة' });
  if (!process.env.ANTHROPIC_API_KEY) return reply(500, { error: 'مفتاح ANTHROPIC_API_KEY غير مضبوط في متغيرات البيئة' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'طلب غير صالح' }); }
  if (!body.text && !body.image) return reply(400, { error: 'أرسل نصاً أو صورة' });

  try {
    // الصورة تُعالج في الذاكرة ولا تُخزَّن.
    const ex = await extract(body);
    if (!ex.readable || (ex.confidence ?? 0) < OCR_CONFIDENCE_MIN) {
      return reply(200, { status: 'unreadable',
        message: 'تعذّرت قراءة النص بوضوح، يُرجى إدخاله يدوياً.' });
    }
    const cards = (ex.claims || []).map(buildCard).filter(Boolean);
    return reply(200, { status: 'ok', confidence: ex.confidence, cards,
      skipped_info_claims: (ex.claims || []).filter((c) => c.type === 'معلومة').length });
  } catch (err) {
    console.error(err);
    return reply(502, { error: 'تعذّر إكمال التحليل. أعد المحاولة، وإن تكرر فجرّب نصاً بدل الصورة.' });
  }
};
