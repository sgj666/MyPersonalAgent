#!/usr/bin/env python3
"""反向校验：把切好的每段音频再送回 ASR 转写一次，和页面文本比对。

目的：防止「音频里有、文本里没有」（丢词）或「文本里有、音频里没有」（多词）的低级错误。
例如教材把 "All right. So, we've..." 拆成两句，ASR 合成一句，
如果校正脚本只截取后半句，音频里的 All right 就从文本里消失了 —— 肉眼极难发现。

用法:
    python3 verify_segments.py segments.json speakers.json /path/to/segments/
    python3 verify_segments.py segments.json speakers.json dir --model qwen-audio-3.0-asr-flash
    python3 verify_segments.py ... --sample 5        # 只抽查前 5 句
    python3 verify_segments.py ... --offline        # 不调 API，仅做一致性自检

输出：
    逐句显示 相似度 + 结论（通过 / 丢词 / 多词 / 不匹配），最后给总结论。
    退出码 0 = 全部通过；1 = 有可疑句子。
"""
import sys, os, json, re, base64, difflib, urllib.request, urllib.error

API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
DEFAULT_MODEL = "qwen-audio-3.0-asr-flash"
PASS = 0.80          # 相似度达此值视为通过
CURLY = re.compile(r"[\u2018\u2019]")


def norm(s: str) -> str:
    """归一化：小写、弯引号转直引号、去标点、合并空格。"""
    s = CURLY.sub("'", s or "")
    s = s.lower()
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def words(s: str):
    return norm(s).split()


def transcribe(path: str, model: str, api_key: str) -> str:
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    fmt = os.path.splitext(path)[1].lstrip('.').lower() or 'mp3'
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [
            {"audio": f"data:audio/{fmt};base64,{b64}"}
        ]}]},
        "parameters": {"format": fmt, "sample_rate": "16000", "enable_punctuation": True},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return "__ERROR__ " + str(e.code) + " " + e.read().decode(errors='replace')[:120]
    out = d.get("output", {})
    inner = out.get("output", out)
    if inner.get("text"):
        return inner["text"]
    for s in inner.get("sentences") or ([inner["sentence"]] if "sentence" in inner else []):
        if s.get("text"):
            return s["text"]
    return ""


def judge(expected: str, heard: str):
    """返回 (相似度, 结论, 说明)。"""
    ew, hw = words(expected), words(heard)
    if not hw:
        return 0.0, "ASR失败", "音频转写为空，可能是音频过短或接口异常"
    ratio = difflib.SequenceMatcher(None, ew, hw).ratio()
    missing = [w for w in ew if w not in hw]
    extra = [w for w in hw if w not in ew]
    if ratio >= PASS:
        return ratio, "通过", ""
    if len(missing) > len(extra):
        return ratio, "疑似丢词", "文本有、音频没听到: " + " ".join(missing[:6])
    if len(extra) > len(missing):
        return ratio, "疑似多词", "音频有、文本没有: " + " ".join(extra[:6])
    return ratio, "不匹配", "差异较大，需人工核对"


def main():
    args = [a for a in sys.argv[1:]]
    if len(args) < 3:
        print(__doc__)
        return 2
    seg_p, spk_p, seg_dir = args[0], args[1], args[2]
    model = DEFAULT_MODEL
    if "--model" in args:
        model = args[args.index("--model") + 1]
    offline = "--offline" in args
    sample = 0
    if "--sample" in args:
        sample = int(args[args.index("--sample") + 1])

    # 已知例外：人工确认过「音频与文本措辞不同但属正常」的句子
    # 格式：{"14": "教材写数字 120，音频读 one hundred and twenty，已在中文里补读音"}
    allow = {}
    if "--allow" in args:
        ap = args[args.index("--allow") + 1]
        if os.path.exists(ap):
            allow = json.load(open(ap, encoding='utf-8'))

    segs = json.load(open(seg_p, encoding='utf-8'))
    spk = json.load(open(spk_p, encoding='utf-8')) if os.path.exists(spk_p) else {}

    api_key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not offline and not api_key:
        raise SystemExit("缺少 DASHSCOPE_API_KEY（或加 --offline 只做自检）")

    if sample > 0:
        segs = segs[:sample]

    print(f"反向校验 {len(segs)} 句" + ("（离线自检）" if offline else f" (model={model})"))
    print("-" * 72)

    bad, rows = [], []
    for s in segs:
        idx = s.get("idx")
        expected = s.get("text", "")
        path = os.path.join(seg_dir, s.get("file", ""))
        if not os.path.exists(path):
            rows.append((idx, 0.0, "文件缺失", s.get("file", "")))
            bad.append(rows[-1])
            continue

        if offline:
            # 离线：只检查文件是否为空、时长是否合理
            size = os.path.getsize(path)
            dur = s.get("dur") or 0
            if size < 500:
                rows.append((idx, 0.0, "音频过小", f"{size}B"))
                bad.append(rows[-1])
            elif dur <= 0:
                rows.append((idx, 0.5, "时长为0", ""))
                bad.append(rows[-1])
            else:
                rows.append((idx, 1.0, "文件正常", f"{size}B / {dur:.2f}s"))
            continue

        heard = transcribe(path, model, api_key)
        if heard.startswith("__ERROR__"):
            rows.append((idx, 0.0, "ASR失败", heard[:80]))
            bad.append(rows[-1])
            continue
        ratio, verdict, note = judge(expected, heard)
        voice = spk.get(str(idx), {}).get("name", "")
        if verdict != "通过" and str(idx) in allow:
            verdict = "已知例外"
            note = allow[str(idx)]
        rows.append((idx, ratio, verdict, voice + (" | " + note if note else "")))
        if verdict not in ("通过", "已知例外"):
            bad.append(rows[-1])
            rows[-1] = rows[-1][:3] + (rows[-1][3], )

    for idx, ratio, verdict, note in rows:
        flag = "✓" if verdict in ("通过", "已知例外", "文件正常") else "✗"
        print(f"{flag} [{str(idx).rjust(2)}] {ratio:.2f}  {verdict.ljust(6)} {note}")

    print("-" * 72)
    if bad:
        print(f"❌ 有 {len(bad)} 句可疑，请核对后再交付：")
        for idx, ratio, verdict, note in bad:
            print(f"   [{idx}] {verdict} ({ratio:.2f}) {note}")
        return 1
    print(f"✅ 全部 {len(rows)} 句通过，音频与文本一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
