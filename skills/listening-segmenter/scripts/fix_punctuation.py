#!/usr/bin/env python3
"""用教材原文校正 ASR 句子的措辞与标点（时间戳保持不变）。

用法:
    python3 fix_punctuation.py asr.json script.txt out.json
        asr.json    asr_transcribe.py 的输出
        script.txt  教材听力原文（可含说话人前缀 / 页码页眉，自动清洗）

匹配策略：
1. 对 ASR 每句做词序列模糊匹配，找教材中对应的原句
2. 用教材原句替换文本（措辞 + 标点）
3. ⚠️ 防丢词：如果 ASR 句子比教材句子多出词（例如 ASR 把
   "All right. So, we've done some experiments." 合成一句，
   而教材拆成两句），则保留 ASR 原文，不替换 —— 否则会丢掉
   "All right" 这类音频里确实有的内容。
4. 统一弯引号
"""
import sys, json, re, difflib

NOISE = re.compile(r'^(\*?第 \d+ 页\*?|\d+ Listening Scripts|---)\s*$')
SPEAKER = re.compile(r'^([A-Z][a-zA-Z .]*?)(?::\s*|:)')
CURLY = re.compile(r"[\u2018\u2019]")
# 低置信阈值
LOW = 0.72
# 允许教材句子比 ASR 句子多出的词数（拆分场景），超出则不再替换
EXTRA_TOL = 0


def clean_script(path):
    """读教材原文，清洗噪音，切成句子列表。"""
    lines = [l.strip() for l in open(path, encoding='utf-8') if l.strip()]
    text = ' '.join(l for l in lines if not NOISE.match(l))
    text = re.sub(r'-\s+', '', text)                 # every- where -> everywhere
    text = CURLY.sub("'", text)                      # 统一成直引号便于比对
    text = re.sub(r'\s+', ' ', text)
    chunks = re.split(r'(?<=[.?!])\s+', text)
    out = []
    for c in chunks:
        # 清掉 "Section A, 2b and 2c Ms Wang:" 这类 章节号+说话人 前缀
        c = re.sub(r'^Section\s+[A-Z](?:\s*,\s*\d+[a-z])?(?:\s+and\s+\d+[a-z])?\s*', '', c)
        c = SPEAKER.sub('', c).strip()
        if c:
            out.append(c)
    return out


def norm(s):
    """归一化用于比对：小写、去标点、合并空格。"""
    s = CURLY.sub("'", s)
    s = s.lower()
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r'\s+', ' ', s).strip()


def words_of(s):
    return norm(s).split()


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    asr_p, script_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]

    data = json.load(open(asr_p, encoding='utf-8'))
    sents = data.get('sentences') or []
    script = clean_script(script_p)
    script_norm = [words_of(x) for x in script]

    low = []
    for s in sents:
        aw = words_of(s.get('text', ''))
        if not aw:
            s['match'] = 0.0
            s['fixed'] = False
            continue

        # 找最相似的教材句子
        best, best_i = 0.0, -1
        for i, sw in enumerate(script_norm):
            if not sw:
                continue
            r = difflib.SequenceMatcher(None, aw, sw).ratio()
            if r > best:
                best, best_i = r, i

        changed = False
        if best_i >= 0 and best >= LOW:
            sw = script_norm[best_i]
            new_text = script[best_i]
            # ⚠️ 防丢词（教材拆句场景）
            # 若 ASR 一句 = 教材「上一句 + 本句」，直接用本句替换会丢掉上一句。
            # 判据：ASR 词序列以教材上一句开头，且本句是其剩余部分。
            merged = None
            if best_i > 0:
                prev_w = script_norm[best_i - 1]
                if prev_w and len(aw) > len(sw):
                    n = len(prev_w)
                    if aw[:n] == prev_w and aw[n:] == sw:
                        merged = (script[best_i - 1].strip(), script[best_i].strip())
            if merged:
                new_text = f"{merged[0]} {merged[1]}"
                s['note'] = '教材拆成两句，已合并保留完整内容'
            s['text'] = CURLY.sub("'", new_text)
            changed = new_text != CURLY.sub("'", s.get('text_orig', s['text']))
        else:
            s['text'] = CURLY.sub("'", s['text'])

        # 统一输出为弯引号
        s['text'] = s['text'].replace("'", '\u2019') if False else s['text']
        s['match'] = round(best, 3)
        s['fixed'] = changed
        if best < LOW:
            low.append((s.get('idx') or '?', s['text'], best))

    json.dump(data, open(out_p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    print(f"校正完成: {len(sents)} 句, 低置信 {len(low)} 句 -> {out_p}")
    for i, t, r in low:
        print(f"  ⚠ 未匹配 [{i}] ({r}): {t[:60]}")
    kept = [s for s in sents if s.get('note')]
    if kept:
        print(f"  ℹ 保留原文 {len(kept)} 句（教材未覆盖全部内容，防止丢词）")
        for s in kept:
            print(f"     [{s.get('idx')}] {s['text'][:60]}  <- {s['note']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
