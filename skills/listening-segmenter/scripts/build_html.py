#!/usr/bin/env python3
"""生成「逐句精听」HTML —— 内置莫兰迪样式 + 选中高亮 + 翻页笔 + 句间停顿。

用法:
    python3 build_html.py segments.json speakers.json output.html [--title "..."] [--topic "..."]

segments.json  —— mp3_cut.py cut 的产物（含 idx/file/begin/dur/text）
speakers.json  —— 说话人映射，见下
输出同目录需有 segments/ 子目录存放 mp3

speakers.json 格式（idx -> {kind, name, ch, gender}）:
    {
      "1":  {"kind":"narr",   "name":"导语",     "ch":"♪", "gender":"n"},
      "4":  {"kind":"stu1",   "name":"Anna",    "ch":"A", "gender":"f"},
      "9":  {"kind":"stu2",   "name":"Mike",    "ch":"M", "gender":"m"}
    }

⚠️ 踩坑记录（务必保留）：
- 每个 kind 必须在 CSS 里有独立的 .w-<kind> .avatar{background:...}，
  漏写会导致「白字+透明底＝头像空白」的 bug。
  本脚本在 generate 时会自动校验，缺色直接报错。
- 字体用 CSS 变量驱动，提供 标准/大/超大 三档。
"""
import sys, json, os, html, re

# ===== 身份配色（男蓝系 / 女红橙系 / 教师深绿 / 导语灰）=====
KIND_STYLE = {
    "narr":    {"avatar": "#9C9E97", "name": "#86887F", "line": "#E2E2DD"},
    "teacher": {"avatar": "#55725F", "name": "#445E4E", "line": "#C9D9CD"},
    "stu1":    {"avatar": "#C2667A", "name": "#A34B60", "line": "#EFD7DE"},
    "stu2":    {"avatar": "#4F7CA6", "name": "#3E6688", "line": "#D5E0EB"},
    "stu3":    {"avatar": "#D08A5A", "name": "#B06E40", "line": "#F0DDCB"},
    "stu4":    {"avatar": "#6B6BA8", "name": "#53538E", "line": "#DDDBEE"},
    "stu5":    {"avatar": "#4E8F92", "name": "#3B7275", "line": "#D3E5E6"},
}

CSS_TEMPLATE = """
:root{--bg:#F4F2ED;--paper:#FFFEFB;--ink:#2E312D;--sub:#6B7069;
  --line:#E2DED4;--sage:#55725F;--sage-d:#445E4E;--warn:#B5784A}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,"SF Pro Text","PingFang SC",system-ui,sans-serif;
  line-height:1.65;padding:28px 16px 80px}
.wrap{max-width:900px;margin:0 auto}
header{background:var(--paper);border:1px solid var(--line);border-radius:14px;
  padding:24px 26px;margin-bottom:18px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h1{margin:0 0 8px;font-size:26px;letter-spacing:.2px}
.sub{color:var(--sub);font-size:15px;line-height:1.7}
.tag{display:inline-block;background:#EAF0EA;color:var(--sage-d);font-size:12px;
  padding:2px 9px;border-radius:99px;margin-right:6px;vertical-align:2px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 20px;align-items:center;
  position:sticky;top:0;z-index:50;background:var(--bg);
  padding:12px 0;border-bottom:1px solid transparent;transition:box-shadow .2s,border-color .2s}
.toolbar.stuck{box-shadow:0 4px 14px rgba(0,0,0,.07);border-bottom-color:var(--line)}
.btn{background:var(--sage);color:#fff;border:0;border-radius:9px;padding:11px 18px;
  font-size:15.5px;cursor:pointer;transition:.15s;font-family:inherit}
.btn:hover{background:var(--sage-d)}
.btn.ghost{background:transparent;color:var(--sage-d);border:1px solid #C7D2C9}
.btn.ghost:hover{background:#EAF0EA}
.gapbox.chk{cursor:pointer;user-select:none}
.gapbox.chk input{width:16px;height:16px;accent-color:#55725F;cursor:pointer}
.gapbox{display:inline-flex;align-items:center;gap:7px;font-size:15px;
  color:var(--sage-d);border:1px solid #C7D2C9;border-radius:9px;padding:7px 12px}
.gapbox select{border:0;background:transparent;font-size:15px;color:var(--sage-d);
  font-family:inherit;cursor:pointer;outline:none;font-weight:600}

/* 字号档位 */
body.sz-standard{--en-size:22px;--zh-size:17px;--name-size:13px;--meta-size:13px;--av:46px}
body.sz-large{--en-size:28px;--zh-size:21px;--name-size:15px;--meta-size:14px;--av:54px}
body.sz-xlarge{--en-size:34px;--zh-size:26px;--name-size:17px;--meta-size:15px;--av:64px}

.line{position:relative;background:var(--paper);border:1px solid var(--line);
  border-radius:12px;padding:18px 20px 18px 26px;margin-bottom:12px;display:grid;
  grid-template-columns:1fr auto;gap:4px 14px;align-items:center;
  transition:background .18s,border-color .18s,box-shadow .18s}
.line:hover{border-color:#C7D2C9}
.line.active{background:#E8F0E9;border-color:var(--sage);
  box-shadow:0 3px 14px rgba(85,114,95,.22),0 0 0 3px #DCE7DE}
.line.active .idx{color:#fff;background:var(--sage);border-radius:6px;padding:1px 7px}
.line.active .en{font-weight:600;color:#22301F}
.line.active::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:5px;
  background:var(--sage);border-radius:0 4px 4px 0}
.line.playing{animation:glow 1.6s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 3px 14px rgba(85,114,95,.22),0 0 0 3px #DCE7DE}
  50%{box-shadow:0 3px 20px rgba(85,114,95,.34),0 0 0 5px #D3E2D6}}
@media(prefers-reduced-motion:reduce){.line.playing{animation:none}}
.line.waiting{background:#F7F4EC;border-color:#D9CFBC}

.meta{grid-column:1/-1;display:flex;align-items:center;gap:9px;
  font-size:var(--meta-size,13px);color:#8F958C;margin-bottom:7px;letter-spacing:.3px}
.idx{font-variant-numeric:tabular-nums;font-weight:600;color:#8F958C}
.time{font-variant-numeric:tabular-nums;opacity:.85}
.bubble{display:flex;gap:14px;align-items:flex-start}
.who{flex:0 0 auto;display:flex;flex-direction:column;align-items:center}
/* 关键：必须有默认背景，防止白字透明底 */
.avatar{width:var(--av,54px);height:var(--av,54px);border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:calc(var(--av,54px)*.42);
  font-weight:700;color:#fff;flex:0 0 auto;background:#8C8F86;
  box-shadow:0 1px 3px rgba(0,0,0,.12);line-height:1}
.name{font-size:var(--name-size,15px);color:var(--sub);white-space:nowrap;
  text-align:center;line-height:1.3;font-weight:600;margin-top:5px}
.say{flex:1;min-width:0;padding-top:2px}
.en{margin:0;font-size:var(--en-size,28px);letter-spacing:.15px;line-height:1.55}
.zh{margin:6px 0 0;font-size:var(--zh-size,21px);color:#4E534C;line-height:1.5}
.ctrl{grid-row:1;grid-column:2;align-self:start;justify-self:end}
.play{background:#EAF0EA;border:0;color:var(--sage-d);border-radius:9px;
  padding:10px 16px;font-size:15px;cursor:pointer;white-space:nowrap;
  transition:.15s;font-family:inherit}
.play:hover{background:#DCE7DE}
.play.on{background:var(--sage);color:#fff}
.hide-zh .zh{display:none}
.hide-en .en{filter:blur(6px);transition:.2s;cursor:pointer}
.hide-en .en.show{filter:none}
footer{text-align:center;color:var(--sub);font-size:13px;margin-top:26px}
@media(max-width:600px){
  .line{grid-template-columns:1fr}
  .ctrl{grid-row:auto;grid-column:1;margin-top:8px;justify-self:start}
}
"""


def build_kind_css(kinds):
    """按实际用到的 kind 生成身份配色，并校验完整性。"""
    out = []
    for k in kinds:
        st = KIND_STYLE.get(k)
        if not st:
            raise SystemExit(f"ERROR: kind '{k}' 没有配色定义，会导致头像空白。"
                             f"请在 KIND_STYLE 里补充。")
        out.append(f".w-{k} .avatar{{background:{st['avatar']}}}")
        out.append(f".w-{k} .name{{color:{st['name']}}}")
        if k == "narr":
            out.append(f".w-{k} .say{{padding-left:16px}}")
        else:
            out.append(f".w-{k} .say{{border-left:3px solid {st['line']};padding-left:13px}}")
    return "\n".join(out)


JS_TEMPLATE = """
const TOTAL=__TOTAL__;
let cur=null, autoplay=false, curIdx=null, gapMode=500, loopOn=true, pendingTimer=null;
function lineOf(i){return document.querySelector('.line[data-i="'+i+'"]');}
function select(i,scroll){
  if(scroll===undefined)scroll=true;
  document.querySelectorAll('.line.active').forEach(e=>e.classList.remove('active'));
  const el=lineOf(i);if(!el)return;
  el.classList.add('active');
  if(scroll){const r=el.getBoundingClientRect();
    if(r.top<90||r.bottom>window.innerHeight-40)el.scrollIntoView({behavior:'smooth',block:'center'});}
}
function markPlaying(i,on){const el=lineOf(i);if(el)el.classList.toggle('playing',on);}
function setBtn(i,on){const el=lineOf(i);if(!el)return;const b=el.querySelector('.play');
  if(b){b.classList.toggle('on',on);b.textContent=on?'❚❚ 播放中':'▶ 播放';}}
function clearWaiting(){if(pendingTimer){clearTimeout(pendingTimer);pendingTimer=null;}
  document.querySelectorAll('.line.waiting').forEach(e=>e.classList.remove('waiting'));}
function playSeg(i){
  const a=document.getElementById('a'+i);if(!a)return;
  clearWaiting();
  if(cur&&cur!==a){cur.pause();cur.currentTime=0;
    if(curIdx!==null){markPlaying(curIdx,false);setBtn(curIdx,false);}}
  if(a.paused){a.play();cur=a;curIdx=i;select(i,true);markPlaying(i,true);setBtn(i,true);}
  else{a.pause();markPlaying(i,false);setBtn(i,false);autoplay=false;}
  a.onended=()=>{
    markPlaying(i,false);setBtn(i,false);
    if(!autoplay){ select(i,false); return; }
    const isLast = (i>=TOTAL);
    // 不循环且已到末句 -> 停下
    if(isLast && !loopOn){ autoplay=false; select(i,false); return; }
    const nx = isLast ? 1 : i+1;
    // 计算停顿：跟读模式 = 本句音频时长 + 0.5s
    let wait = gapMode;
    if(gapMode==='echo'){
      const seg = (a.duration && !isNaN(a.duration)) ? a.duration*1000 : 0;
      wait = seg + 500;
    }
    if(wait>0){
      // 停顿期间：选中仍停在刚读完的句子（学生跟读），只给下一句加"即将播放"提示
      select(i,false);
      const el=lineOf(nx); if(el) el.classList.add('waiting');
      pendingTimer=setTimeout(()=>{pendingTimer=null;
        document.querySelectorAll('.line.waiting').forEach(e=>e.classList.remove('waiting'));
        // 真正要读下一句时，才把选中和滚动切过去
        if(autoplay){ select(nx,true); playSeg(nx); }
      },wait);
    }else{ select(nx,true); playSeg(nx); }
  };
}
function unsetCur(){document.querySelectorAll('.line').forEach(e=>e.classList.remove('playing'));
  document.querySelectorAll('.play.on').forEach(b=>{b.classList.remove('on');b.textContent='▶ 播放';});}
function playAll(){autoplay=true;playSeg(curIdx?curIdx:1);}
function stopAll(){autoplay=false;clearWaiting();if(cur){cur.pause();cur.currentTime=0;}unsetCur();}
function setGap(v){
  gapMode = (v==='echo') ? 'echo' : (parseInt(v,10)||0);
  localStorage.setItem('dictation_gap', gapMode);
}
function setLoop(v){ loopOn=!!v; localStorage.setItem('dictation_loop', loopOn?'1':'0'); }
function prevSeg(){autoplay=false;const n=curIdx?curIdx-1:TOTAL;playSeg(n<1?TOTAL:n);}
function nextSeg(){autoplay=false;const n=curIdx?curIdx+1:1;playSeg(n>TOTAL?1:n);}
function setSize(v){
  document.body.classList.remove('sz-standard','sz-large','sz-xlarge');
  document.body.classList.add('sz-'+v);
  localStorage.setItem('dictation_size',v);
}
function toggleZh(){const hid=document.body.classList.toggle('hide-zh');
  const b=document.getElementById('btnZh');if(b)b.textContent=hid?'中文：已隐藏':'中文：显示';}
function toggleEn(){const hid=document.body.classList.toggle('hide-en');
  const b=document.getElementById('btnEn');
  if(b)b.textContent=hid?'英文：已遮挡（点击揭晓）':'英文：显示';
  document.querySelectorAll('.en').forEach(p=>p.classList.remove('show'));}

document.addEventListener('keydown',e=>{
  const tag=(e.target.tagName||'').toUpperCase();
  if(tag==='SELECT'||tag==='INPUT'||tag==='TEXTAREA')return;
  if(e.ctrlKey||e.metaKey){
    const order=['standard','large','xlarge'];
    const m=document.body.className.match(/sz-(\\w+)/);
    let i=order.indexOf(m?m[1]:'large');
    if(e.key==='='||e.key==='+'){i=Math.min(order.length-1,i+1);e.preventDefault();}
    else if(e.key==='-'){i=Math.max(0,i-1);e.preventDefault();}
    else return;
    const sel=document.getElementById('szSel');if(sel)sel.value=order[i];
    setSize(order[i]);return;
  }
  switch(e.code){
    case 'PageDown':case 'ArrowRight':case 'ArrowDown':
      e.preventDefault();autoplay=false;nextSeg();break;
    case 'PageUp':case 'ArrowLeft':case 'ArrowUp':
      e.preventDefault();autoplay=false;prevSeg();break;
    case 'Space':e.preventDefault();if(curIdx)playSeg(curIdx);else playSeg(1);break;
    case 'Enter':e.preventDefault();playAll();break;
    case 'Escape':e.preventDefault();stopAll();break;
    case 'Home':e.preventDefault();autoplay=false;playSeg(1);break;
    case 'End':e.preventDefault();autoplay=false;playSeg(TOTAL);break;
    default:
      if(/^[1-9]$/.test(e.key)){e.preventDefault();autoplay=false;playSeg(parseInt(e.key,10));}
      else if(e.key==='0'){e.preventDefault();autoplay=false;playSeg(10);}
  }
});
(function(){
  const ss=localStorage.getItem('dictation_size');
  if(ss){setSize(ss);const s=document.getElementById('szSel');if(s)s.value=ss;}
  const sg=localStorage.getItem('dictation_gap');
  if(sg!==null){
    const s=document.getElementById('gapSel'); if(s) s.value=sg;
    gapMode = (sg==='echo') ? 'echo' : (parseInt(sg,10)||0);
  }
  const sl=localStorage.getItem('dictation_loop');
  if(sl!==null){ loopOn = sl==='1'; const c=document.getElementById('loopChk'); if(c) c.checked=loopOn; }
})();

/* 工具栏吸顶检测：滚过顶部后加阴影，视觉上「钉住」 */
(function(){
  const tb=document.querySelector('.toolbar');
  if(!tb) return;
  // 记录工具栏在文档中的初始位置，滚过它才加阴影
  let anchorTop = null;
  const measure=()=>{ anchorTop = tb.getBoundingClientRect().top + window.scrollY; };
  const check=()=>{
    if(anchorTop===null) measure();
    const scrolled = window.scrollY > (anchorTop - 1);
    tb.classList.toggle('stuck', scrolled);
  };
  window.addEventListener('scroll', check, {passive:true});
  window.addEventListener('resize', ()=>{ measure(); check(); });
  setTimeout(measure, 0);
  measure();
  check();
})();
document.querySelectorAll('.en').forEach(p=>p.onclick=()=>p.classList.add('show'));
document.querySelectorAll('.line').forEach(el=>{
  el.addEventListener('click',e=>{
    if(e.target.closest('button'))return;
    playSeg(parseInt(el.dataset.i,10));
  });
});
"""


def mmss(ms):
    s = int(ms // 1000)
    return f"{s//60}:{s%60:02d}"


def generate(segments, speakers, title, topic, subtags):
    kinds = []
    for s in segments:
        k = speakers[str(s['idx'])]['kind']
        if k not in kinds:
            kinds.append(k)
    kind_css = build_kind_css(kinds)

    rows = []
    _no_zh = []
    for s in segments:
        i = s['idx']
        sp = speakers[str(i)]
        # 中文优先取 speakers.json（翻译按句号归属，通常写在这里），
        # 其次取 segments.json，两处都没有则留空但会在下方统一告警
        zh = sp.get('zh') or s.get('zh') or ''
        if not zh.strip():
            _no_zh.append(i)
        rows.append(f"""    <div class="line w-{sp['kind']}" data-i="{i}">
      <div class="meta"><span class="idx">{i:02d}</span><span class="time">{mmss(s['begin'])}</span></div>
      <div class="bubble">
        <div class="who">
          <div class="avatar">{html.escape(sp['ch'])}</div>
          <div class="name">{html.escape(sp['name'])}</div>
        </div>
        <div class="say">
          <p class="en">{html.escape(s['text'])}</p>
          <p class="zh">{html.escape(zh)}</p>
        </div>
        <div class="ctrl">
          <button class="play" onclick="playSeg({i})">▶ 播放</button>
          <audio id="a{i}" preload="none" src="segments/{s['file']}"></audio>
        </div>
      </div>
    </div>""")

    tags = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in subtags)
    total_sec = sum(s['dur'] for s in segments)

    body = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<style>{CSS_TEMPLATE}
/* ===== 身份配色（自动生成，缺一即报错） ===== */
{kind_css}
</style>
</head>
<body class="sz-large">
<div class="wrap">
  <header>
    <h1>{html.escape(title)}</h1>
    <div class="sub">{tags}{html.escape(topic)}</div>
  </header>

  <div class="toolbar">
    <button class="btn" onclick="playAll()">▶ 连续播放全篇</button>
    <button class="btn ghost" onclick="stopAll()">■ 停止</button>
    <button class="btn ghost" onclick="prevSeg()">◀ 上一句</button>
    <button class="btn ghost" onclick="nextSeg()">下一句 ▶</button>
    <label class="gapbox">字号
      <select id="szSel" onchange="setSize(this.value)">
        <option value="standard">标准</option>
        <option value="large" selected>大（投影）</option>
        <option value="xlarge">超大</option>
      </select>
    </label>
    <label class="gapbox">句间停顿
      <select id="gapSel" onchange="setGap(this.value)">
        <option value="0">无停顿</option>
        <option value="500" selected>+0.5 秒</option>
        <option value="800">+0.8 秒</option>
        <option value="1000">+1.0 秒</option>
        <option value="1500">+1.5 秒</option>
        <option value="2000">+2.0 秒</option>
        <option value="echo">跟读（原句时长+0.5s）</option>
      </select>
    </label>
    <label class="gapbox chk">
      <input type="checkbox" id="loopChk" checked onchange="setLoop(this.checked)">
      循环播放
    </label>
    <button class="btn ghost" onclick="toggleZh()" id="btnZh">中文：显示</button>
    <button class="btn ghost" onclick="toggleEn()" id="btnEn">英文：显示</button>
  </div>

  <div id="lines">
{chr(10).join(rows)}
  </div>

  <footer>{len(segments)} 句 · {total_sec:.0f} 秒 · 翻页笔 PageUp/PageDown 切句 · 数字键跳句 · 空格重播</footer>
</div>
<script>{JS_TEMPLATE.replace('__TOTAL__', str(len(segments)))}</script>
</body>
</html>"""
    return body, _no_zh


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    seg_path, spk_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    title = "逐句精听"
    topic = ""
    subtags = []
    for flag, name in (("--title", "title"), ("--topic", "topic")):
        if flag in sys.argv:
            val = sys.argv[sys.argv.index(flag) + 1]
            if name == "title":
                title = val
            else:
                topic = val
    if "--tags" in sys.argv:
        subtags = sys.argv[sys.argv.index("--tags") + 1].split(",")

    segments = json.load(open(seg_path, encoding='utf-8'))
    if isinstance(segments, dict):
        segments = segments.get('segments') or segments.get('sentences') or []
    speakers = json.load(open(spk_path, encoding='utf-8'))

    # 校验：每个 idx 都要有说话人
    missing = [s['idx'] for s in segments if str(s['idx']) not in speakers]
    if missing:
        raise SystemExit(f"ERROR: 这些句子缺说话人映射: {missing}")

    # 校验：音频文件存在
    base = os.path.dirname(os.path.abspath(out_path))
    absent = [s['file'] for s in segments
              if not os.path.exists(os.path.join(base, 'segments', s['file']))]
    if absent:
        print(f"WARNING: 以下音频不存在: {absent[:5]}{'...' if len(absent) > 5 else ''}")

    if not subtags:
        subtags = [f"{len(segments)} 句", "精听"]

    html_out, _no_zh = generate(segments, speakers, title, topic, subtags)
    os.makedirs(base, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html_out)

    print(f"已生成: {out_path}")
    n_kinds = len(set(speakers[str(s['idx'])]['kind'] for s in segments))
    print(f"句子: {len(segments)} | 说话人身份: {n_kinds} 种")
    print(f"大小: {os.path.getsize(out_path)/1024:.1f} KB")

    # 中文缺失保护：静默留空是"改一处坏一处"的典型来源，必须显式报出来
    if _no_zh:
        print(f"⚠️ 警告: {len(_no_zh)}/{len(segments)} 句缺少中文翻译 -> {_no_zh}")
        print("   请在 speakers.json 里补 zh 字段（形如 {\"12\": {..., \"zh\": \"...\"}}）")
        if len(_no_zh) > len(segments) * 0.5:
            print("❌ 超过一半句子没有中文，视为参数错误，中止交付")
            return 1
    else:
        print(f"中文翻译: {len(segments)}/{len(segments)} 句齐全")
    return 0


if __name__ == '__main__':
    sys.exit(main())
