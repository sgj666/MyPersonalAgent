#!/usr/bin/env python3
"""Qwen ASR 转写 + 自动切句 —— 输出句子级 JSON（含词级时间戳）。

⚠️ 关键调用要点（踩坑记录，勿改）：
1. 必须用原生接口 /api/v1/services/aigc/multimodal-generation/generation
   用 /compatible-mode/v1/chat/completions 会一直报 "format is empty"
2. 音频字段：input.messages[0].content[0].audio = "data:audio/mp3;base64,<b64>"
   不能写成 {data, format} 对象形式
3. parameters.format 必须显式传 "mp3"，否则 400
4. 模型名以账号实际可用为准，用 --model 覆盖

用法:
    python3 asr_transcribe.py input.mp3 out.json
    python3 asr_transcribe.py input.mp3 out.json --model qwen-audio-3.0-asr-flash

输出 JSON:
    {
      "duration": 87,
      "sentences": [{"begin":1000,"end":7850,"text":"..."}, ...],
      "words": [{"begin":..,"end":..,"text":"..","punctuation":"."}, ...]
    }

注意：API 通常只返回 1 个整段 sentence（不自动分句），
本脚本按句末标点 + 停顿 + 缩写词白名单，从词级数据重新切句。
"""
import sys, os, json, base64, urllib.request, urllib.error, re

API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
DEFAULT_MODEL = "qwen-audio-3.0-asr-flash"
# 这些词后的句点不是句末
ABBREVIATIONS = {"ms", "mr", "mrs", "dr", "st", "prof", "vs", "etc", "e.g", "i.e"}
# 无标点时，词间静音超过该值也视为断句（毫秒）
PAUSE_SPLIT_MS = 900


def call_asr(path: str, model: str, api_key: str) -> dict:
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    fmt = os.path.splitext(path)[1].lstrip('.').lower() or 'mp3'
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [
            {"audio": f"data:audio/{fmt};base64,{b64}"}
        ]}]},
        "parameters": {"format": fmt, "sample_rate": "16000"},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')[:500]
        raise SystemExit(f"ASR HTTP {e.code}: {body}")


def split_sentences(words: list) -> list:
    """从词级时间戳重新切句（API 不给分句）。"""
    if not words:
        return []
    sents, cur = [], []

    def flush():
        if not cur:
            return
        text = "".join(w.get("text", "") for w in cur)
        text = re.sub(r"\s+", " ", text).strip()
        text = re.sub(r"\s+([,.?!;:])", r"\1", text)
        if text:
            sents.append({
                "begin": cur[0]["begin_time"],
                "end": cur[-1]["end_time"],
                "text": text,
            })
        cur.clear()

    for i, w in enumerate(words):
        cur.append(w)
        punct = (w.get("punctuation") or "").strip()
        word = re.sub(r"[^a-z.]", "", w.get("text", "").lower())

        # 规则1：句末标点
        if punct and any(c in punct for c in ".?!"):
            if word.rstrip('.') in ABBREVIATIONS:
                continue                       # Ms. / Mr. 后面不断句
            flush()
            continue

        # 规则2：无标点但静音够长
        if i + 1 < len(words):
            gap = words[i+1]["begin_time"] - w["end_time"]
            if gap >= PAUSE_SPLIT_MS:
                flush()
    flush()
    return sents


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, out = sys.argv[1], sys.argv[2]
    model = DEFAULT_MODEL
    if "--model" in sys.argv:
        model = sys.argv[sys.argv.index("--model") + 1]

    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise SystemExit("缺少 DASHSCOPE_API_KEY，请先 env_config 配置")

    print(f"转写中: {src} (model={model})")
    resp = call_asr(src, model, api_key)
    out_obj = resp.get("output", {})
    inner = out_obj.get("output", out_obj)

    # 兼容单句 / 多句两种返回
    raw_sents = inner.get("sentences") or ([inner["sentence"]] if "sentence" in inner else [])
    words = []
    for s in raw_sents:
        words.extend(s.get("words") or [])

    sentences = split_sentences(words)
    if not sentences and raw_sents:
        sentences = [{"begin": s["begin_time"], "end": s["end_time"], "text": s["text"]}
                     for s in raw_sents]

    result = {
        "duration": resp.get("usage", {}).get("duration"),
        "sentences": sentences,
        "words": words,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    print(f"完成: {len(sentences)} 句, {len(words)} 词, 时长 {result['duration']}s")
    for s in sentences[:5]:
        print(f"  [{s['begin']:>5}-{s['end']:>5}] {s['text'][:60]}")
    if len(sentences) > 5:
        print(f"  ... 共 {len(sentences)} 句 -> {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
