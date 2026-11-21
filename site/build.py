#!/usr/bin/env python3
"""Generates the WitBox website (index.html, download.html, terms.html) — every text in Hebrew and English.
Run:  python3 site/build.py     (writes next to this file; the site is plain static files)"""
import os, html
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = 'https://github.com/avitwil/WitBox'
REL = REPO + '/releases/latest/download/'
MAIL = 'witbox@avitwil.io'

def t(he, en, tag='span'):
    return f'<{tag} data-l="he">{he}</{tag}><{tag} data-l="en">{en}</{tag}>'
def tb(he, en): return t(he, en, 'div')
IC = {
 'team': '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.700-5 6-5s6 2 6 5M14 15.200c.600-.100 1.300-.200 2-.200 3.300 0 6 2 6 5"/>',
 'pc': '<path d="M3 5h18v11H3zM8 20h8M12 16v4"/>', 'brain': '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0"/>',
 'grid': '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>', 'spark': '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
 'phone': '<path d="M7 3h10v18H7zM11 18h2"/>', 'shield': '<path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z"/>', 'wave': '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
 'cloud': '<path d="M7 18a4 4 0 0 1-.500-8 6 6 0 0 1 11.500 1.500A3.500 3.500 0 0 1 17.500 18z"/>', 'clock': '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2"/>',
 'lock': '<path d="M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3"/>', 'folder': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 'hand': '<path d="M8 12V5a1.500 1.500 0 0 1 3 0v6V4a1.500 1.500 0 0 1 3 0v7V6a1.500 1.500 0 0 1 3 0v8c0 4-2 7-6 7s-5-2-7-6l-1-2a1.500 1.500 0 0 1 2.600-1.500z"/>',
 'dl': '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', 'gh': '<path d="M9 19c-4 1.500-4-2-6-2m12 5v-3.500c0-1 .100-1.400-.500-2 2.800-.300 5.500-1.400 5.500-6a4.600 4.600 0 0 0-1.300-3.200 4.200 4.200 0 0 0-.100-3.200s-1.100-.300-3.500 1.300a12 12 0 0 0-6.200 0C6.500 2.800 5.400 3.100 5.400 3.100a4.200 4.200 0 0 0-.100 3.200A4.600 4.600 0 0 0 4 9.500c0 4.600 2.700 5.700 5.500 6-.600.600-.600 1.200-.500 2V21"/>',
 'server': '<path d="M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01"/>', 'win': '<path d="M3 5l8-1v7.500H3zM13 3.700L21 3v8.500h-8zM3 12.500h8V20l-8-1zM13 12.500h8V21l-8-1.200z"/>',
 'android': '<path d="M6 10h12v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM8 10a4 4 0 0 1 8 0M8 5L6.500 3M16 5l1.500-2M3 11v5M21 11v5"/>', 'linux': '<path d="M3 5h18v14H3zM7 10l3 2-3 2M12 15h5"/>',
}
def ic(n): return f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round">{IC[n]}</svg>'

# intro film: shown once per browser session on the home page
INTRO = '''<div id="splash"><video muted autoplay playsinline preload="auto" disablepictureinpicture disableremoteplayback><source src="img/intro.mp4" type="video/mp4"><source src="img/intro.webm" type="video/webm"></video><img src="img/logo-540.jpg" width="540" height="531" alt="WitBox — by Avi Twil"></div>
<script>try{if(sessionStorage.witboxIntro)document.getElementById('splash').remove();else sessionStorage.witboxIntro=1}catch(e){}</script>
<script>(function(){var s=document.getElementById('splash');if(!s)return;var v=s.querySelector('video'),done,fin;
window.__intro=new Promise(function(r){done=r});
function end(){if(fin)return;fin=1;done()}
function still(){if(fin||s.classList.contains('still'))return;s.classList.add('still');try{v.pause()}catch(e){}setTimeout(end,4700)}
if(!v||!v.canPlayType||matchMedia('(prefers-reduced-motion:reduce)').matches){still();return}
v.addEventListener('ended',end);v.addEventListener('error',still);
var last=v.querySelector('source:last-of-type');if(last)last.addEventListener('error',still);
var p;try{p=v.play()}catch(e){still()}if(p&&p.catch)p.catch(still);
setTimeout(function(){if(!(v.currentTime>0))still()},3500);
setTimeout(end,15000);
s.addEventListener('click',end)})()</script>
<script>(function(){var d=document.documentElement,s=document.getElementById('splash');if(!s)return;d.classList.add('intro');window.__intro.then(function(){d.classList.remove('intro');s.classList.add('out');setTimeout(function(){s.remove()},750)})})()</script>'''

def page(name, title_he, title_en, desc, body, active=''):
    nav = f'''<header class="nav"><div class="wrap">
<a class="brand" href="index.html"><img src="img/icon-192.png" alt="" width="34" height="34">WitBox</a>
<nav><a href="index.html#features">{t('יכולות','Features')}</a><a href="index.html#private">{t('פרטיות','Privacy')}</a><a href="index.html#compare">{t('השוואה','Compare')}</a><a href="download.html" class="keep">{t('הורדה','Download')}</a><a href="{REPO}" rel="noopener">GitHub</a></nav>
<button class="langbtn" type="button" aria-label="Language">{t('English','עברית')}</button>
</div></header>'''
    foot = f'''<footer><div class="wrap">
<div><b style="color:var(--tx)">WitBox</b> · {t('נוצר ע"י Avi Twil','Created by Avi Twil')} · <a href="mailto:{MAIL}">{MAIL}</a></div>
<nav><a href="download.html">{t('הורדה','Download')}</a><a href="terms.html">{t('תנאי שימוש והסרת אחריות','Terms of use and disclaimer')}</a><a href="{REPO}" rel="noopener">GitHub</a></nav>
<div style="flex-basis:100%;font-size:13px">{t('WitBox הוא פרויקט עצמאי בקוד פתוח (רישיון MIT). אינו קשור ל-Anthropic, ל-xAI, ל-Nous Research או ל-Tailscale. כל סימני המסחר שייכים לבעליהם.','WitBox is an independent open-source project (MIT licence). Not affiliated with Anthropic, xAI, Nous Research or Tailscale. All trademarks belong to their owners.')}</div>
</div></footer>'''
    doc = f'''<!doctype html>
<html lang="en" dir="ltr" data-lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-title-he="{html.escape(title_he)}" data-title-en="{html.escape(title_en)}">{html.escape(title_en)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="author" content="Avi Twil">
<meta name="theme-color" content="#0b0b0c">
<meta property="og:title" content="{html.escape(title_en)}"><meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="https://witbox.avitwil.io/img/og.jpg"><meta property="og:type" content="website"><meta property="og:url" content="https://witbox.avitwil.io/{'' if name == 'index.html' else name}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="img/icon-192.png"><link rel="apple-touch-icon" href="img/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="style.css">
<script>(function(){{var l;try{{l=localStorage.witboxLang}}catch(e){{}}var q=/[?&]lang=(he|en)/.exec(location.search);l=q?q[1]:l||(/^he|^iw/i.test(navigator.language||'')?'he':'en');var d=document.documentElement;d.dataset.lang=l;d.lang=l;d.dir=l==='he'?'rtl':'ltr'}})()</script>
</head>
<body>
{INTRO if name == 'index.html' else ''}
{nav}
{body}
{foot}
<script src="app.js"></script>
</body></html>
'''
    open(os.path.join(HERE, name), 'w').write(doc)

def shot(n, alt, bar=True):
    return f'<div class="frame">{"<div class=bar><i></i><i></i><i></i></div>" if bar else ""}<img data-shot="{n}" src="img/en/{n}.webp" alt="{alt}" loading="lazy" width="1800" height="1125"></div>'
def phone(n, alt): return f'<div class="phone"><img data-shot="{n}" src="img/en/{n}.webp" alt="{alt}" loading="lazy" width="780" height="1688"></div>'
def feature(num, he_h, en_h, he_p, en_p, bullets, media):
    lis = ''.join(f'<li>{t(a, b)}</li>' for a, b in bullets)
    return f'<div class="feature reveal"><div class="ftext"><div class="num">{num}</div><h3>{t(he_h, en_h)}</h3>{t(he_p, en_p, "p")}<ul>{lis}</ul></div><div class="fmedia">{media}</div></div>'
def card(i, he_h, en_h, he_p, en_p): return f'<div class="card reveal"><div class="ic">{ic(i)}</div><h3>{t(he_h, en_h)}</h3>{t(he_p, en_p, "p")}</div>'
def pre(code): return f'<pre><button class="copy" type="button">copy</button><code>{html.escape(code)}</code></pre>'

# ------------------------------------------------------------------ home
rows = [
 (('איפה המידע שלכם', 'Where your data lives'), ('על המחשב שלכם', 'Your own machine'), ('בענן של הספק', "The vendor's cloud"), ('על המחשב שלכם', 'Your machine'), ('על המחשב שלכם', 'Your machine'), ('על המחשב שלכם', 'Your machine')),
 (('ממשק', 'Interface'), ('אפליקציות שיחה ודשבורד: Android, Windows, Linux, דפדפן', 'Chat apps + dashboard: Android, Windows, Linux, web'), ('אפליקציות שיחה ודשבורד', 'Chat apps + dashboard'), ('טרמינל ואפליקציות מסרים', 'Terminal and messaging apps'), ('אפליקציות מסרים', 'Messaging apps'), ('טרמינל / IDE', 'Terminal / IDE')),
 (('מנוע', 'Engine'), ('Claude Code, על מנוי ה-Claude שלכם', 'Claude Code, on your Claude subscription'), ('Grok', 'Grok'), ('מודלים רבים (מפתחות API)', 'Many models (API keys)'), ('מודלים רבים (מפתחות API)', 'Many models (API keys)'), ('Claude Code', 'Claude Code')),
 (('צוות בוטים', 'A team of bots'), ('כן, עם בוט ראשי שמחלק משימות', 'Yes, with a main bot that delegates'), ('כן', 'Yes'), ('תת-סוכנים', 'Sub-agents'), ('כמה סוכנים', 'Multiple agents'), ('תת-סוכנים', 'Sub-agents')),
 (('מחשב לבוטים', 'A computer for the bots'), ('מכונה פרטית על השרת שלכם; שולחן עבודה ומשתמש לכל בוט', 'Private VM on your server; own desktop and user per bot'), ('מחשב ענן אחד לחשבון', 'One cloud computer per account'), ('סביבות טרמינל', 'Terminal back-ends'), ('המחשב שלכם', 'Your own machine'), ('המחשב שלכם', 'Your own machine')),
 (('למידה מתמשכת', 'Continuous learning'), ('כן: מוח משותף וסקילים שנכתבים לבד', 'Yes: shared Brain + self-written skills'), None, ('כן: לולאת למידה מובנית', 'Yes: built-in learning loop'), ('זיכרון מבוסס קבצים', 'File-based memory'), ('קובצי זיכרון לפרויקט', 'Project memory files')),
 (('שגרות והמלצות יזומות', 'Proactive routines and suggestions'), ('כן', 'Yes'), ('כן', 'Yes'), ('מתזמן', 'Scheduler'), ('מתזמן', 'Scheduler'), None),
 (('דשבורד וידג׳טים שהבוטים בונים', 'Widget dashboard built by the bots'), ('כן', 'Yes'), ('כן', 'Yes'), None, None, None),
 (('מודל לכל בוט / בחירה אוטומטית', 'Model per bot / automatic routing'), ('שניהם', 'Both'), None, ('לפי הגדרה', 'Per configuration'), ('לפי הגדרה', 'Per configuration'), ('ידני', 'Manual')),
 (('חשיפה לרשת', 'Network exposure'), ('אין. רק רשת ה-Tailscale שלכם', 'None. Your tailnet only'), ('שירות ענן ציבורי', 'Public cloud service'), ('לפי בחירתכם', 'You decide'), ('לפי בחירתכם', 'You decide'), ('מקומי', 'Local')),
 (('מחיר', 'Price'), ('חינם וקוד פתוח (ומנוי ה-Claude שלכם)', 'Free and open source (+ your Claude plan)'), ('מנוי', 'Subscription'), ('חינם (ועלות המודלים)', 'Free (+ model costs)'), ('חינם (ועלות המודלים)', 'Free (+ model costs)'), ('מנוי Claude', 'Claude plan')),
]
def cell(c, us=False):
    if c is None: return '<td class="no">—</td>'
    return f'<td class="{"us yes" if us else ""}">{t(*c)}</td>'
table = '<div class="tablewrap reveal"><table class="cmp"><thead><tr><th></th><th class="us">WitBox</th><th>Grok Bot</th><th>Hermes Agent</th><th>OpenClaw</th><th>' + t('Claude Code לבדו', 'Claude Code alone') + '</th></tr></thead><tbody>' + ''.join(
    f'<tr><td>{t(*r[0])}</td>{cell(r[1], True)}{cell(r[2])}{cell(r[3])}{cell(r[4])}{cell(r[5])}</tr>' for r in rows) + '</tbody></table></div>'

home = f'''
<main>
<section class="hero"><div class="grid-bg"></div><div class="wrap">
  <div class="stage" aria-hidden="true">
    <div class="halo"></div><div class="ring r1"><i></i></div><div class="ring r2"><i></i></div>
    <div class="logo3d"><img class="depth d3" src="img/mark.webp" alt=""><img class="depth d2" src="img/mark.webp" alt=""><img class="depth d1" src="img/mark.webp" alt=""><img class="face" src="img/mark.webp" alt=""><div class="sheen"></div></div>
    <div class="floor"></div>
  </div>
  <div class="wordmark">WitBox</div>
  <div class="by">By Avi Twil</div>
  <h1>{t('הפשטות שאתם אוהבים.<br><em>המוח שחיכיתם לו.</em>', 'Simple on the outside.<br><em>Brilliant on the inside.</em>')}</h1>
  {t('WitBox מביא את הנוחות של Grok Bot ומלביש אותה על Claude Code: צוות בוטים אישי עם ממשק שיחה קליל, שרץ על המחשב שלכם, לומד אתכם כל הזמן, והמידע נשאר אצלכם.',
     'WitBox takes the effortless feel of Grok Bot and puts it on top of Claude Code: a personal team of bots with a light chat interface, running on your own machine, learning you as it goes — and your data stays with you.', 'p').replace('<p ', '<p class="sub" ')}
  <div class="cta"><a class="btn primary" href="download.html">{ic('dl')}{t('הורדה והתקנה', 'Download and install')}</a><a class="btn" href="{REPO}" rel="noopener">{ic('gh')}{t('קוד המקור ב-GitHub', 'Source on GitHub')}</a></div>
  <div class="chips"><span class="chip"><i></i>{t('נועד להתקנה על רשת Tailscale', 'Built to run on a Tailscale network')}</span><span class="chip">{t('קוד פתוח · MIT', 'Open source · MIT')}</span><span class="chip">{t('רץ על מנוי ה-Claude שלכם', 'Runs on your Claude subscription')}</span></div>
  <div class="heroshot">{shot('dashboard', 'WitBox dashboard')}</div>
</div></section>

<section class="dilemma"><div class="wrap"><div class="box reveal">
  <div><h3>{t('ממשק שכיף לעבוד איתו', 'An interface you enjoy')}</h3>{t('שיחה פשוטה, מהירה ונקייה. בוטים עם שם ופרצוף, בלי תפריטים מיותרים ובלי טרמינל.', 'A simple, fast, clean conversation. Bots with a name and a face, no needless menus and no terminal.', 'p')}</div>
  <div class="plus">+</div>
  <div><h3>{t('המנוע החזק ביותר', 'The strongest engine')}</h3>{t('Claude Code מאחורי כל בוט: הבנת הקשר רחבה, כלים אמיתיים וביצוע של משימות ארוכות מקצה לקצה.', 'Claude Code behind every bot: deep context, real tools and long tasks carried out end to end.', 'p')}</div>
  <div class="eq">{t('למה לבחור, אם אפשר לשלב? <span style="color:var(--acc2)">זה WitBox.</span>', 'Why choose when you can have both? <span style="color:var(--acc2)">That is WitBox.</span>')}</div>
</div></div></section>

<section id="features"><div class="wrap">
  <div class="center reveal"><div class="kicker">{t('מה מחכה לכם בפנים', "What's inside")}</div><h2>{t('לא עוד צ׳אט בוט. צוות שלם שעובד בשבילכם.', 'Not another chatbot. A whole team working for you.')}</h2>
  {t('מתחילים משימה במחשב בעבודה, עוקבים אחרי ההתקדמות מהנייד בדרך הביתה, והצוות ממשיך לעבוד בלי הפסקה.', 'Start a task at your desk, follow it from your phone on the way home, and the team keeps working.', 'p').replace('<p ', '<p class="lead" ')}</div>
  {feature('01', 'צוות בוטים פרואקטיבי', 'A proactive team of bots',
    'במקום לחכות שתשאלו, הבוטים יוזמים. בוט ראשי מחלק משימות למומחים, שגרות רצות ברקע, והתראות מגיעות לטלפון רק כשבאמת צריך.',
    "Bots don't wait to be asked. A main bot delegates to specialists, routines run in the background, and your phone buzzes only when it matters.",
    [('בוט ראשי שמנהל את הצוות ומדווח בקצרה', 'A main bot that runs the team and reports briefly'), ('שגרות: לפי שעה, כל כמה דקות, או כשמגיע מייל חדש', 'Routines: by time, every few minutes, or on new mail'), ('המלצות לפעולה בלחיצה אחת, ישר בדשבורד', 'One-tap suggested actions, right on the dashboard')],
    shot('chat', 'Chat with the main bot'))}
  {feature('02', 'מחשב אישי לכל בוט', 'A personal computer for every bot',
    'לכל בוט משתמש ושולחן עבודה משלו במחשב לינוקס וירטואלי שרץ אצלכם: דפדפן, אופיס, טרמינל וקבצים. כולם עובדים במקביל, ואתם צופים בשידור חי.',
    'Every bot has its own user and desktop on a virtual Linux computer running on your server: browser, office suite, terminal, files. They all work in parallel while you watch live.',
    [('השתלטות על העכבר והמקלדת להתחברות או CAPTCHA', 'Take over mouse and keyboard for a login or a CAPTCHA'), ('"למד משימה": מדגימים פעם אחת, והבוט שומר סקיל', '"Teach a task": show it once, the bot saves a skill'), ('סיסמאות מוקלדות מהכספת; המודל לא רואה אותן', 'Passwords are typed from the vault; the model never sees them')],
    shot('computer', "A bot's own computer"))}
  {feature('03', 'למידה מתמשכת, כמו Hermes', 'Continuous learning, Hermes-style',
    'אחרי שיחות, לולאת למידה מתייקת במוח משותף את מה שהתגלה עליכם: העדפות, אנשים, פרויקטים ותיקונים. עבודה שחוזרת על עצמה הופכת לסקיל. המערכת משתפרת מאינטראקציה לאינטראקציה.',
    'After conversations, a learning loop files what it found out about you into a shared Brain: preferences, people, projects, corrections. Repeated work becomes a skill. The system improves with every interaction.',
    [('המוח הוא תיקיית Markdown רגילה, תואמת Obsidian', 'The Brain is a plain Markdown folder, Obsidian-compatible'), ('כל הבוטים חולקים את אותו ידע', 'All bots share the same knowledge'), ('אפשר לייבא זיכרון מעוזר AI אחר', 'Import your memory from another AI assistant')],
    shot('brain', 'The shared Brain'))}
  {feature('04', 'דשבורד שהבוטים בונים עבורכם', 'A dashboard your bots build for you',
    'מבקשים במילים: "וידג׳ט מזג אוויר", "התוצאה האחרונה של הקבוצה שלי", "המיילים החשובים מהיום". הבוט בונה את הווידג׳ט, שם אותו בדשבורד ושומר אותו מעודכן.',
    'Ask in plain words: "a weather widget", "my team\'s last result", "today\'s important mail". The bot builds the widget, puts it on the dashboard and keeps it fresh.',
    [('וידג׳טים הם אפליקציות קטנות וחיות', 'Widgets are small live apps'), ('כרטיסי המלצה: "הביטוח מסתיים בסוף החודש. להשוות בין חברות?"', 'Suggestion cards: "Your insurance ends this month. Compare insurers?"'), ('האפליקציה נפתחת ישר על הדשבורד', 'The app opens straight on the dashboard')],
    f'<div class="duo">{phone("m-dashboard", "Dashboard on a phone")}{phone("m-chat", "Chat on a phone")}</div>')}
  {feature('05', 'המודל הנכון לכל בוט', 'The right model for every bot',
    'בוחרים בעצמכם איזה מודל ועוצמת חשיבה להצמיד לכל בוט, או נותנים למערכת לבחור אוטומטית לכל משימה את המודל הזול ביותר שמספיק.',
    'Pin a model and thinking effort to each bot yourself, or let WitBox automatically pick the cheapest model that is good enough for each task.',
    [('מהיר וזול למיון מייל, החזק ביותר לקוד', 'Fast and cheap for mail triage, the strongest for code'), ('אתם קובעים אילו מודלים מותרים במצב אוטומטי', 'You decide which models auto mode may use'), ('אפשר לחבר גם מודל מקומי', 'A local model can be connected too')],
    shot('botmodel', 'Model per bot'))}
  <div class="cards">
    {card('phone', 'שרת אחד, כל המכשירים', 'One server, every device', 'אפליקציות ל-Android, ל-Windows ול-Linux, וגם כל דפדפן. הכול מסונכרן בזמן אמת.', 'Apps for Android, Windows and Linux, plus any browser. Everything in sync, live.')}
    {card('wave', 'שיחת קול', 'Voice chat', 'מדברים עם הבוט כמו בטלפון. קול עברי טבעי שרץ מקומית, כאפשרות.', 'Talk to a bot like on a phone call. A natural local Hebrew voice is optional.')}
    {card('cloud', 'קונקטורים', 'Connectors', 'Gmail, יומן, Drive וכל מה שמחובר לחשבון ה-Claude שלכם זמין לבוטים.', 'Gmail, Calendar, Drive and everything connected to your Claude account.')}
    {card('shield', 'הרשאות בשליטתכם', 'Permissions you control', 'לכל קונקטור: ללא גישה, קריאה בלבד או קריאה וכתיבה. כרטיס אישור אחד למשימה, בשפה רגילה: ממי המייל ומה הנושא, בלי מידע טכני.', 'Per connector: no access, read only, or read and write. One approval card per task, in plain words: who sent the email and its subject, no technical data.')}
    {card('folder', 'תיקייה משותפת לכל בוט', 'A shared folder per bot', 'הקבצים שהעליתם, הפרויקטים שהבוט בונה והסשנים שלו מופיעים על שולחן העבודה שלו. קוד נכתב שם ורץ רק במחשב של הבוט.', 'Your uploads, the projects the bot builds and its sessions appear on its desktop. Code is written there and runs only on the bot\'s computer.')}
    {card('lock', 'כספת מוצפנת', 'Encrypted vault', 'פרטי התחברות נשמרים מוצפנים על השרת שלכם ומוקלדים עבור הבוט.', 'Logins are stored encrypted on your server and typed for the bot.')}
    {card('hand', 'שליטה במכשיר', 'Device control', 'אפשר לתת לבוט להפעיל את הטלפון או המחשב שבידכם, באישור מהמכשיר עצמו.', 'Let a bot operate the phone or PC in your hands, approved on that device.')}
    {card('phone', 'כלי הטלפון', 'Phone tools', 'באנדרואיד הבוט קורא SMS, שיחות, אנשי קשר, יומן והודעות נכנסות מכל אפליקציה כטקסט, בלי צילומי מסך. כל כלי הוא מתג במכשיר, וקודי אימות מוסתרים.', 'On Android a bot reads SMS, calls, contacts, the calendar and incoming messages of any app as text, without screenshots. Every tool is a switch on the device, and verification codes are hidden.')}
  </div>
</div></section>

<section id="private" class="private"><div class="wrap">
  <div class="center reveal"><div class="kicker">{t('פרטיות', 'Privacy')}</div><h2>{t('הנוחות של ענן. המידע נשאר אצלכם.', 'The comfort of a cloud app. Your data stays home.')}</h2>
  {t('בשירותי בוטים בענן, השיחות, הקבצים והחיבורים שלכם נשמרים אצל הספק. ב-WitBox מקבלים את אותו ממשק נוח, אבל הכול נשמר על המחשב שלכם. <b style="color:var(--tx)">WitBox נועד להתקנה על גבי רשת Tailscale</b>: השרת לא פותח אף פורט לאינטרנט, ורק מכשירים שמחוברים לרשת הפרטית שלכם, בזהות שלכם, יכולים להגיע אליו.',
     'With cloud bot services, your chats, files and connections live with the vendor. WitBox gives you the same easy interface while everything is stored on your own machine. <b style="color:var(--tx)">WitBox is built to be installed on a Tailscale network</b>: the server opens no port to the internet, and only devices on your private network, signed in as you, can reach it.', 'p').replace('<p ', '<p class="lead" ')}</div>
  <div class="net reveal">
    <div class="node"><div class="ic">{ic('phone')}</div><b>{t('המכשירים שלכם', 'Your devices')}</b><small>Android · Windows · Linux · web</small></div>
    <div class="pipe"><span>Tailscale · HTTPS</span></div>
    <div class="node" style="border-color:#e07a5255"><div class="ic" style="color:var(--acc2)">{ic('server')}</div><b>{t('השרת שלכם', 'Your server')}</b><small>{t('בוטים · מוח · קבצים · כספת', 'bots · Brain · files · vault')}</small></div>
  </div>
  <div class="blocked reveal">{t('<b>האינטרנט הציבורי</b> — אין גישה. אין פורט פתוח, אין שרת ביניים, אין ענן של WitBox.', '<b>The public internet</b> — no access. No open port, no relay server, no WitBox cloud.')}</div>
</div></section>

<section id="compare"><div class="wrap">
  <div class="center reveal"><div class="kicker">{t('השוואה', 'Comparison')}</div><h2>{t('איפה WitBox עומד מול כלים דומים', 'How WitBox compares')}</h2>
  {t('הפשטות של Grok Bot, הכוח של Claude Code, הלמידה של Hermes — והמידע אצלכם.', 'The simplicity of Grok Bot, the power of Claude Code, the learning of Hermes — and your data at home.', 'p').replace('<p ', '<p class="lead" ')}</div>
  {table}
  {t('ההשוואה מבוססת על התיעוד הציבורי של כל מוצר בנובמבר 2026. מוצרים משתנים, ולכן כדאי לבדוק באתרים שלהם. "—" פירושו שהיכולת אינה מוצגת כיכולת מרכזית בתיעוד של המוצר. כל שמות המוצרים הם סימני מסחר של בעליהם, ו-WitBox אינו קשור לאף אחד מהם.',
     'Based on each product\'s public documentation in November 2026. Products change, so check their sites. "—" means the feature is not presented as a headline capability in that product\'s documentation. All product names are trademarks of their owners; WitBox is not affiliated with any of them.', 'p').replace('<p ', '<p class="fine" ')}
</div></section>

<section id="install"><div class="wrap">
  <div class="center reveal"><div class="kicker">{t('התקנה', 'Install')}</div><h2>{t('שלושה צעדים, ואתם בפנים', 'Three steps and you are in')}</h2></div>
  <div class="steps">
    <div class="step reveal"><h3>{t('מריצים את המתקין', 'Run the installer')}</h3>{t('קובץ חבילה אחד וסקריפט התקנה. הוא מתקין את כל התלויות על כל הפצת לינוקס נפוצה.', 'One package file and one install script. It installs every dependency on any common Linux distribution.', 'p')}</div>
    <div class="step reveal"><h3>{t('מתחברים', 'Sign in')}</h3>{t('לחשבון ה-Claude שלכם ולרשת ה-Tailscale שלכם. שני קישורים, וזהו.', 'To your Claude account and to your Tailscale network. Two links, done.', 'p')}</div>
    <div class="step reveal"><h3>{t('פותחים את האפליקציה', 'Open the app')}</h3>{t('בטלפון או במחשב, יוצרים בוט ראשון במילים שלכם, ומתחילים לעבוד.', 'On your phone or computer, create your first bot in your own words, and get going.', 'p')}</div>
  </div>
  <div class="reveal" style="max-width:820px;margin:26px auto 0">{pre('curl -fsSL ' + REL + 'install.sh -o install.sh && bash install.sh')}</div>
</div></section>

<section class="final"><div class="wrap"><div class="box reveal">
  <img src="img/mark-256.png" alt="" width="92" height="92">
  <h2>{t('ממשק נקי וזורם. כוח עיבוד ללא פשרות.', 'A clean, flowing interface. No compromise on power.')}</h2>
  {t('חינם, קוד פתוח, ושלכם.', 'Free, open source, and yours.', 'p').replace('<p ', '<p class="lead" style="margin-inline:auto" ')}
  <div class="cta"><a class="btn primary" href="download.html">{ic('dl')}{t('להורדה', 'Download')}</a><a class="btn" href="mailto:{MAIL}">{t('יצירת קשר', 'Contact')}</a></div>
</div></div></section>
</main>'''
page('index.html', 'WitBox — הפשטות שאתם אוהבים. המוח שחיכיתם לו.', 'WitBox — Simple on the outside. Brilliant on the inside.',
     'WitBox brings the simplicity of Grok Bot to Claude Code: a self-hosted team of personal AI bots with continuous learning, a widget dashboard and a computer for every bot. Your data stays with you. Created by Avi Twil.', home)

# ------------------------------------------------------------------ download
def dl(i, he_h, en_h, he_p, en_p, btns, main=False, tag=None, extra=''):
    b = ''.join(f'<a class="btn sm{" primary" if p else ""}" href="{u}">{ic("dl")}{lab}</a>' for lab, u, p in btns)
    tg = f' <span class="tag">{t(*tag)}</span>' if tag else ''
    return f'<div class="dlcard{" main" if main else ""} reveal"><h3>{ic(i)}{t(he_h, en_h)}{tg}</h3>{t(he_p, en_p, "p")}{extra}<div class="row">{b}</div></div>'
download = f'''
<main>
<section class="page-head"><div class="wrap">
  <div class="kicker">{t('הורדה', 'Download')}</div><h1 style="font-size:clamp(34px,5.4vw,58px);font-weight:900">{t('להתקין את WitBox', 'Install WitBox')}</h1>
  {t('WitBox בנוי משני חלקים: <b style="color:var(--tx)">שרת</b> שמותקן פעם אחת על מחשב לינוקס שנשאר דלוק, ו<b style="color:var(--tx)">אפליקציות</b> שמתחברות אליו מהטלפון ומהמחשב. הכול עובר רק דרך רשת ה-Tailscale שלכם.', 'WitBox has two parts: a <b style="color:var(--tx)">server</b> installed once on a Linux machine that stays on, and <b style="color:var(--tx)">apps</b> that connect to it from your phone and computer. Everything travels only over your Tailscale network.', 'p').replace('<p ', '<p class="lead" ')}
  <div class="note">{t('<b>WitBox נועד להתקנה על גבי רשת Tailscale.</b> לפני שמתחילים: פותחים חשבון Tailscale (חינם), ומפעילים במסוף הניהול, בעמוד DNS, את MagicDNS ואת HTTPS Certificates. בכל מכשיר שממנו תשתמשו ב-WitBox מתקינים Tailscale ומתחברים לאותו חשבון.',
       '<b>WitBox is built to be installed on a Tailscale network.</b> Before you start: create a Tailscale account (free) and, in the admin console DNS page, enable MagicDNS and HTTPS Certificates. Install Tailscale on every device you will use WitBox from and sign in to the same account.')}</div>
</div></section>

<section style="padding-top:34px"><div class="wrap">
  <h2 class="reveal" style="font-size:30px">{t('1 · השרת', '1 · The server')}</h2>
  <div class="dl">
    {dl('server', 'שרת לינוקס', 'Linux server', 'חבילה אחת שמכילה הכול (שרת, ממשק ואפליקציות) וסקריפט התקנה לצידה. הסקריפט מוריד ומתקין את כל התלויות, מחבר ל-Claude ול-Tailscale, ובונה את המחשב של הבוטים. מתאים ל-Debian, Ubuntu, Kali, Mint, Fedora, Arch, Manjaro ו-openSUSE.',
        'One package with everything (server, web UI and apps) and an install script next to it. The script downloads and installs every dependency, signs you in to Claude and Tailscale, and builds the bots\' computer. Works on Debian, Ubuntu, Kali, Mint, Fedora, Arch, Manjaro and openSUSE.',
        [('witbox-linux-x86_64.tar.gz', REL + 'witbox-linux-x86_64.tar.gz', True), ('install.sh', REL + 'install.sh', False)], main=True,
        extra=t('שמים את שני הקבצים באותה תיקייה ומריצים:', 'Put both files in one folder and run:', 'p') + pre('chmod +x install.sh\n./install.sh') + t('או בשורה אחת, והסקריפט מוריד את החבילה בעצמו:', 'Or in one line — the script downloads the package itself:', 'p') + pre('curl -fsSL ' + REL + 'install.sh -o install.sh && bash install.sh'))}
    {dl('win', 'שרת על Windows', 'Server on Windows', 'מתקין אחד ל-Windows. הוא מתקין את האפליקציה, ואם מסמנים "WitBox server on this PC" הוא גם מקים את השרת בתוך WSL2 (Ubuntu). דורש Windows 11 עם וירטואליזציה. המסלול הזה נבדק פחות משרת לינוקס רגיל.',
        'One installer for Windows. It installs the app and, if you tick "WitBox server on this PC", also sets the server up inside WSL2 (Ubuntu). Needs Windows 11 with virtualization. This path has had less testing than a native Linux server.',
        [('WitBox-Setup.exe', REL + 'WitBox-Setup.exe', True)], tag=('ניסיוני', 'Experimental'))}
  </div>
  <div class="req reveal">
    <div><b>{t('מחשב', 'Machine')}</b><span>{t('לינוקס x86_64 עם systemd, 8GB זיכרון לפחות (מומלץ 16GB), כ-15GB דיסק', 'x86_64 Linux with systemd, 8 GB RAM minimum (16 GB recommended), ~15 GB disk')}</span></div>
    <div><b>Claude</b><span>{t('מנוי בתשלום (Pro, Max או Team). מתחברים במהלך ההתקנה', 'A paid plan (Pro, Max or Team). You sign in during the installation')}</span></div>
    <div><b>Tailscale</b><span>{t('חשבון חינמי, עם MagicDNS ו-HTTPS מופעלים', 'A free account, with MagicDNS and HTTPS enabled')}</span></div>
    <div><b>{t('המחשב של הבוטים', "The bots' computer")}</b><span>{t('דורש וירטואליזציה (KVM). בלעדיה WitBox עובד בלי המחשב המשותף', 'Needs virtualization (KVM). Without it WitBox runs without the shared computer')}</span></div>
  </div>

  <h2 class="reveal" style="font-size:30px;margin-top:70px">{t('2 · האפליקציות', '2 · The apps')}</h2>
  {t('בהפעלה הראשונה כל אפליקציה מבקשת את כתובת השרת שהמתקין הדפיס (למשל <code>https://my-server.my-tailnet.ts.net</code>). אחרי ההתקנה השרת מגיש את האפליקציות בעצמו: הגדרות ← עדכונים.', 'On first start each app asks for the server address the installer printed (for example <code>https://my-server.my-tailnet.ts.net</code>). Once installed, the server also serves the apps itself: Settings → Updates.', 'p').replace('<p ', '<p class="lead reveal" ')}
  <div class="dl">
    {dl('android', 'Android', 'Android', 'טלפון וטאבלט. התראות, שיחת קול ודשבורד. מתירים התקנה מהדפדפן, פותחים ומזינים את כתובת השרת.', 'Phone and tablet. Notifications, voice chat and the dashboard. Allow installing from your browser, open, and enter the server address.', [('WitBox.apk', REL + 'WitBox.apk', True), (t('מהדורה מלאה (adb)', 'Full edition (adb)'), REL + 'WitBox-full.apk', False)])}
    {dl('win', 'Windows', 'Windows', 'מתקין עם קיצורי דרך והפעלה עם Windows, או קובץ נייד יחיד. האפליקציה יושבת במגש המערכת.', 'An installer with shortcuts and start-with-Windows, or a single portable file. The app lives in the system tray.', [('WitBox-Setup.exe', REL + 'WitBox-Setup.exe', True), (t('קובץ נייד', 'Portable'), REL + 'WitBox-windows-x64.exe', False)])}
    {dl('linux', 'Linux', 'Linux', 'קובץ הרצה יחיד למחשב שולחני (דורש WebKitGTK 4.1).', 'A single executable for the desktop (needs WebKitGTK 4.1).', [('witbox-linux-x86_64', REL + 'witbox-linux-x86_64', True)], extra=pre('chmod +x witbox-linux-x86_64 && ./witbox-linux-x86_64'))}
  </div>
  {t(f'כל הגרסאות, קוד המקור וסכומי הביקורת (SHA256SUMS): <a href="{REPO}/releases" style="color:var(--acc2)">GitHub Releases</a>. שאלות: <a href="mailto:{MAIL}" style="color:var(--acc2)">{MAIL}</a>. השימוש כפוף ל<a href="terms.html" style="color:var(--acc2)">תנאי השימוש</a>.',
     f'All versions, the source code and checksums (SHA256SUMS): <a href="{REPO}/releases" style="color:var(--acc2)">GitHub Releases</a>. Questions: <a href="mailto:{MAIL}" style="color:var(--acc2)">{MAIL}</a>. Use is subject to the <a href="terms.html" style="color:var(--acc2)">terms of use</a>.', 'p').replace('<p ', '<p class="fine reveal" style="margin-top:34px;font-size:15px" ')}
</div></section>
</main>'''
page('download.html', 'הורדה — WitBox', 'Download — WitBox', 'Download WitBox: the Linux server package with its install script, the Windows installer, and the Android, Windows and Linux apps.', download)

# ------------------------------------------------------------------ terms
def sec(he_h, en_h, he, en): return f'<h2>{t(he_h, en_h)}</h2>{tb(he, en)}'
terms = f'''
<main><section class="page-head"><div class="wrap legal">
<div class="kicker">{t('משפטי', 'Legal')}</div>
<h1>{t('תנאי שימוש והסרת אחריות', 'Terms of use and disclaimer')}</h1>
<p class="upd">{t('עודכן לאחרונה: 18 בנובמבר 2026', 'Last updated: 18 November 2026')}</p>
{tb('<p>WitBox ("התוכנה") הוא תוכנה חופשית בקוד פתוח שנוצרה ע"י Avi Twil ("היוצר"). בהורדה, בהתקנה או בשימוש בתוכנה אתם מסכימים לתנאים האלה. אם אינכם מסכימים, אל תשתמשו בתוכנה.</p>',
    '<p>WitBox (the "Software") is free, open-source software created by Avi Twil (the "Author"). By downloading, installing or using the Software you agree to these terms. If you do not agree, do not use it.</p>')}
{sec('1. הרישיון', '1. Licence', f'<p>התוכנה מופצת תחת <a href="{REPO}/blob/main/LICENSE" style="color:var(--acc2)">רישיון MIT</a>. במקרה של סתירה בין העמוד הזה לבין הרישיון, הרישיון גובר לגבי זכויות השימוש בקוד.</p>', f'<p>The Software is distributed under the <a href="{REPO}/blob/main/LICENSE" style="color:var(--acc2)">MIT licence</a>. Where this page and the licence conflict about rights to the code, the licence prevails.</p>')}
{sec('2. התוכנה ניתנת "כמות שהיא"', '2. The Software is provided "as is"', '<p>התוכנה ניתנת כמות שהיא (AS IS) וכפי שהיא זמינה, ללא אחריות מכל סוג, מפורשת או משתמעת, לרבות אחריות לסחירות, להתאמה למטרה מסוימת, לאי-הפרה, לזמינות, לדיוק או לאבטחה. היוצר אינו מתחייב שהתוכנה תפעל ללא תקלות, ללא הפרעות או ללא שגיאות.</p>', '<p>The Software is provided "AS IS" and "AS AVAILABLE", without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, non-infringement, availability, accuracy or security. The Author does not promise that the Software will run without faults, interruptions or errors.</p>')}
{sec('3. האחריות לשימוש היא שלכם בלבד', '3. You alone are responsible for your use', '''<p>WitBox מפעיל סוכני בינה מלאכותית אוטונומיים. לפי ההרשאות שתיתנו להם, הם יכולים לגלוש באינטרנט, להפעיל מחשב, להריץ קוד, לקרוא ולשלוח מיילים והודעות, לשנות ולמחוק קבצים, ולפעול בחשבונות ובשירותים שחיברתם. סוכני AI טועים, מפרשים הוראות באופן שגוי, ועלולים לפעול בצורה לא צפויה.</p>
<ul><li>האחריות המלאה והבלעדית לשימוש בתוכנה, לכל פעולה שהבוטים מבצעים ולכל תוצאה שלה, היא על המשתמש בלבד.</li><li>באחריותכם להגדיר הרשאות ואישורים, לפקח על פעולות הבוטים, ולבדוק כל תוצר לפני שמסתמכים עליו.</li><li>באחריותכם לגבות את המידע שלכם ולאבטח את השרת, את רשת ה-Tailscale ואת החשבונות שלכם.</li><li>אל תסתמכו על התוכנה בהחלטות רפואיות, משפטיות, פיננסיות או בטיחותיות, ואל תשתמשו בה במקום שבו תקלה עלולה לגרום לנזק לגוף או לרכוש.</li></ul>''',
 '''<p>WitBox runs autonomous AI agents. Depending on the permissions you give them, they can browse the web, operate a computer, run code, read and send email and messages, change and delete files, and act in accounts and services you connect. AI agents make mistakes, misread instructions and may behave unexpectedly.</p>
<ul><li>Full and sole responsibility for the use of the Software, for every action the bots take and for every outcome, lies with the user.</li><li>You are responsible for configuring permissions and approvals, supervising what the bots do, and checking every output before relying on it.</li><li>You are responsible for backing up your data and for securing your server, your Tailscale network and your accounts.</li><li>Do not rely on the Software for medical, legal, financial or safety decisions, and do not use it where a failure could cause injury or damage to property.</li></ul>''')}
{sec('4. הגבלת אחריות', '4. Limitation of liability', '<p>במידה המרבית שהדין מתיר, היוצר והתורמים לפרויקט לא יישאו באחריות לכל נזק ישיר, עקיף, מקרי, מיוחד, תוצאתי או עונשי, לרבות אובדן מידע, אובדן רווחים, פגיעה בחשבונות, חיובים כספיים, הפרעה לעסק או פגיעה בפרטיות, הנובעים מהשימוש בתוכנה או מחוסר היכולת להשתמש בה — גם אם נמסרה הודעה על האפשרות לנזק כזה.</p>', '<p>To the maximum extent permitted by law, the Author and the project\'s contributors shall not be liable for any direct, indirect, incidental, special, consequential or punitive damages — including loss of data, loss of profits, harm to accounts, charges, business interruption or loss of privacy — arising from the use of, or inability to use, the Software, even if advised of the possibility of such damages.</p>')}
{sec('5. שירותי צד שלישי', '5. Third-party services', '<p>WitBox פועל באמצעות שירותים של אחרים: מנוי ה-Claude שלכם אצל Anthropic, רשת ה-Tailscale שלכם, הקונקטורים שחיברתם (כגון Google), וכל אתר שהבוטים ניגשים אליו. השימוש בשירותים האלה כפוף לתנאים ולמדיניות של כל ספק, ובאחריותכם לעמוד בהם, לרבות מגבלות השימוש והמדיניות של Anthropic. WitBox הוא פרויקט עצמאי; הוא אינו קשור ל-Anthropic, ל-xAI, ל-Nous Research, ל-OpenClaw או ל-Tailscale ואינו נתמך או מאושר על ידן. שמות המוצרים המוזכרים באתר הם סימני מסחר של בעליהם ומובאים לצורך תיאור והשוואה בלבד.</p>', "<p>WitBox works through other parties' services: your Claude subscription with Anthropic, your Tailscale network, the connectors you attach (such as Google), and any website the bots visit. Your use of those services is governed by each provider's terms and policies, and complying with them — including Anthropic's usage limits and policies — is your responsibility. WitBox is an independent project; it is not affiliated with, endorsed by or sponsored by Anthropic, xAI, Nous Research, OpenClaw or Tailscale. Product names mentioned on this site are trademarks of their owners and are used for description and comparison only.</p>")}
{sec('6. פרטיות ומידע', '6. Privacy and data', f'<p>התוכנה מותקנת ורצה על המחשב שלכם. היוצר אינו מפעיל שרתים שמקבלים את השיחות, הקבצים, הזיכרון או הסיסמאות שלכם, ואינו אוסף נתוני שימוש מהתוכנה. תוכן שהבוטים מעבדים נשלח לספק המודל (Anthropic) במסגרת המנוי שלכם, ולשירותים שחיברתם, לפי התנאים שלהם. האתר הזה הוא אתר סטטי; הוא טוען גופנים מ-Google Fonts, וקישורי ההורדה מובילים ל-GitHub. פנייה במייל ל-{MAIL} תשמש רק כדי להשיב לכם.</p>', f'<p>The Software is installed and runs on your own machine. The Author operates no servers that receive your chats, files, memory or passwords, and collects no usage data from the Software. Content the bots process is sent to the model provider (Anthropic) under your subscription, and to the services you connected, under their terms. This website is static; it loads fonts from Google Fonts, and download links lead to GitHub. Email sent to {MAIL} is used only to reply to you.</p>')}
{sec('7. שימוש מותר', '7. Acceptable use', '<p>אין להשתמש בתוכנה לפעילות בלתי חוקית, לגישה למערכות או לחשבונות ללא הרשאה, להפצת ספאם, להטרדה, או לכל שימוש שמפר זכויות של אחרים או את התנאים של השירותים המחוברים.</p>', "<p>Do not use the Software for unlawful activity, for accessing systems or accounts without authorisation, for spam or harassment, or in any way that violates others' rights or the terms of the connected services.</p>")}
{sec('8. רכיבים ברישיונות אחרים', '8. Components under other licences', '<p>המתקין מוריד רכיבי צד שלישי ברישיונות משלהם (בין היתר Node.js, Claude Agent SDK, noVNC, QEMU ו-Ubuntu). הקול העברי האופציונלי משתמש במודלים Phonikud ו-Piper "shaul", שמותרים לשימוש לא מסחרי בלבד.</p>', '<p>The installer downloads third-party components under their own licences (among them Node.js, the Claude Agent SDK, noVNC, QEMU and Ubuntu). The optional Hebrew voice uses the Phonikud and Piper "shaul" models, which are licensed for non-commercial use only.</p>')}
{sec('9. שינויים ויצירת קשר', '9. Changes and contact', f'<p>התנאים עשויים להתעדכן מעת לעת; הגרסה שבעמוד הזה היא הקובעת. לשאלות: <a href="mailto:{MAIL}" style="color:var(--acc2)">{MAIL}</a>.</p>', f'<p>These terms may be updated from time to time; the version on this page applies. Questions: <a href="mailto:{MAIL}" style="color:var(--acc2)">{MAIL}</a>.</p>')}
</div></section></main>'''
page('terms.html', 'תנאי שימוש והסרת אחריות — WitBox', 'Terms of use and disclaimer — WitBox', 'WitBox terms of use and disclaimer: the software is provided as is, and responsibility for its use lies with the user alone.', terms)
print('site built')
