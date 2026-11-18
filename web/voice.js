// Voice: dictation into the composer and a hands-free voice conversation with a bot.
// Uses the native app bridge (Android SpeechRecognizer/TTS) when present, else the browser Web Speech API.
import { S, T, h, icon, post, toast, native } from './ui.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const useNativeSpeech = () => native.available && native.platform === 'android';
const lang = () => S.settings.voiceLang || 'he-IL';
let rec = null, offs = [], active = false;
export const dictating = () => active;
export const speechSupported = () => useNativeSpeech() || !!SR || !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

function listen({ onText, onFinal, onEnd, continuous = false }) {
  active = true;
  const end = () => { if (!active) return; active = false; offs.forEach((f) => f()); offs = []; rec = null; onEnd?.(); };
  if (useNativeSpeech()) {
    let finalText = '';
    offs.push(native.on('speechPartial', (d) => onText?.(finalText + d.text)), native.on('speechFinal', (d) => { finalText += d.text + ' '; onText?.(finalText.trim()); onFinal?.(d.text); }), native.on('speechEnd', end), native.on('speechError', (d) => { if (d.message && !/no match|timeout|7|6/i.test(d.message)) toast(d.message); end(); }));
    native.call('startListening', { lang: lang() }).then((r) => { if (r.error) { toast(T('זיהוי דיבור לא זמין: ', 'Speech unavailable: ') + r.error); end(); } });
    return;
  }
  if (!SR) { // no speech API (desktop app webviews, Firefox): record and transcribe on the server
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast(T('אין גישה למיקרופון כאן', 'No microphone access here'), 5000); active = false; onEnd?.(); return; }
    navigator.mediaDevices.getUserMedia({ audio: localStorage.cbMic ? { deviceId: { ideal: localStorage.cbMic } } : true }).then((stream) => {
      const mr = new MediaRecorder(stream); const chunks = []; let spoke = false, quietSince = 0, raf = 0; const t0 = Date.now();
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize);
      const tick = () => { an.getByteTimeDomainData(buf); let s = 0; for (const b of buf) s += (b - 128) * (b - 128); const rms = Math.sqrt(s / buf.length); const now = Date.now();
        if (rms > 6) { spoke = true; quietSince = 0; } else if (!quietSince) quietSince = now;
        if ((spoke && quietSince && now - quietSince > (continuous ? 2500 : 1600)) || now - t0 > 45000 || (!spoke && now - t0 > 8000)) return mr.state === 'recording' && mr.stop();
        raf = requestAnimationFrame(tick); };
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close();
        if (spoke && chunks.length) { onText?.('…'); try { const r = await fetch('/api/stt?lang=' + lang().slice(0, 2), { method: 'POST', headers: { 'X-CB': '1' }, body: new Blob(chunks, { type: mr.mimeType }) }).then((x) => x.json()); if (r.error) toast(r.error); onText?.(r.text || ''); if (r.text) onFinal?.(r.text); } catch (e) { toast(e.message); onText?.(''); } }
        end(); };
      rec = { stop: () => mr.state === 'recording' && mr.stop() };
      mr.start(); tick();
    }).catch((e) => { toast(T('המיקרופון נחסם: ', 'Microphone blocked: ') + e.message, 5000); end(); });
    return;
  }
  rec = new SR(); rec.lang = lang(); rec.interimResults = true; rec.continuous = continuous;
  let fin = '';
  rec.onresult = (e) => { let inter = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) { fin += r[0].transcript + ' '; onFinal?.(r[0].transcript); } else inter += r[0].transcript; } onText?.((fin + inter).trim()); };
  rec.onerror = (e) => { if (!['no-speech', 'aborted'].includes(e.error)) toast(T('שגיאת מיקרופון: ', 'Mic error: ') + e.error); };
  rec.onend = end;
  try { rec.start(); } catch { end(); }
}
export function startDictation(o) { listen({ ...o, continuous: true }); }
export function stopDictation() { if (useNativeSpeech()) native.call('stopListening'); else try { rec?.stop(); } catch {} }

// Voices offered in the bot details panel: the natural server voice (Hebrew), the device voice, or a named browser voice.
export function voiceOptions() {
  const l = lang().slice(0, 2).toLowerCase();
  const vs = useNativeSpeech() || !window.speechSynthesis ? [] : speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(l));
  return { voices: [['', T('טבעי (שאול)', 'Natural (Shaul)')], ['device', T('קול המכשיר', 'Device voice')], ...vs.map((v) => [v.name, v.name.replace(/^(Microsoft|Google)\s+/, '').slice(0, 22)])] };
}
const cleanSpeech = (t) => t.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, ' ').replace(/[#*_`>|~]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
const rate = () => Number(S.settings.voiceRate) || 1;
// The natural voice is synthesised on the server (local neural model) and played through Web Audio.
const neural = () => !S.settings.voiceName && lang().toLowerCase().startsWith('he') && neuralOk;
let neuralOk = true, actx = null, playing = null, speakGen = 0;
export function unlockAudio() { try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {} }
// Starts synthesis right away and returns a promise of the decoded audio (null → use the device voice instead).
function prepare(text) {
  const clean = cleanSpeech(text).slice(0, 1200);
  if (!clean || !neural() || !actx || !/[֐-׿]/.test(clean)) return Promise.resolve(null);
  return fetch('/api/tts', { method: 'POST', headers: { 'X-CB': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text: clean, rate: rate() }) })
    .then((r) => { if (!r.ok) throw new Error('tts ' + r.status); return r.arrayBuffer(); }).then((buf) => actx.decodeAudioData(buf)).catch(() => null);
}
function speak(text, onEnd, prepared) {
  const clean = cleanSpeech(text).slice(0, 1800);
  if (!clean) return onEnd();
  let done = false; const fin = () => { if (!done) { done = true; onEnd(); } }; const gen = speakGen;
  Promise.resolve(prepared ?? prepare(text)).then((buf) => {
    if (done || gen !== speakGen) return; // interrupted while the audio was being prepared
    if (buf) { const src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination); src.onended = () => { if (playing === src) playing = null; fin(); }; playing = src; src.start(); return; }
    if (useNativeSpeech()) { const off = native.on('speakEnd', () => { off(); fin(); }); native.call('speak', { text: clean, lang: lang(), rate: rate() }).then((r) => { if (r.error) { off(); fin(); } }); return; }
    if (!window.speechSynthesis) return fin();
    const u = new SpeechSynthesisUtterance(clean); u.lang = lang(); u.rate = rate();
    const all = speechSynthesis.getVoices();
    const v = all.find((x) => x.name === S.settings.voiceName) || all.find((x) => x.lang?.toLowerCase().startsWith(lang().slice(0, 2).toLowerCase())); if (v) u.voice = v;
    u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
  });
  return fin;
}
const stopSpeak = () => { speakGen++; if (playing) { const p = playing; playing = null; p.onended = null; try { p.stop(); } catch {} } if (useNativeSpeech()) native.call('stopSpeaking'); else window.speechSynthesis?.cancel(); };

// Live conversation: listen → the bot answers in short spoken sentences that are read aloud while it is still
// writing them → listens again by itself. Tapping the orb interrupts the bot and gives the turn back to you.
export function voiceMode(bot) {
  let open = true, state = 'idle', heard = '', sentAt = 0, msgId = null, spoken = 0, queue = [], talking = false, replyDone = false;
  const orb = h('button', { class: 'orb', onclick: () => tap() }), said = h('div', { class: 'said', dir: 'auto' }), cap = h('div', { class: 'cap', dir: 'auto' }), hint = h('div', { class: 'tiny' });
  const root = h('div', { class: 'voice' }, h('b', { style: { fontSize: '19px' } }, bot.name), orb, said, cap, hint,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => tap() }, icon('mic'), T('דבר / קטע', 'Talk / interrupt')), h('button', { class: 'btn danger', onclick: close }, icon('x'), T('סיום', 'End'))));
  document.body.append(root); unlockAudio();
  post(`/bots/${bot.id}/voice`, { action: 'start' }).catch(() => {}); // warm the bot up while the user starts talking
  const set = (s) => { state = s; orb.className = 'orb ' + ({ listen: 'listen', speak: 'speak', think: 'think' }[s] || ''); hint.textContent = ({ listen: T('מקשיב…', 'Listening…'), think: T('רגע…', 'One moment…'), speak: T('לחץ כדי לקטוע', 'Tap to interrupt'), idle: T('לחץ כדי לדבר', 'Tap to talk') })[s]; };
  let cancelSpeak = null;
  function tap() {
    unlockAudio();
    if (state === 'speak' || state === 'think') { interrupt(); startListen(); }
    else if (state === 'listen') finish();
    else startListen();
  }
  function interrupt() {
    queue = []; talking = false; cancelSpeak = null; stopSpeak();
    if (!replyDone && msgId) post(`/bots/${bot.id}/stop`).catch(() => {});
    msgId = null; sentAt = 0;
  }
  function startListen() {
    if (!open) return; heard = ''; set('listen'); cap.textContent = '';
    let timer = null;
    listen({ continuous: false, onText: (t) => { if (t !== '…') heard = t; said.textContent = t; clearTimeout(timer); if (SR || useNativeSpeech()) timer = setTimeout(finish, 1300); }, onEnd: () => { clearTimeout(timer); if (open && state === 'listen') (heard.trim() ? sendIt() : set('idle')); } });
  }
  function finish() { if (state !== 'listen') return; stopDictation(); if (!active) (heard.trim() ? sendIt() : set('idle')); }
  async function sendIt() {
    const text = heard.trim(); heard = ''; if (!text || state === 'think') return;
    set('think'); said.textContent = text; cap.textContent = '';
    msgId = null; spoken = 0; queue = []; replyDone = false; sentAt = Date.now() - 1500;
    try { await post(`/bots/${bot.id}/messages`, { text, voice: true }); } catch (e) { toast(e.message); set('idle'); }
  }
  function pump() {
    if (!open || talking) return;
    const next = queue.shift();
    if (next == null) { if (replyDone && state !== 'listen') startListen(); return; }
    talking = true; set('speak');
    const tok = {}; cancelSpeak = tok;
    speak(next.text, () => { if (cancelSpeak !== tok) return; talking = false; if (open && state === 'speak') pump(); }, next.audio);
  }
  // Streams of the assistant message: speak every finished sentence as soon as it exists.
  const onStream = (e) => {
    const m = e.detail.message;
    if (!open || e.detail.botId !== bot.id || !sentAt || m.ts < sentAt || (msgId && m.id !== msgId)) return;
    if (!msgId) { if (state !== 'think') return; msgId = m.id; }
    const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const fin = m.status !== 'streaming';
    let rest = text.slice(spoken);
    for (;;) { const k = rest.search(/[.!?…:\n](\s|$)/); if (k < 0 || (k < 12 && !fin)) break; const piece = rest.slice(0, k + 1); if (cleanSpeech(piece)) queue.push({ text: piece, audio: prepare(piece) }); spoken += k + 1; rest = rest.slice(k + 1); }
    if (fin) { if (cleanSpeech(rest)) queue.push({ text: rest, audio: prepare(rest) }); spoken = text.length; replyDone = true; if (m.status === 'error') toast(m.error || T('שגיאה', 'Error')); }
    cap.textContent = cleanSpeech(text).slice(-420);
    pump();
  };
  window.addEventListener('cb-stream', onStream);
  function close() { open = false; interrupt(); if (active) stopDictation(); window.removeEventListener('cb-stream', onStream); root.remove(); post(`/bots/${bot.id}/voice`, { action: 'end' }).catch(() => {}); }
  if (!speechSupported()) { cap.textContent = T('זיהוי דיבור לא נתמך כאן. באנדרואיד השתמש באפליקציית WitBox; במחשב — Chrome או Edge.', 'Speech recognition is not supported here.'); set('idle'); }
  else startListen();
}
