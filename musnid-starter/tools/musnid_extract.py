#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
مُسنِد: مرحلة الاستخراج (قراءة المنشور + تقسيم الادعاءات + التصنيف).

دور النموذج هنا: استخراج وتقسيم وتصنيف فقط.
لا يُصدر أحكاماً، ولا يصحّح النص، ولا يكمله من ذاكرته.

الاستخدام:
    python musnid_extract.py صورة.png
    python musnid_extract.py --text "نص المنشور"
    python musnid_extract.py صورة.png --out نتيجة.json

المتطلبات:
    pip install requests
    GEMINI_API_KEY   (مطلوب)
    GEMINI_MODEL     (اختياري: نموذج واحد أو عدة نماذج مفصولة بفواصل بترتيب الأولوية)
    GEMINI_TEMPERATURE (اختياري: إن لم يُضبط يُترك الافتراضي عند المزوّد)

كمكتبة (للاستيراد من الخادم):
    from musnid_extract import extract
    result = extract(image_path="x.png")   # أو extract(text="...")
"""

import argparse
import base64
import json
import os
import re
import sys
import time

import requests

# ---------------------------------------------------------------------------
# إعدادات
# ---------------------------------------------------------------------------

# الأسماء منقولة من AI Studio؛ تُجرَّب بالترتيب إن فشل السابق (403/404/429/عطل).
# تُستبدل كلها بالمتغير GEMINI_MODEL (مفصولة بفواصل).
DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-3.5-flash-lite"]
MIN_CONFIDENCE = 0.6  # حد مؤقت، يُحدَّد بالاختبار على مجموعة الاختبار
MAX_IMAGE_BYTES = 10 * 1024 * 1024
REQUEST_TIMEOUT = 90
ALLOWED_TYPES = {"آية", "حديث", "قول منسوب", "معلومة"}
MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class ExtractionError(Exception):
    """خطأ قابل للعرض على المستخدم، دون أي أسرار."""


# ---------------------------------------------------------------------------
# 1) طبقة المزوّد: واجهة واحدة. لتبديل المزوّد اكتب صنفاً جديداً بالدالة نفسها.
# ---------------------------------------------------------------------------


class LLMProvider:
    def generate_json(self, system_prompt, user_text, image_bytes=None, mime_type=None):
        """تعيد (dict, اسم_النموذج_المستعمل) أو ترفع ExtractionError."""
        raise NotImplementedError


class GeminiProvider(LLMProvider):
    # رموز تعني: جرّب النموذج التالي (غير موجود، أو غير مسموح، أو نفد الحد، أو عطل مؤقت)
    _FALLBACK_STATUS = {403, 404, 429, 500, 502, 503, 504}

    def __init__(self, api_key=None, models=None):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            raise ExtractionError("لم يُضبط المتغير GEMINI_API_KEY")
        env_models = os.environ.get("GEMINI_MODEL", "")
        self.models = models or [m.strip() for m in env_models.split(",") if m.strip()] or DEFAULT_MODELS
        temp = os.environ.get("GEMINI_TEMPERATURE")
        self.temperature = float(temp) if temp else None

    def _call(self, model, system_prompt, parts):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        gen_cfg = {"responseMimeType": "application/json"}
        if self.temperature is not None:
            gen_cfg["temperature"] = self.temperature
        body = {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": gen_cfg,
        }
        # المفتاح في الترويسة لا في الرابط، فلا يظهر في رسائل الأخطاء
        return requests.post(
            url,
            headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
            json=body,
            timeout=REQUEST_TIMEOUT,
        )

    @staticmethod
    def _parse(resp):
        data = resp.json()
        cands = data.get("candidates") or []
        if not cands:
            reason = (data.get("promptFeedback") or {}).get("blockReason", "غير معروف")
            raise ExtractionError(f"لم يُرجع المزوّد نتيجة (السبب: {reason})")
        parts = (cands[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise ExtractionError("رد المزوّد ليس JSON صالحاً")

    def generate_json(self, system_prompt, user_text, image_bytes=None, mime_type=None):
        parts = []
        if image_bytes:
            parts.append(
                {
                    "inline_data": {
                        "mime_type": mime_type or "image/png",
                        "data": base64.b64encode(image_bytes).decode("ascii"),
                    }
                }
            )
        parts.append({"text": user_text})

        last_problem = "لا نموذج متاح"
        for model in self.models:
            try:
                resp = self._call(model, system_prompt, parts)
            except (requests.Timeout, requests.ConnectionError):
                last_problem = f"تعذّر الاتصال أو انتهت المهلة ({model})"
                continue
            if resp.status_code == 200:
                return self._parse(resp), model
            if resp.status_code in self._FALLBACK_STATUS:
                last_problem = f"رمز {resp.status_code} من النموذج {model}"
                if resp.status_code in (500, 502, 503, 504):
                    time.sleep(1)
                continue
            # 400 وغيره: خطأ في الطلب أو المفتاح، لا فائدة من تبديل النموذج
            raise ExtractionError(f"رفض المزوّد الطلب ({resp.status_code}): {resp.text[:300]}")
        raise ExtractionError(f"فشلت كل النماذج. آخر مشكلة: {last_problem}")


def get_provider():
    # لتبديل المزوّد لاحقاً: غيّر هذا السطر فقط.
    return GeminiProvider()


# ---------------------------------------------------------------------------
# 2) التعليمات إلى النموذج (مبنية على البنود 4 و6 في وثيقة التعريف)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """أنت وحدة استخراج في أداة تتحقق من النصوص الدينية المتداولة في المنشورات.
مهمتك ثلاثة أشياء فقط: قراءة النص، وتقسيمه إلى ادعاءات، وتصنيف كل ادعاء.

قواعد صارمة:
1. انقل النص كما هو في المنشور حرفاً حرفاً، بتشكيله وأخطائه. لا تصحّحه ولا تكمله ولا تستبدله بما تحفظه من القرآن أو الحديث. حقل text في كل ادعاء يجب أن يكون مقطعاً منسوخاً من full_text دون تغيير.
2. لا تُصدر أي حكم على حديث أو آية أو قول. لا تكتب صحيح أو ضعيف أو موضوع من عندك.
3. إن وُجد في المنشور حكم مكتوب على حديث بعينه (مثل: ضعيف، لا أصل له، موضوع، منكر)، فانقله كما كُتب في publisher_verdict داخل ادعاء ذلك الحديث وحده، وانقل في publisher_reference ما ذكره الناشر من كتاب ورقم لذلك الحديث. قد يحمل المنشور الواحد عدة أحاديث لكل منها حكم مختلف، فلا تدمجها ولا تعمّم حكماً على غير صاحبه. حكم الناشر ادعاء منه وليس حقيقة.
4. إن كانت الصورة غير واضحة أو النص مشوّشاً بحيث لا تثق بقراءتك، فاجعل readable=false واشرح السبب في reading_note، واجعل claims قائمة فارغة. لا تخمّن.
5. إن شككت في قراءة كلمة داخل ادعاء فانقلها كما تراها، وأضف رقم الادعاء إلى uncertain_claims.
6. افصل الشرح والتفسير المدمج في النص عن النص الشرعي: ما هو شرح أو تعليق يُصنَّف "معلومة".
7. إن نُسبت أقوال إلى جماعة (مثل: من أقوال الصحابة) ففكّها إلى ادعاء مستقل لكل قول، واحفظ العبارة الجماعية في attribution_in_post.
8. صيغ النسبة مثل "كان يقال" و"بلغنا عن" و"قال فلان" تُحفظ كما هي في attribution_in_post.
9. المرجع المكتوب في المنشور خارج النص (مثل: رواه مسلم، أو اسم كتاب ورقم) يوضع في post_attribution.

أنواع الادعاء (type) أربعة فقط، بهذه الألفاظ بالضبط:
- "آية": نص يُدّعى أنه من القرآن.
- "حديث": نص يُنسب إلى النبي ﷺ (بما فيه القدسي).
- "قول منسوب": قول أو أثر أو دعاء منسوب إلى صحابي أو تابعي أو عالم، أو منسوب إلى جماعة.
- "معلومة": أذكار وشروح وحِكَم عامة وفتاوى وأحكام فقهية وكل ما لا يدّعي نصاً شرعياً بعينه.
التصنيف أولي وقد تصححه المطابقة لاحقاً.

أخرج JSON فقط، بهذه الحقول بالضبط:
{
  "readable": قيمة منطقية,
  "reading_confidence": رقم من 0 إلى 1 يمثل ثقتك في قراءتك للنص كله,
  "reading_note": نص موجز عن جودة القراءة أو سبب التعذّر,
  "full_text": النص الكامل كما قرأته,
  "post_attribution": نص أو null,
  "claims": [
    {
      "id": رقم تسلسلي يبدأ من 1,
      "type": أحد الأنواع الأربعة,
      "text": نص الادعاء منسوخاً من full_text,
      "attribution_in_post": نص أو null,
      "publisher_verdict": نص أو null,
      "publisher_reference": نص أو null
    }
  ],
  "uncertain_claims": [أرقام الادعاءات المشكوك في قراءتها]
}
إن لم يكن في المنشور أي ادعاء ديني فاجعل claims قائمة فارغة."""


# ---------------------------------------------------------------------------
# 3) التحقق من المخرجات
# ---------------------------------------------------------------------------

_DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")


def norm(s):
    """تطبيع للمقارنة فقط (لا يُعرض): بلا تشكيل ولا تطويل، وتوحيد الألفات والياء والتاء المربوطة."""
    s = _DIACRITICS.sub("", s or "")
    s = re.sub("[إأآٱ]", "ا", s)
    s = s.replace("ى", "ي").replace("ة", "ه")
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(s.split())


OPTIONAL_CLAIM_FIELDS = ("attribution_in_post", "publisher_verdict", "publisher_reference")


def validate(result):
    """تعيد قائمة مشكلات بنيوية. لا تصلح شيئاً بصمت."""
    if not isinstance(result, dict):
        return ["الرد ليس كائن JSON"]
    problems = []
    if not isinstance(result.get("readable"), bool):
        problems.append("الحقل readable مفقود أو ليس منطقياً")
    conf = result.get("reading_confidence")
    if not isinstance(conf, (int, float)) or isinstance(conf, bool) or not 0 <= conf <= 1:
        problems.append("الحقل reading_confidence مفقود أو خارج المدى 0-1")
    if not isinstance(result.get("claims"), list):
        problems.append("الحقل claims مفقود أو ليس قائمة")
        return problems
    for i, c in enumerate(result["claims"], 1):
        if not isinstance(c, dict):
            problems.append(f"الادعاء {i} ليس كائناً")
            continue
        if c.get("type") not in ALLOWED_TYPES:
            problems.append(f"نوع غير مسموح في الادعاء {i}: {c.get('type')!r}")
        if not isinstance(c.get("text"), str) or not c["text"].strip():
            problems.append(f"الادعاء {i} بلا نص")
    return problems


def finalize(result, source_text=None):
    """يطبّق قاعدة الثقة، ويضمن اكتمال الحقول، ويفحص أن كل ادعاء مقطع من النص المصدر."""
    result.setdefault("post_attribution", None)
    result.setdefault("reading_note", "")
    result.setdefault("uncertain_claims", [])

    conf = result["reading_confidence"]
    if (not result["readable"]) or conf < MIN_CONFIDENCE:
        result["claims"] = []
        result["status"] = "unreadable"
        result["user_message"] = "تعذّرت قراءة النص بوضوح، يُرجى إدخاله يدوياً"
        return result

    # النص المرجعي: المدخل نفسه إن كان نصاً، وإلا ما قرأه النموذج
    reference = norm(source_text if source_text is not None else result.get("full_text", ""))
    for n, c in enumerate(result["claims"], 1):
        c.setdefault("id", n)
        for f in OPTIONAL_CLAIM_FIELDS:
            c.setdefault(f, None)
        # حماية من الإكمال من الذاكرة: الادعاء يجب أن يكون مقطعاً من النص
        c["text_in_source"] = bool(norm(c["text"])) and norm(c["text"]) in reference

    result["status"] = "ok" if result["claims"] else "no_claims"
    return result


# ---------------------------------------------------------------------------
# 4) الواجهة الرئيسية
# ---------------------------------------------------------------------------


def _load_image(path):
    if not os.path.isfile(path):
        raise ExtractionError(f"لم يُعثر على الملف: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext not in MIME_BY_EXT:
        raise ExtractionError(f"امتداد غير مدعوم ({ext}). المدعوم: png وjpg وjpeg وwebp")
    if os.path.getsize(path) > MAX_IMAGE_BYTES:
        raise ExtractionError("الصورة أكبر من 10 ميغابايت، صغّر حجمها")
    with open(path, "rb") as f:
        return f.read(), MIME_BY_EXT[ext]


def extract(image_path=None, text=None, provider=None):
    """تعيد dict. ترفع ExtractionError عند الأخطاء القابلة للعرض."""
    if not image_path and not text:
        raise ExtractionError("أعطني صورة أو نصاً")
    provider = provider or get_provider()

    image_bytes = mime = None
    if image_path:
        image_bytes, mime = _load_image(image_path)
        user_text = "اقرأ هذا المنشور واستخرج الادعاءات."
        if text:
            user_text += "\n\nنص إضافي مع المنشور:\n" + text
    else:
        user_text = "استخرج الادعاءات من هذا المنشور:\n\n" + text

    result, model = provider.generate_json(SYSTEM_PROMPT, user_text, image_bytes, mime)
    problems = validate(result)

    if problems:  # محاولة إصلاح واحدة فقط، ثم نفشل بوضوح
        retry_text = (
            user_text
            + "\n\nمخرجاتك السابقة خالفت البنية المطلوبة:\n- "
            + "\n- ".join(problems)
            + "\nأعد الإخراج كاملاً وفق البنية والأنواع الأربعة بالضبط."
        )
        result, model = provider.generate_json(SYSTEM_PROMPT, retry_text, image_bytes, mime)
        problems = validate(result)
        if problems:
            raise ExtractionError("مخرجات النموذج غير صالحة بعد إعادة المحاولة: " + "؛ ".join(problems))

    result = finalize(result, source_text=(text if not image_path else None))
    result["model_used"] = model
    return result


def main():
    ap = argparse.ArgumentParser(description="مُسنِد: استخراج الادعاءات")
    ap.add_argument("image", nargs="?", help="مسار صورة المنشور")
    ap.add_argument("--text", help="نص المنشور (بدل الصورة، أو معها)")
    ap.add_argument("--out", help="ملف JSON للحفظ")
    args = ap.parse_args()
    if not args.image and not args.text:
        ap.error("أعطني صورة أو --text")

    try:  # عرض العربية صحيحاً في طرفية ويندوز
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    try:
        result = extract(image_path=args.image, text=args.text)
    except ExtractionError as e:
        print(f"خطأ: {e}", file=sys.stderr)
        sys.exit(1)

    out = json.dumps(result, ensure_ascii=False, indent=2)
    print(out)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)


if __name__ == "__main__":
    main()
