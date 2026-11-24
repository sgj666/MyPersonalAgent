#!/usr/bin/env python3
"""MP3 帧级精确切割 —— 不依赖 ffmpeg。

背景：本机 ffmpeg 常因动态库问题（如 libunistring ABI 不匹配）卡死，
所以这里纯 Python 解析 MPEG 帧头，按毫秒切割，输出仍是合法 MP3。

用法:
    # 解析总时长
    python3 mp3_cut.py info input.mp3

    # 按句子切（读 sentences.json）
    python3 mp3_cut.py cut input.mp3 sentences.json outdir/

sentences.json 格式（ASR 输出的句子边界，毫秒）:
    [{"begin":1000,"end":7850,"text":"..."}, ...]

输出:
    outdir/seg_01.mp3, seg_02.mp3, ...
    outdir/segments.json  (含 idx/file/begin/end/dur/text)

设计要点:
- 句首前置 PAD_BEGIN 缓冲，避免切掉起音
- 句尾后延 PAD_END，避免切掉尾音
- 每段保留原文件 ID3 头，保证播放器兼容
"""
import sys, json, os, struct

# MPEG1 Layer III 码率表 (kbps)，索引 1..14
BR_TABLE = {1:32,2:40,3:48,4:56,5:64,6:80,7:96,8:112,9:128,10:160,11:192,12:224,13:256,14:320}
SR_TABLE = {0:44100, 1:48000, 2:32000}   # MPEG1 采样率
SPF = 1152                                # MPEG1 Layer III 每帧采样数
PAD_BEGIN = 120                           # ms，句首缓冲
PAD_END = 150                             # ms，句尾余量


def skip_id3(data: bytes) -> int:
    """返回音频起始偏移，跳过 ID3v2 标签。"""
    if data[:3] == b'ID3' and len(data) >= 10:
        size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) \
             | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)
        return 10 + size
    return 0


def parse_frames(data: bytes):
    """解析全部 MPEG1 LayerIII 帧，返回 [(offset, length)]。"""
    start = skip_id3(data)
    frames = []
    pos = start
    n = len(data)
    while pos + 4 <= n:
        h = struct.unpack(">I", data[pos:pos+4])[0]
        # 帧同步：11 个 1
        if (h >> 21) & 0x7FF != 0x7FF:
            break
        ver = (h >> 19) & 0x3      # 3 = MPEG1
        layer = (h >> 17) & 0x3    # 1 = Layer III
        if ver != 3 or layer != 1:
            break
        br_idx = (h >> 12) & 0xF
        sr_idx = (h >> 10) & 0x3
        padding = (h >> 9) & 0x1
        bitrate = BR_TABLE.get(br_idx)
        samplerate = SR_TABLE.get(sr_idx)
        if not bitrate or not samplerate:
            break
        frame_len = int(144 * bitrate * 1000 / samplerate) + padding
        if frame_len < 100:
            break
        frames.append((pos, frame_len))
        pos += frame_len
    return start, frames


def ms_to_frame_idx(ms: float, pad_ms: float, total: int, ms_per_frame: float) -> int:
    """毫秒 -> 帧索引，带边界钳制。"""
    m = max(0.0, ms - pad_ms)
    idx = int(m / ms_per_frame)
    return max(0, min(total - 1, idx))


def cmd_info(path):
    data = open(path, 'rb').read()
    start, frames = parse_frames(data)
    if not frames:
        print("ERROR: 无法解析 MP3 帧（可能不是 MP3，或为 VBR/MPEG2）")
        return 1
    total_s = len(frames) * SPF / 44100
    print(f"文件: {path}")
    print(f"大小: {os.path.getsize(path)/1024:.1f} KB")
    print(f"音频起始偏移: {start} (ID3 {start-10 if start>0 else 0} 字节)")
    print(f"帧数: {len(frames)}")
    print(f"时长: {total_s:.2f} 秒 ({int(total_s//60)}:{total_s%60:05.2f})")
    print(f"每帧: {SPF/44100*1000:.2f} ms")
    return 0


def cmd_cut(path, sent_json, outdir):
    data = open(path, 'rb').read()
    start, frames = parse_frames(data)
    if not frames:
        print("ERROR: 无法解析 MP3 帧")
        return 1
    ms_per_frame = SPF / 44100 * 1000
    raw = json.load(open(sent_json, encoding='utf-8'))
    # 兼容两种输入：ASR 输出对象 {sentences:[...]} 或直接数组 [...]
    if isinstance(raw, dict):
        sents = raw.get('sentences') or raw.get('segments') or []
    else:
        sents = raw
    if not sents:
        print("ERROR: sentences.json 里没有句子数据")
        return 1
    os.makedirs(outdir, exist_ok=True)

    results = []
    for i, s in enumerate(sents, 1):
        b = ms_to_frame_idx(s['begin'], PAD_BEGIN, len(frames), ms_per_frame)
        e = ms_to_frame_idx(s['end'], -PAD_END, len(frames), ms_per_frame)
        e = max(e, b)
        f0 = frames[b][0]
        f1 = frames[e][0] + frames[e][1]
        clip = data[:start] + data[f0:f1]      # 保留 ID3 头
        fn = f"seg_{i:02d}.mp3"
        with open(os.path.join(outdir, fn), 'wb') as fh:
            fh.write(clip)
        dur = round((s['end'] - s['begin']) / 1000, 2)
        results.append({
            "idx": i, "file": fn, "begin": s['begin'], "end": s['end'],
            "dur": dur, "text": s.get('text', ''), "size": len(clip),
        })

    with open(os.path.join(outdir, 'segments.json'), 'w', encoding='utf-8') as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)

    print(f"已切割 {len(results)} 段 -> {outdir}")
    print(f"总大小 {sum(r['size'] for r in results)/1024:.1f} KB")
    for r in results[:3]:
        print(f"  {r['file']} {r['dur']}s | {r['text'][:50]}")
    if len(results) > 3:
        print(f"  ... 共 {len(results)} 段")
    return 0


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == 'info':
        return cmd_info(sys.argv[2])
    if cmd == 'cut':
        if len(sys.argv) < 5:
            print("用法: mp3_cut.py cut input.mp3 sentences.json outdir/")
            return 2
        return cmd_cut(sys.argv[2], sys.argv[3], sys.argv[4])
    print(f"未知命令: {cmd}")
    return 2


if __name__ == '__main__':
    sys.exit(main())
