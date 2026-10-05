// اختبارات مسار القرآن: node scripts/test_quran.js
// كل حالة: نص، والنتيجة المتوقعة (نوع المطابقة، والروايات الموافقة عند المقارنة بالتشكيل).
const q = require('../lib/quran.js');
const CASES = [
  ['P09 (الحج): حفص وورش وقالون', 'أُذِنَ لِلَّذِينَ يُقَتَلُونَ بِأَنَّهُمْ ظُلِمُوا وَإِنَّ اللَّهَ عَلَى نَصْرِهِمْ لَقَدِيرٌ', 'match', ['hafs', 'warsh', 'qaloon']],
  ['P14 (البقرة): ورش وحده', 'إِنَّ الَّذِينَ كَفَرُوا سَوَآءٌ عَلَيْهِمُۥٓ ءَآنذَرْتَهُمُۥٓ أَمْ لَمْ تُنذِرْهُمْ لَا يُومِنُونَ', 'match', ['warsh']],
  ['P16: تشكيل لا يوافق الثماني', 'وَلَا تَقْتُلُوهُمْ عِندَ الْمَسْجِدِ الْحَرَامِ حَتَّى يَقْتُلُوكُمْ فِيهِ فَإِن قَتَلُوكُمْ فَاقْتُلُوهُمْ', 'vocal_none', []],
  ['تنوين مفتوح بالضم (غشاوة، عظيم)', 'خَتَمَ اللَّهُ عَلَىٰ قُلُوبِهِمْ وَعَلَىٰ سَمْعِهِمْ وَعَلَىٰ أَبْصَارِهِمْ غِشَاوَةٌ وَلَهُمْ عَذَابٌ عَظِيمٌ', 'match', null, 'hafs'],
  ['تنوين مفتوح بالفتح (هدى)', 'هُدًى لِلْمُتَّقِينَ الَّذِينَ يُؤْمِنُونَ بِالْغَيْبِ', 'match', null, 'hafs'],
  ['غير مشكول: لا تُسمّى رواية', 'ومن آياته أن خلق لكم من أنفسكم أزواجا لتسكنوا إليها', 'match', null],
  ['إملائي: يا أيها / الصلاة', 'يا أيها الذين آمنوا اتقوا الله وكونوا مع الصادقين', 'match', null],
  ['لفظ مختلف', 'قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له احد', 'different', null],
  ['ليس قرآناً', 'إنما الأعمال بالنيات وإنما لكل امرئ ما نوى', 'none', null],
];
let fail = 0;
for (const [name, text, kind, agree, mustInclude] of CASES) {
  const m = q.match(text);
  let ok = m.kind === kind;
  if (ok && agree) ok = JSON.stringify((m.agree || []).slice().sort()) === JSON.stringify(agree.slice().sort());
  if (ok && mustInclude) ok = (m.agree || []).includes(mustInclude);
  if (ok && agree === null && kind === 'match' && !mustInclude) ok = !m.vocalized;
  if (!ok) fail++;
  console.log(ok ? '✓' : '✗', name, ok ? '' : JSON.stringify({ kind: m.kind, agree: m.agree }));
}
// كل رواية: نصوصها تُنسب إليها
for (const key of q.ORDER) {
  const R = q.load().r[key];
  let bad = 0;
  for (let i = 0; i < R.ayat.length; i += 25) {
    const t = R.ayat[i][2];
    if (q.skeletonOnly(t).length < 10) continue;
    if (!(q.match(t).agree || []).includes(key)) bad++;
  }
  if (bad) fail++;
  console.log(bad ? '✗' : '✓', `نصوص ${R.name} تُنسب إليها`, bad ? `(${bad} خطأ)` : '');
}
console.log(fail ? `فشل ${fail}` : 'نجحت كل الاختبارات');
process.exit(fail ? 1 : 0);
