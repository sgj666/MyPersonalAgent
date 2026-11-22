"""Dictation sheets: a self-contained classroom player, plus a printable list.

The teacher projects one word at a time:

- 中文听写 shows the Chinese meaning and speaks it; 英文听写 hides the word and
  only plays it. Both end with the student writing the English word.
- 自动听写 plays each word, waits the chosen interval, then advances.
- The reading is Microsoft's neural voice, embedded as a data URI by
  ``dictation_audio`` so the page also works from a ``file://`` URL offline;
  the browser's speech synthesis is the fallback.

Everything is inline: no fonts, scripts, or audio from the network.
"""
import json
from html import escape

MAX_WORDS = 120


def _text(value, limit):
    if value is None:
        return ''
    return ' '.join(str(value).split())[:limit]


def validate_dictation(draft):
    """Trim the page's draft into the renderer's shape, refusing an empty list."""
    if not isinstance(draft, dict):
        raise ValueError('听写草稿请使用 JSON 对象')
    rows = draft.get('words')
    if not isinstance(rows, list) or not rows:
        raise ValueError('听写草稿至少需要 1 个单词')
    if len(rows) > MAX_WORDS:
        raise ValueError(f'一次最多 {MAX_WORDS} 个单词，请拆成两份')
    words = []
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f'第 {index} 个单词必须是对象')
        word = _text(row.get('word'), 80)
        if not word:
            raise ValueError(f'第 {index} 个单词缺少英文拼写')
        senses = row.get('senses')
        if senses is None:
            # Older drafts carry one pos/meaning pair at the word level.
            pos, meaning = _text(row.get('pos'), 20), _text(row.get('meaning'), 200)
            senses = [{'pos': pos, 'meaning': meaning}] if (pos or meaning) else []
        if not isinstance(senses, list):
            raise ValueError(f'第 {index} 个单词的 senses 必须是数组')
        clean_senses = []
        for sense in senses:
            if not isinstance(sense, dict):
                raise ValueError(f'第 {index} 个单词的词性必须是对象')
            pos, meaning = _text(sense.get('pos'), 20), _text(sense.get('meaning'), 200)
            if pos or meaning:
                clean_senses.append({'pos': pos, 'meaning': meaning})
        words.append({
            'word': word,
            'phonetic': _text(row.get('phonetic'), 60),
            'senses': clean_senses,
            'on': row.get('on') is not False,
        })
    meta = draft.get('meta') if isinstance(draft.get('meta'), dict) else {}
    book = _text(meta.get('book'), 80)
    unit = _text(meta.get('unit'), 80)
    mode = 'en' if meta.get('mode') == 'en' else 'zh'
    title = _text(meta.get('title'), 100) or ' '.join(p for p in (book, unit, '单词听写') if p)
    return {'version': 1, 'meta': {'title': title, 'book': book, 'unit': unit,
                                   'date': _text(meta.get('date'), 20), 'mode': mode},
            'words': words}


CSS = """
:root{
  --paper:#f7f2e8;--paper-2:#fbf8f1;--ink:#20242a;--ink-2:#6b7078;--ink-3:#9aa0a6;
  --line:rgba(32,36,42,.12);--accent:#2f6b4f;--gold:#b08a4a;
  --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;overflow:hidden;
  background:radial-gradient(1200px 620px at 50% -12%,#fffaf0 0,rgba(255,250,240,0) 62%),
             radial-gradient(900px 520px at 102% 112%,#e9f0e9 0,rgba(233,240,233,0) 58%),var(--paper)}
.app{position:relative;display:flex;flex-direction:column;height:100dvh;padding:18px 28px 20px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.24em;color:var(--gold)}
.eyebrow::before{content:"";width:24px;height:1px;background:var(--gold)}
.top h1{margin:7px 0 0;font-size:22px;font-weight:800;letter-spacing:.01em}
.top .sub{margin:5px 0 0;font-size:12.5px;color:var(--ink-2)}
.top-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
.switch{display:inline-flex;padding:3px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.55)}
.mode-btn{border:0;background:none;font:inherit;font-size:12.5px;font-weight:700;color:var(--ink-2);
  padding:6px 15px;border-radius:999px;cursor:pointer;transition:all .15s ease}
.mode-btn.on{background:#fff;color:var(--accent);box-shadow:0 1px 3px rgba(32,36,42,.12)}
.icon-btn{width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;
  border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.55);color:var(--ink-2);cursor:pointer}
.icon-btn:hover{color:var(--accent);border-color:rgba(47,107,79,.45)}
.icon-btn svg{width:16px;height:16px}
.stage{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:12px 0 8px}
.progress{width:min(1000px,100%);display:flex;align-items:center;gap:14px;font-size:12px;color:var(--ink-2);
  letter-spacing:.05em;font-variant-numeric:tabular-nums}
.track{flex:1;height:2px;background:rgba(32,36,42,.1);border-radius:2px;overflow:hidden}
.track i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),#7fae92);transition:width .35s ease}
.word-card{position:relative;width:min(1000px,100%);min-height:min(54vh,480px);
  padding:clamp(28px,5vh,56px) clamp(24px,5vw,72px);display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:clamp(10px,2vh,22px);border:1px solid rgba(32,36,42,.1);border-radius:26px;
  background:linear-gradient(180deg,rgba(255,255,255,.88),rgba(255,255,255,.62));
  box-shadow:0 26px 64px -34px rgba(32,36,42,.38),0 1px 0 #fff inset}
.word-card::before{content:"";position:absolute;inset:12px;border:1px solid rgba(176,138,74,.16);
  border-radius:18px;pointer-events:none}
.kicker{margin:0;font-size:11px;font-weight:700;letter-spacing:.26em;color:var(--ink-3)}
.prompt{text-align:center}
.prompt-zh{display:flex;flex-direction:column;align-items:center;gap:clamp(6px,1.2vh,14px)}
.prompt-zh .sense{display:flex;align-items:baseline;gap:clamp(8px,1.2vw,16px);font-family:var(--serif);
  font-size:clamp(46px,8.4vw,122px);line-height:1.12;font-weight:600;letter-spacing:.02em;text-wrap:balance}
.prompt-zh .sense .pos{flex:none;font-family:var(--sans);font-size:clamp(13px,1.5vw,21px);
  font-weight:800;color:var(--gold);letter-spacing:.06em}
.prompt-zh.is-multi{display:inline-grid;grid-template-columns:auto auto;gap:8px 20px;align-items:baseline}
.prompt-zh.is-multi .sense{display:contents;font-size:clamp(32px,5.4vw,82px)}
.prompt-zh.is-multi .mean{text-align:left}
.prompt-zh.is-empty{font-size:clamp(28px,4.6vw,56px);color:var(--ink-3)}
.prompt-en{display:flex;flex-direction:column;align-items:center;gap:16px}
body.mode-zh .prompt-en,body.mode-en .prompt-zh{display:none}
.big-say{width:clamp(112px,15vw,170px);height:clamp(112px,15vw,170px);border-radius:999px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;color:var(--accent);
  border:1px solid rgba(47,107,79,.35);background:radial-gradient(circle at 50% 34%,#fff,#e9f0e9);
  box-shadow:0 16px 38px -18px rgba(47,107,79,.55);transition:transform .15s ease}
.big-say:hover{transform:translateY(-2px)}
.big-say svg{width:40%;height:40%}
.en-hint{margin:0;font-size:12.5px;font-weight:600;letter-spacing:.2em;color:var(--ink-2)}
.answer{display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:clamp(4px,1vh,10px)}
.answer[hidden]{display:none}
.a-word{margin:0;font-family:var(--serif);font-size:clamp(34px,5.6vw,76px);font-weight:700;color:var(--accent);letter-spacing:.02em}
.a-phon{margin:2px 0 0;font-size:15px;color:var(--ink-2);letter-spacing:.03em}
.a-senses{display:flex;flex-direction:column;gap:3px;margin-top:4px;font-size:15px;color:var(--ink-2)}
.a-senses[hidden]{display:none}
.a-senses .a-sense{margin:0}
.a-senses b{margin-right:6px;font-family:var(--sans);font-size:12px;font-weight:800;color:var(--gold)}
.replay{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:rgba(255,255,255,.7);
  color:var(--ink-2);font:inherit;font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:999px;cursor:pointer;
  white-space:nowrap}
.replay svg{width:15px;height:15px;flex:none}
.replay:hover{color:var(--accent);border-color:rgba(47,107,79,.4)}
.countdown{margin:0;font-size:12px;font-weight:700;letter-spacing:.12em;color:var(--gold);min-height:18px}
.hint{margin:0;font-size:12px;color:var(--ink-3);letter-spacing:.03em}
.controls{display:flex;align-items:center;gap:10px;width:min(1000px,100%);margin:0 auto}
.ctrl{height:46px;padding:0 20px;border-radius:999px;border:1px solid var(--line);background:rgba(255,255,255,.72);
  color:var(--ink);font:inherit;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;
  white-space:nowrap}
.ctrl svg{width:16px;height:16px;flex:none}
.ctrl:hover{border-color:rgba(47,107,79,.4);color:var(--accent)}
.ctrl.primary{min-width:160px;justify-content:center;color:#fff;background:var(--accent);border-color:var(--accent);
  box-shadow:0 14px 28px -16px rgba(47,107,79,.85)}
.ctrl.primary:hover{background:#285c44;color:#fff}
.ctrl.ghost{background:none}
.ctrl:disabled{opacity:.4;cursor:default}
.spacer{flex:1}
.settings{position:absolute;top:68px;right:28px;width:300px;z-index:6;padding:18px 18px 14px;border-radius:18px;
  border:1px solid var(--line);background:#fffdf8;box-shadow:0 28px 60px -24px rgba(32,36,42,.45)}
.settings[hidden]{display:none}
.settings h2{margin:0 0 6px;font-size:14px;font-weight:800;letter-spacing:.04em}
.settings label{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;
  font-size:13px;border-bottom:1px dashed var(--line)}
.settings select{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:#fff}
.settings .note{margin:10px 0 0;font-size:11.5px;line-height:1.5;color:var(--ink-3)}
.settings .close{margin-top:12px;width:100%;height:36px;border-radius:10px;border:0;background:var(--accent);color:#fff;
  font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.done{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;background:rgba(247,242,232,.94);backdrop-filter:blur(6px)}
.done[hidden]{display:none}
.done .eyebrow{color:var(--accent)}
.done h2{margin:0;font-family:var(--serif);font-size:clamp(38px,5.4vw,66px);font-weight:700}
.done p{margin:0;font-size:14px;color:var(--ink-2)}
.summary{position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;
  background:rgba(247,242,232,.985);backdrop-filter:blur(8px)}
.summary[hidden]{display:none}
.summary-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
  padding:18px 28px;border-bottom:1px solid var(--line)}
.summary-head h2{margin:6px 0 0;font-family:var(--serif);font-size:24px;font-weight:700}
.summary-head p{margin:4px 0 0;font-size:12.5px;color:var(--ink-2)}
.summary-actions{display:flex;gap:8px;flex-wrap:wrap}
.summary-view{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;gap:14px;padding:14px 22px}
.summary-img{max-width:100%;max-height:100%;width:auto;height:auto;border-radius:14px;background:#fffdf7;
  box-shadow:0 24px 60px -32px rgba(32,36,42,.5)}
.summary-nav{flex:none;width:44px;height:44px;border-radius:999px;border:1px solid var(--line);
  background:rgba(255,255,255,.7);color:var(--ink-2);font:inherit;font-size:22px;line-height:1;
  cursor:pointer;display:flex;align-items:center;justify-content:center}
.summary-nav:hover{border-color:rgba(47,107,79,.4);color:var(--accent)}
.summary-nav:disabled{opacity:.3;cursor:default}
.summary-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 28px 12px;
  font-size:12px;color:var(--ink-2)}
.summary-head .note{max-width:520px}
.done .controls{flex-wrap:wrap;justify-content:center}
.print-sheet{display:none}
@media (max-width:820px){
  .app{padding:14px 16px 16px}
  .controls{flex-wrap:wrap}
  .ctrl.primary{order:-1;flex:1}
  .ctrl.ghost{display:none}
  .top .sub{display:none}
}
@media (max-height:640px){
  .word-card{min-height:42vh}
  .replay{padding:6px 14px}
}
@page{size:A4;margin:14mm}
@media print{
  body{overflow:visible;background:#fff}
  .app,.done,.settings,.summary{display:none!important}
  .print-sheet{display:block;color:#111;font-family:var(--sans)}
  .print-sheet .head h1{margin:0;font-size:22px}
  .print-sheet .head p{margin:4px 0 0;font-size:12px;color:#555}
  .print-sheet ol{display:grid;grid-template-columns:1fr 1fr;gap:0 26px;list-style:none;margin:16px 0 0;padding:0}
  .print-sheet li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:0 8px;padding:8px 0 6px;
    border-bottom:1px dashed #ccc;break-inside:avoid;page-break-inside:avoid}
  .print-sheet .no{font-size:12px;font-weight:700;color:#666;font-variant-numeric:tabular-nums}
  .print-sheet .p{margin:0;font-size:14px;font-weight:600;display:block}
  .print-sheet .line{display:block;height:1.4em;margin-top:3px;border-bottom:1px solid #bbb}
  .print-sheet .ans{display:none;margin-top:3px;font-size:12px;font-weight:700;color:#2f6b4f}
  body.mode-en .print-sheet .p-zh{display:none}
  body.mode-zh .print-sheet .p-en{display:none}
  body.answers-on .print-sheet .ans{display:block}
}
"""

ICONS = {
    'speaker': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.2L12 18V6L7.2 9.5H4z"/><path d="M15.5 8.8a4.6 4.6 0 0 1 0 6.4"/><path d="M18.2 6.2a8.2 8.2 0 0 1 0 11.6"/></svg>',
    'play': '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12 8 5.2z"/></svg>',
    'pause': '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/></svg>',
    'gear': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    'full': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
}

PLAYER = """
(function () {
  var DATA = JSON.parse(document.getElementById('dict-data').textContent);
  var META = JSON.parse(document.getElementById('dict-meta').textContent);
  var state = { i: 0, mode: 'MODE', answer: false, auto: false, interval: 6, repeat: 2, order: [] };
  var token = 0, audioEl = null, timer = null;
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), counter = $('counter'), bar = $('bar'), label = $('label');
  var promptZh = $('prompt-zh'), answer = $('answer');
  var aWord = $('a-word'), aPhon = $('a-phon'), aSenses = $('a-senses');
  var countdownEl = $('countdown'), autoBtn = $('auto'), answerBtn = $('answer-btn');
  var replayBtn = $('replay'), bigSay = $('big-say');

  try {
    var saved = JSON.parse(localStorage.getItem('dictation-player') || '{}');
    ['interval', 'repeat'].forEach(function (key) {
      if (saved[key]) state[key] = saved[key];
    });
    if (saved.mode === 'zh' || saved.mode === 'en') state.mode = saved.mode;
    $('interval').value = String(state.interval);
    $('repeat').value = String(state.repeat);
  } catch (_) { /* private mode: keep defaults */ }

  function buildOrder() {
    state.order = DATA.map(function (_, i) { return i; });
    if ($('shuffle').checked) {
      for (var i = state.order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = state.order[i]; state.order[i] = state.order[j]; state.order[j] = t;
      }
    }
    state.i = 0;
  }

  function item() { return DATA[state.order[state.i]] || DATA[0]; }

  function render() {
    var word = item();
    var total = state.order.length;
    counter.textContent = (state.i + 1) + ' / ' + total;
    bar.style.width = (((state.i + 1) / total) * 100) + '%';
    label.textContent = '第 ' + (state.i + 1) + ' 题';
    renderPrompt(word);
    aWord.textContent = word.word;
    aPhon.textContent = word.phonetic || '';
    aPhon.hidden = !word.phonetic;
    aSenses.innerHTML = '';
    word.senses.forEach(function (sense) {
      var line = document.createElement('p');
      line.className = 'a-sense';
      if (sense.pos) {
        var pos = document.createElement('b');
        pos.textContent = sense.pos;
        line.appendChild(pos);
      }
      line.appendChild(document.createTextNode(sense.meaning || '—'));
      aSenses.appendChild(line);
    });
    aSenses.hidden = state.mode === 'zh' || !word.senses.length;
    answer.hidden = !state.answer;
    answerBtn.textContent = state.answer ? '隐藏答案' : '显示答案';
    document.body.classList.toggle('mode-zh', state.mode === 'zh');
    document.body.classList.toggle('mode-en', state.mode === 'en');
    document.body.classList.toggle('answers-on', state.answer);
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-mode') === state.mode);
    });
    document.getElementById('mode-tag').textContent = state.mode === 'zh' ? '中文听写' : '英文听写';
    updateAutoButton();
  }

  /** 中文听写 shows every sense, with its part of speech before the meaning. */
  function renderPrompt(word) {
    promptZh.innerHTML = '';
    promptZh.classList.toggle('is-multi', word.senses.length > 1);
    promptZh.classList.toggle('is-empty', !word.senses.length);
    if (!word.senses.length) {
      promptZh.textContent = '（本题没有中文释义）';
      return;
    }
    word.senses.forEach(function (sense) {
      var line = document.createElement('span');
      line.className = 'sense';
      if (sense.pos) {
        var pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = sense.pos;
        line.appendChild(pos);
      }
      var mean = document.createElement('span');
      mean.className = 'mean';
      mean.textContent = sense.meaning || '—';
      line.appendChild(mean);
      promptZh.appendChild(line);
    });
  }

  function updateAutoButton() {
    autoBtn.innerHTML = (state.auto ? ICON_PAUSE : ICON_PLAY) + '<span>' +
      (state.auto ? '暂停' : state.i > 0 || state.answer ? '继续自动听写' : '自动听写') + '</span>';
  }

  var ICON_PLAY = document.getElementById('icon-play').innerHTML;
  var ICON_PAUSE = document.getElementById('icon-pause').innerHTML;

  function stopAudio() {
    token += 1;
    if (audioEl) { try { audioEl.pause(); } catch (_) {} audioEl = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function speakText(text, lang, done) {
    if (!('speechSynthesis' in window) || !text) { done(); return; }
    var mine = token;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.85;
    var voice = (window.speechSynthesis.getVoices() || []).filter(function (v) {
      return v.lang && v.lang.replace('_', '-').indexOf(lang) === 0;
    })[0];
    if (voice) u.voice = voice;
    u.onend = function () { if (mine === token) done(); };
    u.onerror = function () { if (mine === token) done(); };
    window.speechSynthesis.speak(u);
  }

  /** Play one clip or fall back to the system voice, then call `done`. */
  function playClip(uri, text, lang, done) {
    var mine = token;
    if (!uri) { speakText(text, lang, done); return; }
    var el = new Audio(uri);
    audioEl = el;
    el.onended = function () { if (mine === token) done(); };
    el.onerror = function () { if (mine === token) speakText(text, lang, done); };
    el.play().catch(function () {
      if (mine === token) speakText(text, lang, done);
    });
  }

  function playOnce(done) {
    var word = item();
    if (state.mode === 'en') {
      playClip(word.enAudio, word.word, 'en-US', done);
      return;
    }
    // One sense at a time, with a pause between them: "名词 苹果 … 动词 呈现".
    var mine = token;
    var index = 0;
    var senses = word.senses.length ? word.senses : [{ read: '', zhAudio: '' }];
    (function next() {
      if (mine !== token) return;
      if (index >= senses.length) { done(); return; }
      var sense = senses[index++];
      playClip(sense.zhAudio, sense.read, 'zh-CN', function () {
        if (mine !== token) return;
        if (index >= senses.length) { done(); return; }
        timer = setTimeout(next, 650);
      });
    })();
  }

  function playRepeats(times, done) {
    var mine = token;
    var left = Math.max(1, times);
    function round() {
      if (mine !== token) return;
      playOnce(function () {
        if (mine !== token) return;
        left -= 1;
        if (left > 0) timer = setTimeout(round, 450);
        else done();
      });
    }
    round();
  }

  function playCurrent() {
    stopAudio();
    playRepeats(1, function () {});
  }

  function countdown(seconds) {
    var mine = token;
    var left = seconds;
    countdownEl.hidden = false;
    (function step() {
      if (mine !== token || !state.auto) return;
      countdownEl.textContent = left > 0 ? left + ' 秒后下一个' : '';
      if (left <= 0) { countdownEl.hidden = true; advance(true); return; }
      left -= 1;
      timer = setTimeout(step, 1000);
    })();
  }

  function tick() {
    stopAudio();
    if (!state.auto) return;
    var mine = token;
    playRepeats(state.repeat, function () {
      if (mine !== token || !state.auto) return;
      countdown(state.interval);
    });
  }

  function advance(automatic) {
    stopAudio();
    if (state.i >= state.order.length - 1) {
      if (automatic) finish();
      return;
    }
    state.i += 1;
    state.answer = false;
    render();
    if (state.auto) tick(); else playCurrent();
  }

  function back() {
    stopAuto();
    if (state.i > 0) state.i -= 1;
    state.answer = false;
    render();
    playCurrent();
  }

  function stopAuto() {
    state.auto = false;
    stopAudio();
    countdownEl.hidden = true;
    updateAutoButton();
  }

  function finish() {
    state.auto = false;
    stopAudio();
    countdownEl.hidden = true;
    updateAutoButton();
    $('done').hidden = false;
    $('done-count').textContent = '共 ' + state.order.length + ' 个单词';
  }

  function restart() {
    $('done').hidden = true;
    state.i = 0;
    state.answer = false;
    render();
  }

  function toggleAuto() {
    if (state.auto) { stopAuto(); return; }
    if (!$('done').hidden) restart();
    state.auto = true;
    updateAutoButton();
    tick();
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    stopAuto();
    state.mode = mode;
    state.answer = false;
    try {
      var saved = JSON.parse(localStorage.getItem('dictation-player') || '{}');
      saved.mode = mode;
      localStorage.setItem('dictation-player', JSON.stringify(saved));
    } catch (_) {}
    render();
    playCurrent();
  }

  function go(delta) {
    stopAuto();
    var next = state.i + delta;
    if (next >= state.order.length) { finish(); return; }
    if (next < 0) return;
    state.i = next;
    state.answer = false;
    render();
    playCurrent();
  }

  $('next').addEventListener('click', function () { go(1); });
  $('prev').addEventListener('click', back);
  $('auto').addEventListener('click', toggleAuto);
  replayBtn.addEventListener('click', playCurrent);
  bigSay.addEventListener('click', playCurrent);
  answerBtn.addEventListener('click', function () {
    state.answer = !state.answer;
    render();
  });
  document.querySelectorAll('.mode-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); });
  });
  $('settings-btn').addEventListener('click', function () { $('settings').hidden = !$('settings').hidden; });
  $('close-settings').addEventListener('click', function () { $('settings').hidden = true; });
  $('interval').addEventListener('change', function (e) {
    state.interval = Number(e.target.value) || 6;
    persist();
  });
  $('repeat').addEventListener('change', function (e) {
    state.repeat = Number(e.target.value) || 1;
    persist();
  });
  $('shuffle').addEventListener('change', function () {
    stopAuto(); buildOrder(); render();
  });
  $('print').addEventListener('click', function () { window.print(); });
  $('fullscreen').addEventListener('click', function () {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  });
  $('restart').addEventListener('click', function () {
    restart();
  });
  $('done-restart').addEventListener('click', function () {
    restart();
    state.auto = true;
    updateAutoButton();
    tick();
  });
  $('summary-open').addEventListener('click', openSummary);
  $('summary-back').addEventListener('click', function () {
    $('summary').hidden = true;
  });
  $('summary-save').addEventListener('click', saveAllImages);
  $('summary-save-one').addEventListener('click', saveCurrentImage);
  $('summary-prev').addEventListener('click', function () { showSummaryPage(state.summaryPage - 1); });
  $('summary-next').addEventListener('click', function () { showSummaryPage(state.summaryPage + 1); });
  $('summary-full').addEventListener('click', function () {
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  });

  function summaryName(index) {
    var safe = (document.title || '单词听写').replace(/[\\/:*?"<>|]/g, '-');
    return safe + '-汇总-' + (index + 1) + '.png';
  }

  function download(url, name) {
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function saveCurrentImage() {
    if (!state.summaryUrls || !state.summaryUrls.length) return;
    download(state.summaryUrls[state.summaryPage], summaryName(state.summaryPage));
  }

  function saveAllImages() {
    if (!state.summaryUrls || !state.summaryUrls.length) return;
    state.summaryUrls.forEach(function (url, index) {
      setTimeout(function () { download(url, summaryName(index)); }, index * 500);
    });
    $('summary-note').textContent = '已生成 ' + state.summaryUrls.length + ' 张图片；若浏览器拦截多文件下载，请允许后重试，或用「保存本页」。';
  }

  function openSummary() {
    stopAudio();
    var pages = buildSummaryPages();
    state.summaryUrls = pages.map(function (canvas) { return canvas.toDataURL('image/png'); });
    state.summaryPage = 0;
    $('summary-title').textContent = '听写汇总 · 共 ' + state.order.length + ' 词';
    $('summary-note').textContent = '按听写顺序排列；内容超出一页会自动分页。';
    $('summary').hidden = false;
    showSummaryPage(0);
    // This runs from the teacher's click, so the browser lets the summary take
    // the whole screen — it is a projection surface, not a dialog.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  }

  function showSummaryPage(index) {
    if (!state.summaryUrls || !state.summaryUrls.length) return;
    var last = state.summaryUrls.length - 1;
    state.summaryPage = Math.max(0, Math.min(last, index));
    $('summary-img').src = state.summaryUrls[state.summaryPage];
    $('summary-counter').textContent = '第 ' + (state.summaryPage + 1) + ' / ' + state.summaryUrls.length + ' 页';
    $('summary-prev').disabled = state.summaryPage === 0;
    $('summary-next').disabled = state.summaryPage === last;
  }

  // ---- summary images: landscape 16:9, two columns, six rows per column ----
  // The sheet is for a classroom projector, so the type is deliberately large
  // and a page holds less; long lists get more pages, not smaller text.

  var PAGE_W = 1920, PAGE_H = 1080, PAGE_PAD = 80;
  var SERIF = '"Songti SC","Noto Serif SC",Georgia,serif';
  var SANS = '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
  var BUDGET = 800, ROWS_PER_PAGE = 8;

  function summaryFont(ctx, size, weight, family) {
    ctx.font = (weight || 400) + ' ' + size + 'px ' + (family || SANS);
  }

  /** Greedy wrap that keeps Latin words whole and breaks CJK per character. */
  function wrapText(ctx, text, maxWidth) {
    var tokens = String(text || '').match(/[A-Za-z0-9'’.\-\/\[\]]+|[\u4e00-\u9fff]|\S/g) || [];
    var lines = [], line = '';
    function join(a, b) {
      if (!a) return b;
      return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b;
    }
    tokens.forEach(function (token) {
      var next = join(line, token);
      if (ctx.measureText(next).width <= maxWidth) { line = next; return; }
      if (line) lines.push(line);
      if (ctx.measureText(token).width > maxWidth) {
        var chunk = '';
        Array.from(token).forEach(function (ch) {
          if (ctx.measureText(chunk + ch).width > maxWidth) { lines.push(chunk); chunk = ch; }
          else chunk += ch;
        });
        line = chunk;
      } else line = token;
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function summaryRows(ctx) {
    return state.order.map(function (dataIndex, index) {
      var word = DATA[dataIndex];
      var prompt = [];
      if (state.mode === 'zh') {
        if (!word.senses.length) prompt = [{ pos: '', lines: ['（未填中文释义）'] }];
        word.senses.forEach(function (sense) {
          summaryFont(ctx, 60, 600, SERIF);
          prompt.push({ pos: sense.pos || '', lines: wrapText(ctx, sense.meaning || '—', 760) });
        });
      } else {
        prompt = [{ pos: '', lines: ['（听写发音）'] }];
      }
      summaryFont(ctx, 60, 700, SERIF);
      var answer = wrapText(ctx, word.word, 450);
      var senses = [];
      if (state.mode === 'en') {
        summaryFont(ctx, 32, 400, SANS);
        word.senses.forEach(function (sense) {
          var text = (sense.pos ? sense.pos + '   ' : '') + (sense.meaning || '');
          senses = senses.concat(wrapText(ctx, text, 740));
        });
      }
      var promptHeight = prompt.reduce(function (sum, sense) {
        return sum + Math.max(1, sense.lines.length) * 70 + 6;
      }, 0);
      var answerHeight = answer.length * 70 + senses.length * 36 + 6;
      return {
        no: index + 1,
        prompt: prompt,
        answer: answer,
        phonetic: word.phonetic || '',
        senses: senses,
        height: Math.max(promptHeight, answerHeight) + 12
      };
    });
  }

  function buildSummaryPages() {
    var measure = document.createElement('canvas').getContext('2d');
    var rows = summaryRows(measure);
    var pages = [], current = [], used = 0;
    rows.forEach(function (row) {
      if (current.length && (current.length >= ROWS_PER_PAGE || used + row.height > BUDGET)) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push(row);
      used += row.height;
    });
    if (current.length) pages.push(current);
    return pages.map(function (page, index) { return drawSummaryPage(page, index + 1, pages.length); });
  }

  function drawRow(ctx, row, y) {
    var x = PAGE_PAD;
    ctx.fillStyle = '#9aa0a6';
    summaryFont(ctx, 34, 700, SANS);
    ctx.fillText(String(row.no).padStart(2, '0'), x, y + 6);

    var py = y;
    row.prompt.forEach(function (sense) {
      if (sense.pos) {
        ctx.fillStyle = '#b08a4a';
        summaryFont(ctx, 34, 700, SANS);
        ctx.fillText(sense.pos, x + 90, py + 14);
      }
      ctx.fillStyle = state.mode === 'en' ? '#9aa0a6' : '#20242a';
      summaryFont(ctx, 56, 600, SERIF);
      sense.lines.forEach(function (line, i) {
        ctx.fillText(line, x + 186, py + i * 70);
      });
      py += Math.max(1, sense.lines.length) * 70 + 6;
    });

    var ax = x + 990;
    ctx.fillStyle = '#2f6b4f';
    summaryFont(ctx, 56, 700, SERIF);
    row.answer.forEach(function (line, i) {
      ctx.fillText(line, ax, y + i * 70);
    });
    if (row.phonetic) {
      ctx.fillStyle = '#6b7078';
      summaryFont(ctx, 32, 400, SANS);
      ctx.fillText(row.phonetic, ax + 480, y + 4);
    }
    ctx.fillStyle = '#6b7078';
    summaryFont(ctx, 32, 400, SANS);
    row.senses.forEach(function (line, i) {
      ctx.fillText(line, ax, y + row.answer.length * 70 + i * 36);
    });
  }

  function drawSummaryPage(rows, pageNo, pageCount) {
    var canvas = document.createElement('canvas');
    canvas.width = PAGE_W;
    canvas.height = PAGE_H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    ctx.fillStyle = '#b08a4a';
    summaryFont(ctx, 20, 700, SANS);
    ctx.fillText('单 词 听 写 · 汇 总', PAGE_PAD, 54);
    ctx.fillStyle = '#20242a';
    summaryFont(ctx, 60, 700, SERIF);
    ctx.fillText(document.title, PAGE_PAD, 110);
    ctx.strokeStyle = '#ded7c8';
    ctx.beginPath();
    ctx.moveTo(PAGE_PAD, 150);
    ctx.lineTo(PAGE_W - PAGE_PAD, 150);
    ctx.stroke();

    var y = 215;
    rows.forEach(function (row) {
      drawRow(ctx, row, y);
      ctx.strokeStyle = '#ece5d8';
      ctx.setLineDash([6, 7]);
      ctx.beginPath();
      ctx.moveTo(PAGE_PAD, y + row.height - 10);
      ctx.lineTo(PAGE_W - PAGE_PAD, y + row.height - 10);
      ctx.stroke();
      ctx.setLineDash([]);
      y += row.height;
    });

    ctx.fillStyle = '#9aa0a6';
    summaryFont(ctx, 18, 400, SANS);
    ctx.fillText((META.book || '') + (META.unit ? ' · ' + META.unit : '') + ' · 共 ' + DATA.length + ' 词',
      PAGE_PAD, PAGE_H - 40);
    ctx.textAlign = 'right';
    ctx.fillText('第 ' + pageNo + ' / ' + pageCount + ' 页', PAGE_W - PAGE_PAD, PAGE_H - 40);
    ctx.textAlign = 'left';
    return canvas;
  }

  function persist() {
    try {
      var saved = JSON.parse(localStorage.getItem('dictation-player') || '{}');
      saved.interval = state.interval;
      saved.repeat = state.repeat;
      saved.mode = state.mode;
      localStorage.setItem('dictation-player', JSON.stringify(saved));
    } catch (_) {}
  }

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'select' || tag === 'input' || tag === 'textarea') return;
    if (!$('summary').hidden) {
      if (e.key === 'ArrowRight') { e.preventDefault(); showSummaryPage(state.summaryPage + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); showSummaryPage(state.summaryPage - 1); }
      else if (e.key === 'Escape') { $('summary').hidden = true; }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === ' ') {
      if (tag === 'button') return;
      e.preventDefault(); playCurrent();
    } else if (e.key === 'a' || e.key === 'A') { state.answer = !state.answer; render(); }
    else if (e.key === 'f' || e.key === 'F') { $('fullscreen').click(); }
    else if (e.key === 'Escape') { $('settings').hidden = true; }
  });

  var hasAudio = DATA.some(function (word) {
    return word.enAudio || word.senses.some(function (sense) { return sense.zhAudio; });
  });
  $('audio-note').textContent = hasAudio
    ? '标准发音已内置，断网也能播放。'
    : '当前是预览，未预载标准发音；保存后在浏览器打开即可离线播放。';
  buildOrder();
  render();
})();
"""


def render_dictation_html(draft, audio=None):
    """The classroom player as one HTML file; only the selected words are used.

    ``audio`` maps ``<lang>:<text>`` to a data URI (see ``dictation_audio``).
    Missing clips simply fall back to the browser's speech synthesis.
    """
    draft = validate_dictation(draft)
    meta = draft['meta']
    words = [word for word in draft['words'] if word['on']]
    if not words:
        raise ValueError('请至少选择一个单词再生成听写单')
    audio = audio or {}
    warnings = []
    missing_meaning = sum(1 for word in words if not any(s['meaning'] for s in word['senses']))
    if missing_meaning:
        warnings.append(f'{missing_meaning} 个单词没有中文释义，中文听写会留空')
    mode = meta['mode']
    subtitle = ' · '.join(part for part in (meta['book'], meta['unit']) if part)

    from agent.teaching.render.dictation_audio import read_text

    data = []
    for word in words:
        senses = [{
            'pos': sense['pos'],
            'meaning': sense['meaning'],
            'read': read_text(sense),
            'zhAudio': audio.get('zh:' + read_text(sense), ''),
        } for sense in word['senses']]
        data.append({'word': word['word'], 'phonetic': word['phonetic'],
                     'senses': senses, 'enAudio': audio.get('en:' + word['word'], '')})
    payload = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e')
    meta_payload = json.dumps({'title': meta['title'], 'book': meta['book'], 'unit': meta['unit'],
                               'date': meta['date'], 'mode': mode},
                              ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e')

    def sense_line(sense):
        return ' '.join(part for part in (sense['pos'], sense['meaning']) if part)

    print_rows = ''.join(
        f'<li><span class="no">{number}</span><span class="cell">'
        f'<span class="p p-zh">{"<br>".join(escape(sense_line(s)) for s in word["senses"]) or "（未填中文释义）"}</span>'
        f'<span class="p p-en"></span><span class="line"></span>'
        f'<span class="ans">{escape(word["word"])}'
        f'{" " + escape(word["phonetic"]) if word["phonetic"] else ""}'
        f'{"；" + escape("；".join(sense_line(s) for s in word["senses"])) if word["senses"] else ""}</span></span></li>'
        for number, word in enumerate(words, 1))

    settings = ''.join(f'<option value="{value}">{label}</option>'
                       for value, label in ((4, '4 秒'), (6, '6 秒'), (8, '8 秒'), (10, '10 秒'), (15, '15 秒')))
    repeats = ''.join(f'<option value="{value}">{label}</option>'
                      for value, label in ((1, '1 遍'), (2, '2 遍'), (3, '3 遍')))

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(meta['title'])}</title>
<style>{CSS}</style>
</head>
<body class="mode-{mode}">
<div class="app">
  <header class="top">
    <div>
      <span class="eyebrow">单词听写</span>
      <h1>{escape(meta['title'])}</h1>
      <p class="sub">{escape(subtitle)}{' · ' + escape(meta['date']) if meta['date'] else ''} · 共 {len(words)} 词</p>
    </div>
    <div class="top-right">
      <div class="switch" role="group" aria-label="听写模式">
        <button type="button" class="mode-btn" data-mode="zh">中文听写</button>
        <button type="button" class="mode-btn" data-mode="en">英文听写</button>
      </div>
      <button type="button" class="icon-btn" id="settings-btn" aria-label="设置">{ICONS['gear']}</button>
      <button type="button" class="icon-btn" id="fullscreen" aria-label="全屏">{ICONS['full']}</button>
    </div>
  </header>

  <main class="stage" id="stage">
    <div class="progress">
      <span id="counter">1 / {len(words)}</span>
      <div class="track"><i id="bar"></i></div>
      <span id="mode-tag">单词听写</span>
    </div>
    <section class="word-card">
      <p class="kicker" id="label">第 1 题</p>
      <div class="prompt prompt-zh" id="prompt-zh"></div>
      <div class="prompt prompt-en">
        <button type="button" class="big-say" id="big-say" aria-label="播放发音">{ICONS['speaker']}</button>
        <p class="en-hint">听发音 · 写单词</p>
      </div>
      <div class="answer" id="answer" hidden>
        <p class="a-word" id="a-word"></p>
        <p class="a-phon" id="a-phon"></p>
        <div class="a-senses" id="a-senses"></div>
      </div>
      <button type="button" class="replay" id="replay">{ICONS['speaker']}<span>重听</span></button>
    </section>
    <p class="countdown" id="countdown" hidden></p>
    <p class="hint">→ 下一题 · ← 上一题 · 空格重听 · A 显示答案 · F 全屏</p>
  </main>

  <footer class="controls">
    <button type="button" class="ctrl" id="prev">‹ 上一题</button>
    <button type="button" class="ctrl primary" id="auto"></button>
    <button type="button" class="ctrl" id="next">下一题 ›</button>
    <span class="spacer"></span>
    <button type="button" class="ctrl ghost" id="answer-btn">显示答案</button>
    <button type="button" class="ctrl ghost" id="print">打印词表</button>
  </footer>

  <div class="settings" id="settings" hidden>
    <h2>自动听写</h2>
    <label>间隔 <select id="interval">{settings}</select></label>
    <label>每词朗读 <select id="repeat">{repeats}</select></label>
    <label>打乱顺序 <input type="checkbox" id="shuffle"></label>
    <p class="note" id="audio-note"></p>
    <button type="button" class="close" id="close-settings">完成</button>
  </div>

  <div class="done" id="done" hidden>
    <span class="eyebrow">完整听完</span>
    <h2>听写完成</h2>
    <p id="done-count"></p>
    <p>要查看本次听写内容与答案吗？</p>
    <div class="controls" style="width:auto">
      <button type="button" class="ctrl" id="restart">回到第一题</button>
      <button type="button" class="ctrl" id="done-restart">再听一遍</button>
      <button type="button" class="ctrl primary" id="summary-open">查看听写汇总</button>
    </div>
  </div>

  <section class="summary" id="summary" hidden>
    <header class="summary-head">
      <div>
        <span class="eyebrow">听写汇总</span>
        <h2 id="summary-title">听写汇总</h2>
        <p id="summary-note">按听写顺序排列，可保存为图片；内容超出一页会自动分页。</p>
      </div>
      <div class="summary-actions">
        <button type="button" class="ctrl" id="summary-back">返回听写</button>
        <button type="button" class="ctrl" id="summary-save-one">保存本页</button>
        <button type="button" class="ctrl primary" id="summary-save">保存全部图片</button>
        <button type="button" class="icon-btn" id="summary-full" aria-label="全屏">{ICONS['full']}</button>
      </div>
    </header>
    <div class="summary-view">
      <button type="button" class="summary-nav" id="summary-prev" aria-label="上一页">‹</button>
      <img id="summary-img" class="summary-img" alt="听写汇总">
      <button type="button" class="summary-nav" id="summary-next" aria-label="下一页">›</button>
    </div>
    <footer class="summary-foot">
      <span id="summary-counter">第 1 / 1 页</span>
      <span class="hint">← → 翻页；保存的是当前页的完整图片</span>
    </footer>
  </section>
</div>

<section class="print-sheet">
  <div class="head">
    <h1>{escape(meta['title'])}</h1>
    <p>{escape(subtitle)} · 共 {len(words)} 词</p>
  </div>
  <ol>{print_rows}</ol>
</section>

<template id="icon-play">{ICONS['play']}</template>
<template id="icon-pause">{ICONS['pause']}</template>
<script type="application/json" id="dict-data">{payload}</script>
<script type="application/json" id="dict-meta">{meta_payload}</script>
<script>{PLAYER.replace("'MODE'", f"'{mode}'")}</script>
</body>
</html>"""
    return {'html': html, 'pages': 1, 'warnings': warnings}
