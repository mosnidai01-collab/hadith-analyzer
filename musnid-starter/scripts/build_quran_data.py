# يبني data/quran.json.gz من بيانات «الموسوعة القرآنية» Quranpedia.net (مرجع التحدي للنص القرآني)،
# وهي نصوص مجمع الملك فهد لطباعة المصحف الشريف للروايات الثماني بعد ضبطها وتدقيقها عند فريق الموسوعة.
# الاستعمال: python scripts/build_quran_data.py <مجلد فيه mushafs-*.json.gz> [ملف hafsData_v18.json]
#   - الملفات من https://quranpedia.net/dumps (mushafs-all.zip)
#   - ملف حفص من مجمع الملك فهد (github.com/thetruetruth/quran-data-kfgqpc) يُؤخذ منه النص الإملائي فقط، فهرساً للمطابقة لا يُعرض.
# لا يُعدَّل نص الآية إلا بإصلاح موثق: بسملة مدمجة في أول آية من سورة القدر عند البزي وقنبل تُفصل عنها،
# والتصحيحات في CORRECTIONS بعد مقابلتها على المصحف المطبوع.
import json, gzip, re, sys, os, urllib.request

MUSHAFS = [('hafs', 2, 'حفص عن عاصم'), ('shouba', 9, 'شعبة عن عاصم'),
           ('warsh', 4, 'ورش عن نافع'), ('qaloon', 7, 'قالون عن نافع'),
           ('doori', 6, 'الدوري عن أبي عمرو'), ('soosi', 10, 'السوسي عن أبي عمرو'),
           ('bazzi', 5, 'البزي عن ابن كثير'), ('qumbul', 8, 'قنبل عن ابن كثير')]
KFGQPC_HAFS = 'https://raw.githubusercontent.com/thetruetruth/quran-data-kfgqpc/main/hafs/data/hafsData_v18.json'

# تصحيحات قابلها صاحب المشروع على المصحف المطبوع: (الرواية، السورة، الآية، نص الموسوعة، النص المعتمد، الملاحظة)
CORRECTIONS = [
    ('warsh', 62, 8, '\u0641\u064E\u064A\u064F\u0646\u064E\u0628\u0651\u0650\u064A\u0640\u0654\u064F\u0643\u064F\u0645', '\u0641\u064E\u064A\u064F\u0646\u064E\u0628\u0651\u0650\u0626\u064F\u0643\u064F\u0645',
     'رسم ورش في الجمعة 8 كما في المصحف المطبوع لدى صاحب المشروع وفي نسخة مجمع الملك فهد (warshData_v10)، 4 أكتوبر 2026'),
]

src = sys.argv[1] if len(sys.argv) > 1 else '.'
hafs_file = sys.argv[2] if len(sys.argv) > 2 else None
fixes = []
out = {'source': 'Quranpedia.net (الموسوعة القرآنية) — نصوص مجمع الملك فهد لطباعة المصحف الشريف',
       'source_url': 'https://quranpedia.net/dumps', 'riwayat': {}, 'suras': {}}

for key, mid, name in MUSHAFS:
    raw = json.load(gzip.open(os.path.join(src, f'mushafs-{mid}.json.gz'), 'rt', encoding='utf-8'))
    out.setdefault('version', raw['license']['version'])
    d = raw['data']
    ayat = []
    for s in d['surahs']:
        for a in s['ayahs']:
            sn, an = int(a['surah']), int(a['number'])
            t = a['text'].replace('‏', '').replace('\r', '')
            if '\n' in t:   # بسملة مدمجة في نص الآية
                first, rest = t.split('\n', 1)
                if re.sub('[\u064B-\u065F\u0670\u06D6-\u06ED]', '', first).replace('ٱ', 'ا').strip().startswith('بسم الله الرحمن الرحيم'):
                    fixes.append(f'{key} {sn}:{an}: فُصلت البسملة المدمجة في أول الآية')
                    t = rest
                else:
                    t = t.replace('\n', ' ')
            t = re.sub(r'[۞۩]\s*', '', t)
            t = re.sub(r'\s+', ' ', t).strip()
            for ck, cs, ca, frm, to, note in CORRECTIONS:
                if ck == key and cs == sn and ca == an:
                    if frm not in t:
                        raise SystemExit(f'التصحيح لم يجد النص المتوقع: {key} {sn}:{an}')
                    t = t.replace(frm, to)
                    fixes.append(f'{key} {sn}:{an}: «{frm}» ← «{to}» ({note})')
            ayat.append([sn, an, t])
            if key == 'hafs':
                out['suras'].setdefault(str(sn), re.sub(r'^سورة\s+', '', s['name']).strip())
    out['riwayat'][key] = {'name': name, 'quranpedia_mushaf_id': mid, 'mushaf_name': d['name'], 'ayat': ayat}
    print(key, len(ayat))

# النص الإملائي لحفص (فهرس مطابقة فقط)، يُربط بالسورة والآية
if hafs_file and os.path.exists(hafs_file):
    h = json.load(open(hafs_file, encoding='utf-8-sig'))
else:
    h = json.loads(urllib.request.urlopen(KFGQPC_HAFS).read().decode('utf-8-sig'))
iml = {(int(x['sora']), int(x['aya_no'])): x['aya_text_emlaey'].strip() for x in h}
out['hafs_imlaei'] = [iml.get((s, a), '') for s, a, _ in out['riwayat']['hafs']['ayat']]
out['fixes'] = fixes

raw = json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'quran.json.gz')
with gzip.open(dst, 'wb', compresslevel=9) as f:
    f.write(raw)
print('version', out['version'], 'fixes', fixes)
print('bytes', len(raw), 'gz', os.path.getsize(dst))
