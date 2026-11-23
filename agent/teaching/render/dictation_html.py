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
    kind = 'translation' if meta.get('kind') == 'translation' else 'dictation'
    title = _text(meta.get('title'), 100) or ' '.join(p for p in (book, unit, '单词听写') if p)
    return {'version': 1, 'meta': {'title': title, 'book': book, 'unit': unit,
                                   'date': _text(meta.get('date'), 20),
                                   'kind': kind, 'mode': mode},
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
.trans-badge{display:none;align-items:center;height:34px;padding:0 14px;border-radius:999px;
  font-size:12.5px;font-weight:800;letter-spacing:.08em;color:var(--accent);background:#fff;
  border:1px solid rgba(47,107,79,.3)}
body.kind-translation .trans-badge{display:inline-flex}
body.kind-translation .switch{display:none}
.prompt-trans{display:none;flex-direction:column;align-items:center;gap:clamp(10px,1.8vh,18px)}
body.kind-translation .prompt-trans{display:flex}
body.kind-translation .prompt-zh,
body.kind-translation .prompt-en{display:none}
.trans-word{font-family:var(--serif);font-size:clamp(54px,9vw,130px);line-height:1.08;font-weight:600;
  letter-spacing:.01em;text-align:center;overflow-wrap:anywhere;max-width:940px}
.trans-phon{display:flex;align-items:center;gap:12px;font-size:clamp(16px,2vw,26px);color:var(--ink-2);
  letter-spacing:.04em}
.say{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;padding:0;
  color:var(--accent);background:var(--soft);border:1px solid var(--line);border-radius:999px;cursor:pointer}
.say svg{width:18px;height:18px}
.say:hover{border-color:rgba(47,107,79,.45)}
.trans-hint{margin:0;font-size:13px;font-weight:600;letter-spacing:.14em;color:var(--ink-3)}
.reveal-hint{margin-top:4px;padding:12px 22px;font:inherit;font-size:14px;font-weight:700;color:var(--accent);
  background:rgba(47,107,79,.06);border:1px dashed rgba(47,107,79,.4);border-radius:999px;cursor:pointer}
.reveal-hint:hover{background:rgba(47,107,79,.12)}
.reveal-hint[hidden]{display:none}
body.kind-dictation .reveal-hint,
body.kind-dictation .prompt-trans{display:none}
body.kind-translation .replay{display:none}
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
body.kind-translation .progress,
body.kind-translation .word-card,
body.kind-translation .controls{width:min(1400px,100%)}
body.kind-translation .answer{width:100%}
body.kind-translation .a-senses{display:flex;align-items:center;width:100%;font-family:var(--serif);
  font-size:clamp(32px,5.4vw,74px);line-height:1.2;color:var(--ink);gap:8px;margin-top:0}
body.kind-translation .a-senses .a-sense{display:flex;align-items:baseline;justify-content:center;
  gap:14px;max-width:100%;margin:0;white-space:nowrap}
body.kind-translation .a-senses b{flex:none;font-size:clamp(14px,1.7vw,22px);margin-right:0;color:var(--gold)}
body.kind-translation .a-word,
body.kind-translation .a-phon{display:none}
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
.settings label.only-translation{display:none}
body.kind-translation .settings label.only-translation{display:flex}
body.kind-translation .settings label.only-dictation{display:none}
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
  body.kind-translation .print-sheet .p-zh{display:none}
  body.kind-translation .print-sheet .p-en{display:block}
  body.answers-on .print-sheet .ans{display:block}
  .print-hint{margin:6px 0 0;font-size:12px;color:#666}
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
  var KIND = META.kind || 'dictation';
  var TRANSLATION = KIND === 'translation';
  var state = {
    i: 0, mode: 'MODE', answer: false, auto: false,
    interval: 6, repeat: 2, think: 2, hold: 1, autoRead: true, loop: false, order: []
  };
  var token = 0, audioEl = null, timer = null;
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), counter = $('counter'), bar = $('bar'), label = $('label');
  var promptZh = $('prompt-zh'), answer = $('answer');
  var aWord = $('a-word'), aPhon = $('a-phon'), aSenses = $('a-senses');
  var countdownEl = $('countdown'), autoBtn = $('auto'), answerBtn = $('answer-btn');
  var replayBtn = $('replay'), bigSay = $('big-say');
  var promptTrans = $('prompt-trans'), transWord = $('trans-word'), transPhon = $('trans-phon');
  var transSay = $('trans-say'), revealHint = $('reveal-hint'), transHint = $('trans-hint');
  var keyHint = $('key-hint'), settingsTitle = $('settings-title');
  var doneTitle = $('done-title'), doneEyebrow = $('done-eyebrow'), doneQuestion = $('done-question');
  var summaryTitle = $('summary-title'), summaryEyebrow = $('summary-eyebrow'), summaryBack = $('summary-back');

  try {
    var saved = JSON.parse(localStorage.getItem('dictation-player') || '{}');
    ['interval', 'repeat'].forEach(function (key) {
      if (saved[key]) state[key] = saved[key];
    });
    if (saved.mode === 'zh' || saved.mode === 'en') state.mode = saved.mode;
    // Translation timings live under their own key: old dictation settings
    // (5s think / 3s answer in an earlier build) must not override the new
    // 2s / 1s defaults for a page that has never changed them.
    var trans = TRANSLATION ? JSON.parse(localStorage.getItem('dictation-translation') || '{}') : {};
    ['think', 'hold'].forEach(function (key) {
      if (trans[key]) state[key] = trans[key];
    });
    if (trans.autoRead === false) state.autoRead = false;
    if (trans.loop === true) state.loop = true;
    var allowed = function (id) {
      return Array.prototype.map.call($(id).options, function (option) { return Number(option.value); });
    };
    [
      ['interval', 6],
      ['think', 2],
      ['hold', 1]
    ].forEach(function (entry) {
      var key = entry[0];
      if (allowed(key).indexOf(Number(state[key])) === -1) state[key] = entry[1];
    });
    $('interval').value = String(state.interval);
    $('repeat').value = String(state.repeat);
    $('think').value = String(state.think);
    $('hold').value = String(state.hold);
    $('autoread').checked = state.autoRead;
    $('loop').checked = state.loop;
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

    document.body.classList.toggle('kind-translation', TRANSLATION);
    document.body.classList.toggle('kind-dictation', !TRANSLATION);
    document.body.classList.toggle('mode-zh', state.mode === 'zh');
    document.body.classList.toggle('mode-en', state.mode === 'en');

    if (TRANSLATION) {
      transWord.textContent = word.word;
      transPhon.textContent = word.phonetic || '';
      transPhon.hidden = !word.phonetic;
      aWord.hidden = true;
      aPhon.hidden = true;
      aSenses.hidden = false;
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
      if (!word.senses.length) aSenses.textContent = '（未填中文释义）';
      revealHint.hidden = state.answer;
      transHint.hidden = state.answer;
      document.getElementById('mode-tag').textContent = '英译汉';
      if (state.answer) window.requestAnimationFrame(fitTranslationAnswer);
    } else {
      renderPrompt(word);
      aWord.hidden = false;
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
      document.getElementById('mode-tag').textContent = state.mode === 'zh' ? '中文听写' : '英文听写';
    }
    answer.hidden = !state.answer;
    answerBtn.textContent = state.answer ? '隐藏答案' : '显示答案';
    document.body.classList.toggle('answers-on', state.answer);
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-mode') === state.mode);
    });
    updateAutoButton();
  }

  /** Keep a long Chinese meaning on one line: shrink the answer type to fit. */
  function fitTranslationAnswer() {
    if (!TRANSLATION) return;
    var card = document.querySelector('.word-card');
    if (!card) return;
    var css = window.getComputedStyle(card);
    var available = card.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) - 40;
    var lines = Array.prototype.slice.call(aSenses.querySelectorAll('.a-sense'));
    if (available <= 0 || !lines.length) return;

    aSenses.style.fontSize = '';
    var posBases = lines.map(function (line) {
      line.style.whiteSpace = 'nowrap';
      line.style.fontSize = '';
      var pos = line.querySelector('b');
      if (pos) { pos.style.fontSize = ''; return parseFloat(window.getComputedStyle(pos).fontSize) || 22; }
      return 0;
    });
    var base = parseFloat(window.getComputedStyle(aSenses).fontSize) || 56;
    var width = function () {
      return lines.reduce(function (max, line) { return Math.max(max, line.scrollWidth); }, 0);
    };
    var apply = function (size) {
      aSenses.style.fontSize = size + 'px';
      lines.forEach(function (line, i) {
        var pos = line.querySelector('b');
        if (pos && posBases[i]) {
          pos.style.fontSize = Math.max(12, Math.round(posBases[i] * size / base)) + 'px';
        }
      });
    };

    var size = base;
    if (width() > available) {
      size = Math.max(18, Math.floor(base * available / width()));
      // One calculation is close; a few 1px steps absorb rounding and the
      // part-of-speech glyphs, so a long meaning stays on one line.
      for (var i = 0; i < 10 && size > 18; i += 1) {
        apply(size);
        if (width() <= available) break;
        size -= 1;
      }
    }
    apply(size);
    lines.forEach(function (line) {
      if (size <= 18 && line.scrollWidth > available) line.style.whiteSpace = 'normal';
    });
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
    var label = state.auto ? '暂停' : '自动听写';
    if (!state.auto && TRANSLATION) label = '自动检查';
    else if (!state.auto && (state.i > 0 || state.answer)) label = '继续自动听写';
    autoBtn.innerHTML = (state.auto ? ICON_PAUSE : ICON_PLAY) + '<span>' + label + '</span>';
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
    if (TRANSLATION) {
      playClip(word.enAudio, word.word, 'en-US', done);
      return;
    }
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

  /** Manual navigation: dictation always reads; translation follows the audio setting. */
  function playOnNavigate() {
    if (TRANSLATION && !state.autoRead) return;
    playCurrent();
  }

  /** A countdown that runs a named phase: "思考 8 秒" or "答案 5 秒". */
  function phaseCountdown(seconds, label, done) {
    var mine = token;
    var left = seconds;
    countdownEl.hidden = false;
    (function step() {
      if (mine !== token || !state.auto) return;
      countdownEl.textContent = left > 0 ? label + ' ' + left + ' 秒' : '';
      if (left <= 0) { countdownEl.hidden = true; done(); return; }
      left -= 1;
      timer = setTimeout(step, 1000);
    })();
  }

  /** 英译汉: think time, reveal the Chinese, hold it, then advance. */
  function tickTranslation() {
    var mine = token;
    state.answer = false;
    render();
    var start = function () {
      if (mine !== token || !state.auto) return;
      phaseCountdown(state.think, '思考', function () {
        if (mine !== token || !state.auto) return;
        state.answer = true;
        render();
        phaseCountdown(state.hold, '答案', function () {
          if (mine !== token || !state.auto) return;
          advance(true);
        });
      });
    };
    if (state.autoRead) {
      var word = item();
      playClip(word.enAudio, word.word, 'en-US', start);
    } else {
      start();
    }
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
    if (TRANSLATION) { tickTranslation(); return; }
    var mine = token;
    playRepeats(state.repeat, function () {
      if (mine !== token || !state.auto) return;
      countdown(state.interval);
    });
  }

  function advance(automatic) {
    stopAudio();
    if (state.i >= state.order.length - 1) {
      if (automatic && TRANSLATION && state.loop) {
        state.i = 0;
        state.answer = false;
        render();
        tick();
        return;
      }
      if (automatic) finish();
      return;
    }
    state.i += 1;
    state.answer = false;
    render();
    if (state.auto) tick(); else playOnNavigate();
  }

  function back() {
    stopAuto();
    if (state.i > 0) state.i -= 1;
    else if (TRANSLATION && state.loop) state.i = state.order.length - 1;
    state.answer = false;
    render();
    playOnNavigate();
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
    if (next >= state.order.length) {
      if (TRANSLATION && state.loop) { state.i = 0; state.answer = false; render(); playOnNavigate(); return; }
      finish(); return;
    }
    if (next < 0) return;
    state.i = next;
    state.answer = false;
    render();
    playOnNavigate();
  }

  $('next').addEventListener('click', function () { go(1); });
  $('prev').addEventListener('click', back);
  $('auto').addEventListener('click', toggleAuto);
  replayBtn.addEventListener('click', playCurrent);
  bigSay.addEventListener('click', playCurrent);
  transSay.addEventListener('click', playCurrent);
  answerBtn.addEventListener('click', function () {
    state.answer = !state.answer;
    render();
  });
  revealHint.addEventListener('click', function () {
    state.answer = true;
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
  $('think').addEventListener('change', function (e) {
    state.think = Number(e.target.value) || 8;
    persist();
  });
  $('hold').addEventListener('change', function (e) {
    state.hold = Number(e.target.value) || 5;
    persist();
  });
  $('autoread').addEventListener('change', function (e) {
    state.autoRead = e.target.checked;
    persist();
  });
  $('loop').addEventListener('change', function (e) {
    state.loop = e.target.checked;
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
  window.addEventListener('resize', fitTranslationAnswer);
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
    $('summary-title').textContent = (TRANSLATION ? '英译汉汇总' : '听写汇总') + ' · 共 ' + state.order.length + ' 词';
    $('summary-eyebrow').textContent = TRANSLATION ? '英译汉汇总' : '听写汇总';
    $('summary-back').textContent = TRANSLATION ? '返回检查' : '返回听写';
    $('summary-note').textContent = (TRANSLATION ? '按检查顺序排列' : '按听写顺序排列') + '；内容超出一页会自动分页。';
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
      if (TRANSLATION) {
        summaryFont(ctx, 60, 700, SERIF);
        var prompt = [{ pos: '', lines: wrapText(ctx, word.word, 760) }];
        summaryFont(ctx, 60, 600, SERIF);
        var answer = [];
        word.senses.forEach(function (sense) {
          answer.push({ pos: sense.pos || '', lines: wrapText(ctx, sense.meaning || '—', 700) });
        });
        if (!answer.length) answer = [{ pos: '', lines: ['（未填中文释义）'] }];
        var promptHeight = prompt[0].lines.length * 70 + (word.phonetic ? 38 : 0) + 6;
        var answerHeight = answer.reduce(function (sum, sense) {
          return sum + Math.max(1, sense.lines.length) * 70 + 6;
        }, 0);
        return {
          no: index + 1,
          prompt: prompt,
          answer: answer,
          phonetic: word.phonetic || '',
          senses: [],
          height: Math.max(promptHeight, answerHeight) + 12
        };
      }
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
          var text = (sense.pos ? sense.pos + '　' : '') + (sense.meaning || '');
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

    if (TRANSLATION) {
      ctx.fillStyle = '#20242a';
      summaryFont(ctx, 60, 700, SERIF);
      row.prompt[0].lines.forEach(function (line, i) {
        ctx.fillText(line, x + 186, y + i * 70);
      });
      if (row.phonetic) {
        ctx.fillStyle = '#6b7078';
        summaryFont(ctx, 32, 400, SANS);
        ctx.fillText(row.phonetic, x + 186, y + row.prompt[0].lines.length * 70 + 6);
      }
      var ay = y;
      row.answer.forEach(function (sense) {
        if (sense.pos) {
          ctx.fillStyle = '#b08a4a';
          summaryFont(ctx, 34, 700, SANS);
          ctx.fillText(sense.pos, x + 990, ay + 10);
        }
        ctx.fillStyle = '#2f6b4f';
        summaryFont(ctx, 60, 600, SERIF);
        sense.lines.forEach(function (line, i) {
          ctx.fillText(line, x + 1070, ay + i * 70);
        });
        ay += Math.max(1, sense.lines.length) * 70 + 6;
      });
      return;
    }

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
    ctx.fillText(TRANSLATION ? '英 译 汉 · 汇 总' : '单 词 听 写 · 汇 总', PAGE_PAD, 54);
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
      if (TRANSLATION) {
        localStorage.setItem('dictation-translation', JSON.stringify({
          think: state.think,
          hold: state.hold,
          autoRead: state.autoRead,
          loop: state.loop
        }));
        return;
      }
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
    if (TRANSLATION) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
      else if (e.key === ' ') {
        if (tag === 'button') return;
        e.preventDefault();
        state.answer = !state.answer;
        render();
      } else if (e.key === 'r' || e.key === 'R') { playCurrent(); }
      else if (e.key === 'a' || e.key === 'A') { state.answer = !state.answer; render(); }
      else if (e.key === 'f' || e.key === 'F') { $('fullscreen').click(); }
      else if (e.key === 'Escape') { $('settings').hidden = true; }
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
        warnings.append(f'{missing_meaning} 个单词没有中文释义，中文听写和英译汉会留空')
    kind = meta['kind']
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
                               'date': meta['date'], 'kind': kind, 'mode': mode},
                              ensure_ascii=False).replace('<', '\\u003c').replace('>', '\\u003e')

    def sense_line(sense):
        return ' '.join(part for part in (sense['pos'], sense['meaning']) if part)

    def print_row(number, word):
        chinese = '<br>'.join(escape(sense_line(s)) for s in word['senses']) or '（未填中文释义）'
        chinese_line = '；'.join(sense_line(s) for s in word['senses']) or '（未填中文释义）'
        if kind == 'translation':
            # English is the question; the Chinese senses are the answer.
            answer = f'<span class="ans">{escape(chinese_line)}</span>'
            prompt = f'<span class="p p-en">{escape(word["word"])}</span>'
        else:
            answer = (f'<span class="ans">{escape(word["word"])}'
                      f'{" " + escape(word["phonetic"]) if word["phonetic"] else ""}'
                      f'{"；" + escape(chinese_line) if word["senses"] else ""}</span>')
            prompt = '<span class="p p-en"></span>'
        return (f'<li><span class="no">{number}</span><span class="cell">'
                f'<span class="p p-zh">{chinese}</span>{prompt}'
                f'<span class="line"></span>{answer}</span></li>')

    print_rows = ''.join(print_row(number, word) for number, word in enumerate(words, 1))

    # One-second steps up to ten; longer waits were never useful in class.
    seconds = ''.join(f'<option value="{value}">{value} 秒</option>' for value in range(1, 11))
    settings = thinks = holds = seconds
    repeats = ''.join(f'<option value="{value}">{value} 遍</option>' for value in (1, 2, 3))

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(meta['title'])}</title>
<style>{CSS}</style>
</head>
<body class="kind-{kind} mode-{mode}">
<div class="app">
  <header class="top">
    <div>
      <span class="eyebrow">{'英译汉' if kind == 'translation' else '单词听写'}</span>
      <h1>{escape(meta['title'])}</h1>
      <p class="sub">{escape(subtitle)}{' · ' + escape(meta['date']) if meta['date'] else ''} · 共 {len(words)} 词</p>
    </div>
    <div class="top-right">
      <span class="trans-badge">英译汉</span>
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
      <span id="mode-tag">{'英译汉' if kind == 'translation' else '单词听写'}</span>
    </div>
    <section class="word-card">
      <p class="kicker" id="label">第 1 题</p>
      <div class="prompt prompt-zh" id="prompt-zh"></div>
      <div class="prompt prompt-en">
        <button type="button" class="big-say" id="big-say" aria-label="播放发音">{ICONS['speaker']}</button>
        <p class="en-hint">听发音 · 写单词</p>
      </div>
      <div class="prompt prompt-trans" id="prompt-trans">
        <div class="trans-word" id="trans-word"></div>
        <div class="trans-phon">
          <span id="trans-phon"></span>
          <button type="button" class="say" id="trans-say" aria-label="播放发音">{ICONS['speaker']}</button>
        </div>
        <p class="trans-hint" id="trans-hint">先想一想它的中文意思</p>
      </div>
      <button type="button" class="reveal-hint" id="reveal-hint">想好了？点击显示中文答案</button>
      <div class="answer" id="answer" hidden>
        <p class="a-word" id="a-word"></p>
        <p class="a-phon" id="a-phon"></p>
        <div class="a-senses" id="a-senses"></div>
      </div>
      <button type="button" class="replay" id="replay">{ICONS['speaker']}<span>重听</span></button>
    </section>
    <p class="countdown" id="countdown" hidden></p>
    <p class="hint" id="key-hint">{'→ 下一题 · ← 上一题 · 空格显示答案 · R 重听 · F 全屏' if kind == 'translation' else '→ 下一题 · ← 上一题 · 空格重听 · A 显示答案 · F 全屏'}</p>
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
    <h2 id="settings-title">{'自动检查' if kind == 'translation' else '自动听写'}</h2>
    <label class="only-dictation">间隔 <select id="interval">{settings}</select></label>
    <label class="only-dictation">每词朗读 <select id="repeat">{repeats}</select></label>
    <label class="only-translation">思考时间 <select id="think">{thinks}</select></label>
    <label class="only-translation">答案停留 <select id="hold">{holds}</select></label>
    <label class="only-translation">自动朗读 <input type="checkbox" id="autoread" checked></label>
    <label class="only-translation">循环播放 <input type="checkbox" id="loop"></label>
    <label>打乱顺序 <input type="checkbox" id="shuffle"></label>
    <p class="note" id="audio-note"></p>
    <button type="button" class="close" id="close-settings">完成</button>
  </div>

  <div class="done" id="done" hidden>
    <span class="eyebrow" id="done-eyebrow">{'完整检查' if kind == 'translation' else '完整听完'}</span>
    <h2 id="done-title">{'检查完成' if kind == 'translation' else '听写完成'}</h2>
    <p id="done-count"></p>
    <p id="done-question">{'要查看本次检查的英文与中文答案吗？' if kind == 'translation' else '要查看本次听写内容与答案吗？'}</p>
    <div class="controls" style="width:auto">
      <button type="button" class="ctrl" id="restart">回到第一题</button>
      <button type="button" class="ctrl" id="done-restart">{'再检查一遍' if kind == 'translation' else '再听一遍'}</button>
      <button type="button" class="ctrl primary" id="summary-open">{'查看检查汇总' if kind == 'translation' else '查看听写汇总'}</button>
    </div>
  </div>

  <section class="summary" id="summary" hidden>
    <header class="summary-head">
      <div>
        <span class="eyebrow" id="summary-eyebrow">{'英译汉汇总' if kind == 'translation' else '听写汇总'}</span>
        <h2 id="summary-title">{'英译汉汇总' if kind == 'translation' else '听写汇总'}</h2>
        <p id="summary-note">{'按检查顺序排列，可保存为图片；内容超出一页会自动分页。' if kind == 'translation' else '按听写顺序排列，可保存为图片；内容超出一页会自动分页。'}</p>
      </div>
      <div class="summary-actions">
        <button type="button" class="ctrl" id="summary-back">{'返回检查' if kind == 'translation' else '返回听写'}</button>
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
    {f'<p class="print-hint">看英文，写出中文意思。</p>' if kind == 'translation' else ''}
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
