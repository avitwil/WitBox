// Bot runtime: every bot is a Claude agent (Claude Agent SDK on the local Claude subscription)
// with its own profile, memory, skills, workspace, desktop and permissions.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { state, save, emit, uid, botDir, getBot, addMessage, updateMessage, messages, MODELS, SHARED_DIR, SKILLS_DIR, BRAIN, memFile, journal, DATA, inside, tz } from './store.mjs';
import * as vm from './vm.mjs';
import * as dash from './dashboard.mjs';
import * as vault from './vault.mjs';
import { notify, listDevices, deviceRequest } from './devices.mjs';

const running = new Map();   // botId -> {abort, msg}
const chains = new Map();    // botId -> Promise (turn queue)
const approvals = new Map(); // id -> resolve(decision)
const secrets = new Map();   // id -> resolve(value)

export const isRunning = (id) => running.has(id);
export const botStatus = (id) => running.get(id)?.status || null;

// ---------------------------------------------------------------- prompts
function listSkills() {
  const out = [];
  let files = []; try { files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md') && f !== 'Skills.md'); } catch {}
  for (const f of files) {
    const txt = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
    const desc = (txt.match(/^description:\s*(.+)$/m) || [])[1] || txt.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '';
    const uses = Number((txt.match(/^uses:\s*(\d+)/m) || [])[1] || 0);
    out.push({ name: f.replace(/\.md$/, ''), scope: 'shared', file: path.join(SKILLS_DIR, f), description: desc.slice(0, 200), uses, origin: (txt.match(/^origin:\s*(.+)$/m) || [])[1] || '' });
  }
  return out;
}
export { listSkills };

function systemPrompt(bot, ctx) {
  const rd = (f, n) => { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return ''; } };
  const mem = rd(memFile(bot), 8000);
  const profile = rd(path.join(BRAIN, 'User/Profile.md'), 5000), prefs = rd(path.join(BRAIN, 'User/Preferences.md'), 7000);
  const brainIndex = (() => { const out = []; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) { if (!['Journal', 'Skills'].includes(r)) walk(path.join(d, e.name), r); } else if (e.name.endsWith('.md')) out.push(r); } }; try { walk(BRAIN, ''); } catch {} return out.slice(0, 250).join('\n'); })();
  const skills = listSkills();
  const others = state.bots.filter((b) => b.id !== bot.id && !b.hidden).map((b) => `- ${b.name}${b.title ? ' — ' + b.title : ''}`).join('\n');
  const s = state.settings;
  const mainBot = state.bots.find((b) => b.id === s.mainBotId);
  const team = mainBot?.id === bot.id
    ? `\n# You are the main bot\nYou are ${s.userName || 'the user'}'s MAIN bot — the lead of the bot team and the one they talk to most. Handle everyday requests yourself; when a request belongs to a teammate's speciality, delegate it with mcp__bot__message_bot and relay the result briefly. Teammates may message you with reports ("message from <bot>"): tell the user what matters in a short message of your own, and skip what does not need their attention.\n`
    : mainBot ? `\n# Team\nThe team's main bot is ${mainBot.name}; the user follows that chat most closely. When you find something the user should know while working unattended (a routine), alert with mcp__bot__notify and, when it needs follow-up or context, also report it to ${mainBot.name} with mcp__bot__message_bot.\n` : '';
  return `You are ${bot.name}${bot.title ? ', ' + bot.title : ''} — one of ${s.userName || 'the user'}'s personal bots in WitBox, a self-hosted team of AI agents. You are powered by Claude.

# Your profile
${bot.description ? 'About you: ' + bot.description + '\n' : ''}${bot.instructions ? 'Your role and instructions:\n' + bot.instructions + '\n' : ''}${bot.tasks ? 'Your standing tasks:\n' + bot.tasks + '\n' : ''}${bot.interests?.length ? 'Your areas of interest: ' + bot.interests.join(', ') + '\n' : ''}${bot.rules ? 'Rules from the user (always obey):\n' + bot.rules + '\n' : ''}
# How you work
- Talk like a capable colleague in a chat app: short, direct messages. Reply in the language the user writes in (default ${s.language === 'en' ? 'English' : 'Hebrew'}). No preamble, no filler.
- You act, not just advise. Use your tools to actually get things done, then report the outcome briefly: done / waiting on the user / failed (and why).
- Current date/time: ${new Date().toLocaleString('en-GB', { timeZone: tz(), dateStyle: 'full', timeStyle: 'short' })} (${tz()}).
${ctx.voice ? '- THIS IS A LIVE VOICE CONVERSATION: the user is speaking to you and your reply is read aloud by a speech engine. Answer the way a person talks on the phone: one to three short spoken sentences, plain words, no markdown, no lists, no emojis, no URLs or code, numbers written the way they are said. Answer first, then stop — the user will ask for more if they want it. If a task needs real work (tools, the computer), say in one sentence that you are on it, do it, then say the result in one or two sentences.\n' : ''}${ctx.dashboard ? '- The user sent this message from the dashboard screen: treat it as a request to add or change something on the dashboard (usually a new widget) unless it clearly says otherwise. Build it, then confirm in one short line.\n' : ''}${ctx.source === 'routine' ? `- This turn was started automatically by your routine "${ctx.routineName}". Nobody is watching live. If there is nothing worth telling the user, reply with exactly NOOP and nothing else.\n` : ''}${ctx.source === 'bot' ? `- This message was sent to you by another bot (${ctx.fromBot}). Answer it concisely; your reply is returned to that bot.\n` : ''}
# Your computer
You have your own desktop on a shared Ubuntu Linux PC (XFCE desktop, user "${bot.pcUser || 'created on first use'}", home /home/${bot.pcUser || '<you>'}${bot.pcSudo ? ', passwordless sudo' : ', no sudo'}). Every bot has a separate user and desktop session on the same machine, all running in parallel; installed apps are shared, and /srv/shared is a folder all bots can read and write. Installed: Google Chrome (google-chrome), Firefox, LibreOffice (Writer/Calc/Impress), a terminal, file manager, Python 3, Node.js, git, ffmpeg, ImageMagick.
- mcp__bot__computer: see and control your desktop (screenshot, click, type, keys, scroll). Screen is ${vm.DESKTOP_SIZE.W}x${vm.DESKTOP_SIZE.H}; coordinates are pixels in the screenshot. Always take a screenshot before acting and after important steps. One action at a time. In a terminal window paste is ctrl+shift+v.
- mcp__bot__pc_shell: run a bash script on that PC as your user. Prefer it over clicking for files, downloads and scripts — it is faster and more reliable. It can also open GUI apps on your desktop: start them detached, e.g. \`setsid google-chrome "https://example.com" >/dev/null 2>&1 &\`, then look with mcp__bot__computer.${bot.pcSudo ? ' Install software with sudo apt-get install -y.' : ' You have no sudo: install user-level software only (pip install --user, npm with a prefix in your home, portable binaries); if a system package is needed, tell the user to install it via Settings → Shared computer → "Open as admin" or to give you admin rights in your bot settings.'}
- mcp__bot__pc_copy: copy files between the PC and your workspace.
- Passwords, 2FA codes, CAPTCHAs, payments: never ask for them in chat. Use mcp__bot__secure_input (the user types the secret into a secure form and it is typed into your focused field; you never see it) or mcp__bot__request_takeover (the user takes control of your desktop, completes the step, and hands it back).
- Your workspace (this working directory) is private storage on the server for notes, downloads and files to send; put deliverables in ./files. You cannot access the rest of the server.

# Connectors
Tools named mcp__claude_ai_* are the user's Claude connectors (e.g. Gmail, Google Drive, Calendar and others). Use them for those services instead of the browser. If a connector you need is missing or unauthenticated, tell the user to enable it in the Claude app (claude.ai → Settings → Connectors) — it then appears here automatically.

# Showing things to the user
The chat renders Markdown (tables, code, lists). For anything richer use mcp__bot__show_artifact — it opens a live panel next to the chat, like Claude artifacts:
- type "html": dashboards, boards, interactive tools, charts (self-contained HTML/CSS/JS; CDN scripts allowed).
- type "sheet": spreadsheets — pass CSV; the user gets a sortable grid and Excel/CSV download.
- type "markdown": documents and reports. type "svg": diagrams. type "mermaid": flowcharts.
Use mcp__bot__send_file to deliver real files (docx, xlsx, pdf, zip, images…) from your workspace.

# The dashboard
The app opens on a full-screen dashboard that belongs to the user. You and your teammates fill it; the user asks for things in chat ("put the weather on my dashboard", "add a widget with my team's last result").
- mcp__bot__dashboard_widget adds or updates a widget: a small self-contained HTML app in a card. Make it look native: transparent background (never set a page background), no outer card or title of your own, compact, readable at a glance, fluid width and height (it must work at about 300x190 px for size "small" and on a phone). The page already has a base font, margins and these CSS variables — use them instead of hard-coded colours so the widget follows the light/dark theme: --tx (text), --tx2, --tx3 (muted), --card2 (inner surface), --line (borders), --acc (accent), --ok, --warn, --bad, --blue. The interface language is ${s.language === 'en' ? 'English (ltr)' : 'Hebrew (rtl)'}.
- Live data, in order of preference: (1) fetch it in the widget's own script from a free public API that allows cross-origin requests without a key (e.g. open-meteo.com for weather), and re-fetch on a timer — this costs nothing; (2) for information only you can get (connectors such as mail and calendar, web research, the user's accounts), put it in "data" (read it as window.DATA) and set refresh_minutes + refresh_prompt so you bring fresh data on a schedule. Keep the schedule as slow as the information allows (sports results: every few hours; mail summary: 30-60 minutes). The widget runs in a sandbox with no access to the app, cookies or storage.
- A widget can hand work to you: call cb.ask("the instruction") from a click handler (e.g. a "compare prices" button). The app sends that text to you as a chat message and switches the user to this chat.
- mcp__bot__dashboard_suggest puts a suggestion card at the top of the dashboard. Use it — mostly from routines — when you notice something the user would want acted on and you can do the next step: say what happened and offer up to three concrete actions. Example: title "הביטוח לרכב מסתיים בסוף החודש", text "הגיע מייל מחברת הביטוח על סיום הפוליסה ב-30 בחודש.", actions [{label: "השווה הצעות", prompt: "..."}, {label: "בדוק חידוש", prompt: "..."}]. Do not use it for things that need no decision, and remove a suggestion (mcp__bot__dashboard op remove_suggestion) once it is no longer relevant.
- mcp__bot__dashboard lists what is on the dashboard and fetches a widget's source before you change it. To change an existing widget update it by id; never create a duplicate.
Use mcp__bot__notify to push a notification to the user's phone/desktop — only for things worth interrupting them (important email, finished long task, something needs their decision).

# The Brain (shared second brain) — you get better over time
All bots share one Obsidian vault at ${BRAIN} (Markdown notes, [[wikilinks]], YAML frontmatter, #tags). It is the single source of truth about the user and everything the team knows. You can Read/Grep/Glob/Write/Edit it directly.
Layout: User/Profile.md and User/Preferences.md (who the user is, how they like things) · People/<Name>.md · Projects/<Name>.md · Knowledge/<Topic>.md · Skills/<skill>.md · Journal/<date>.md (automatic activity log) · Bots/<bot>/Memory.md (your own working memory).
Learning the user is your most important long-term job:
- Before a non-trivial task, check the Brain for what is already known (Grep the vault; the note index is below). Never re-research what the Brain already holds.
- Whenever you learn something durable — a preference, a correction ("not like that, like this"), a fact about the user, a person, an account, a project, how a site or app works, a mistake to avoid — write it down immediately: mcp__bot__remember for quick facts (scope "user" for preferences about the user, "bot" for your own working notes), or create/update a proper note in the right folder and link it with [[wikilinks]]. Update existing notes rather than duplicating. Do this silently; do not ask permission to remember.
- Skills are saved procedures. When a task matches a skill, Read the skill file first and follow it instead of figuring it out again; if a step turned out wrong or you found a better way, fix the skill file. When you complete a multi-step task you might be asked to do again, or notice you are doing something for the second time, save it with mcp__bot__save_skill (exact steps, commands, URLs, selectors/coordinates hints, pitfalls, how to verify).
- A background learner also reviews your finished conversations and files what it learns into the Brain, so the notes may grow between conversations.
${skills.length ? 'Available skills:\n' + skills.map((k) => `- ${k.name} — ${k.description} → ${k.file}`).join('\n') : 'No skills saved yet.'}
- Routines: you can schedule your own recurring work with mcp__bot__routine (e.g. every weekday at 08:00, every 10 minutes, or on new email).
${others ? '\n# Teammates\nOther bots you can consult or delegate to with mcp__bot__message_bot:\n' + others + '\n' : ''}
${(s.askRules || []).length || (s.allowRules || []).length ? `\n# The user's approval rules (apply to every bot)\n${(s.askRules || []).length ? 'ALWAYS stop and get approval with mcp__bot__ask_approval BEFORE any action matching one of these, even if you are otherwise allowed to do it:\n' + s.askRules.map((r) => '- ' + r).join('\n') + '\n' : ''}${(s.allowRules || []).length ? 'You may proceed WITHOUT asking when an action matches one of these (your tool permissions still apply):\n' + s.allowRules.map((r) => '- ' + r).join('\n') + '\n' : ''}` : ''}
# Vault
The user keeps logins and contact details in a vault. mcp__bot__vault_list shows what exists (never passwords). To sign in on your desktop: click the field, then mcp__bot__vault_fill types the username or the password straight into it — you never see the password. Never ask the user to paste a password in chat.
${team}# Local devices
The user may let you control the device they are currently using (Windows/Linux PC or Android) through the WitBox app: mcp__bot__list_devices then mcp__bot__device_control. Each device decides locally (always / ask / never) whether you are allowed. Only use it when the user asks for something on that device.

# What the Brain knows about the user
## User/Profile.md
${profile.trim() || '(empty)'}
## User/Preferences.md
${prefs.trim() || '(empty)'}
## Your own memory (Bots/…/Memory.md)
${mem.trim() || '(empty)'}
## Brain note index
${brainIndex}`;
}

// ---------------------------------------------------------------- permissions
function pushBlock(turn, block) {
  turn.msg.blocks.push(block);
  updateMessage(turn.bot.id, turn.msg);
  return block;
}

async function askUser(turn, { title, detail, toolKey }) {
  const bot = turn.bot;
  if (toolKey && bot.allowTools?.includes(toolKey)) return 'allow';
  turn.reveal?.();
  const block = pushBlock(turn, { type: 'approval', id: uid(10), title, detail: String(detail || '').slice(0, 1500), status: 'pending', toolKey });
  setStatus(turn, 'waiting');
  notify({ botId: bot.id, botName: bot.name, title: `${bot.name} מבקש אישור`, body: title, priority: 'high' });
  const decision = await new Promise((res) => {
    approvals.set(block.id, res);
    turn.abort.signal.addEventListener('abort', () => res('deny'));
    setTimeout(() => res('timeout'), 30 * 60000);
  });
  approvals.delete(block.id);
  block.status = decision === 'always' ? 'always' : decision === 'allow' ? 'allowed' : decision === 'timeout' ? 'timeout' : 'denied';
  if (decision === 'always' && toolKey) { (bot.allowTools ||= []).push(toolKey); save(); }
  updateMessage(bot.id, turn.msg);
  setStatus(turn, 'working');
  return decision === 'always' ? 'allow' : decision === 'allow' ? 'allow' : 'deny';
}
export function resolveApproval(id, decision) { const r = approvals.get(id); if (r) r(decision); return !!r; }
export function resolveSecret(id, value) { const r = secrets.get(id); if (r) r(value); return !!r; }

async function gate(turn, level, ask) {
  if (level === 'always' && state.settings.approvalMode !== 'strict') return true;
  if (level === 'never') return false;
  return (await askUser(turn, ask)) === 'allow';
}

const READ_VERBS = /(^|_)(search|get|list|read|fetch|query|find|view|download|describe|lookup|check|status|export|guide)(_|$)/i;
const connectorOf = (name) => (name.match(/^mcp__(.+?)__/) || [])[1] || '';

function canUseToolFor(turn) {
  const bot = turn.bot;
  const allowedRoots = [botDir(bot.id), BRAIN];
  const pathOk = (p) => { if (!p) return true; const r = path.resolve(botDir(bot.id), String(p)); return allowedRoots.some((b) => r === b || r.startsWith(b + path.sep)); };
  return async (toolName, input) => {
    const allow = { behavior: 'allow', updatedInput: input };
    const deny = (message) => ({ behavior: 'deny', message });
    if (toolName.startsWith('mcp__bot__')) return allow; // gated inside each tool
    if (['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'].includes(toolName)) {
      return pathOk(input.file_path || input.path || input.notebook_path) ? allow : deny('You can only access files inside your own workspace.');
    }
    if (['WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill'].includes(toolName)) return allow;
    if (toolName === 'Bash') {
      const ok = await gate(turn, bot.perms.hostShell || 'never', { title: 'להריץ פקודה על שרת הלינוקס', detail: input.command, toolKey: null });
      return ok ? allow : deny('Running commands on the host server is not permitted for this bot. Use mcp__bot__pc_shell on your own PC instead.');
    }
    if (toolName.startsWith('mcp__')) {
      const server = connectorOf(toolName);
      if (Array.isArray(bot.connectors) && !bot.connectors.some((c) => server.toLowerCase().includes(c.toLowerCase().replace(/[^a-z0-9]+/gi, '_')) || c.toLowerCase().replace(/[^a-z0-9]+/gi, '_').includes(server.toLowerCase()))) {
        return deny(`The connector "${server}" is not enabled for this bot.`);
      }
      const short = toolName.split('__').pop();
      if (turn.readOnly?.has(toolName) || (!turn.readOnly?.size && READ_VERBS.test(short))) return allow;
      const ok = await gate(turn, bot.perms.connectorWrite || 'ask', { title: `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${short.replace(/_/g, ' ')}`, detail: JSON.stringify(input, null, 1), toolKey: toolName });
      return ok ? allow : deny('The user did not approve this action.');
    }
    return deny('Tool not available.');
  };
}

// ---------------------------------------------------------------- bot tools
const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const errOut = (t) => ({ content: [{ type: 'text', text: 'Error: ' + String(t) }], isError: true });

function botTools(turn) {
  const bot = turn.bot;
  const safe = (fn) => async (args) => { try { return await fn(args); } catch (e) { return errOut(e.message || e); } };
  const shot = async () => ({ type: 'image', data: (await vm.screenshot(bot.id)).toString('base64'), mimeType: 'image/jpeg' });

  return [
    tool('computer', 'Control your own desktop (Ubuntu, XFCE). Actions: screenshot | click | double_click | right_click | move | drag (x,y → x2,y2) | type (text) | key (keys e.g. "ctrl+c", "Return", "ctrl+l", "alt+F4", "super") | scroll (direction up/down/left/right, amount) | wait (seconds). Every action returns a fresh screenshot.',
      { action: z.enum(['screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait']), x: z.number().optional(), y: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(), text: z.string().optional(), keys: z.string().optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional(), seconds: z.number().optional() },
      safe(async (a) => {
        if (!(await gate(turn, bot.perms.computer, { title: 'שימוש במחשב (שולחן העבודה של הבוט)', detail: JSON.stringify(a), toolKey: 'computer' }))) return errOut('The user did not allow computer use.');
        setStatus(turn, 'computer');
        await vm.ensureDesktop(bot);
        if (vm.desktopInfo(bot.id).takeover) { await vm.waitTakeoverEnd(bot.id); }
        if (a.action !== 'screenshot') { await vm.desktopAction(bot.id, a); await new Promise((r) => setTimeout(r, a.action === 'wait' ? 0 : 900)); }
        return { content: [await shot()] };
      })),

    tool('pc_shell', 'Run a bash script on the shared Ubuntu PC as your own Linux user. Returns stdout/stderr. DISPLAY points at your desktop, so detached GUI apps (setsid app >/dev/null 2>&1 &) open there. Use for files, downloads, scripting, installs.',
      { script: z.string(), timeout_seconds: z.number().optional() },
      safe(async ({ script, timeout_seconds }) => {
        if (!(await gate(turn, bot.perms.shell, { title: 'הרצת פקודה במחשב של הבוט', detail: script, toolKey: 'pc_shell' }))) return errOut('The user did not allow this command.');
        if (!(await vm.vmStatus()).ready) return errOut('The shared computer is not ready.');
        await vm.ensurePcUser(bot);
        if (bot.perms.computer !== 'never') await vm.ensureDesktop(bot).catch(() => {}); // so GUI apps started from the shell have a desktop to open on
        const r = await vm.pcExec(script, { user: bot.pcUser, timeout: Math.min(900, timeout_seconds || 120) * 1000 });
        return txt(`exit=${r.code}\n${(r.stdout || '').slice(-12000)}${r.stderr ? '\nSTDERR:\n' + r.stderr.slice(-4000) : ''}`);
      })),

    tool('pc_copy', 'Copy a file between the shared PC and your workspace. direction "from_pc": pc_path → workspace_path. "to_pc": workspace_path → pc_path. PC paths are absolute Linux paths, e.g. /home/<you>/Documents/file.xlsx or /srv/shared/file.pdf.',
      { direction: z.enum(['from_pc', 'to_pc']), pc_path: z.string(), workspace_path: z.string() },
      safe(async ({ direction, pc_path, workspace_path }) => {
        await vm.ensurePcUser(bot);
        const local = inside(botDir(bot.id), workspace_path);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        const remote = `${bot.pcUser}@127.0.0.1:${pc_path}`;
        const r = await vm.run('scp', direction === 'from_pc' ? [...vm.scpArgs(), remote, local] : [...vm.scpArgs(), local, remote], { timeout: 300000 });
        return r.code === 0 ? txt('copied') : errOut(r.stderr || 'copy failed');
      })),

    tool('show_artifact', 'Show rich content to the user in a panel next to the chat. type: html (self-contained page/app/dashboard/chart) | sheet (CSV text → spreadsheet grid) | markdown (document) | svg | mermaid. Pass id to update an existing artifact.',
      { title: z.string(), type: z.enum(['html', 'sheet', 'markdown', 'svg', 'mermaid']), content: z.string(), id: z.string().optional() },
      safe(async ({ title, type, content, id }) => {
        const aid = (id && /^[\w-]+$/.test(id)) ? id : uid(10);
        const dir = path.join(botDir(bot.id), 'artifacts');
        fs.writeFileSync(path.join(dir, aid + '.json'), JSON.stringify({ id: aid, title, type, updated: Date.now() }));
        fs.writeFileSync(path.join(dir, aid + '.content'), content);
        pushBlock(turn, { type: 'artifact', id: aid, title, kind: type, v: Date.now() });
        return txt(`Artifact shown to the user (id ${aid}).`);
      })),

    tool('dashboard_widget', 'Create or update a widget on the user\'s dashboard (the full-screen home screen of the app). Without id: creates a widget (html required). With id: changes only the fields you pass — pass just "data" to refresh the numbers without resending the html. html is a self-contained fragment or page (HTML/CSS/JS, CDN scripts allowed) that runs in a sandboxed iframe inside a card; the card already shows the title. size: small (1x1 tile, about 300x190 px) | wide (2x1) | tall (1x2) | large (2x2) | full (whole row, 2 rows high). data: any JSON, available to the widget script as window.DATA. refresh_minutes (min 5, 0 = off) with refresh_prompt makes you re-fetch the data on a schedule.',
      { id: z.string().optional(), title: z.string().optional(), html: z.string().optional(), size: z.enum(dash.SIZES).optional(), data: z.any().optional(), refresh_minutes: z.number().optional(), refresh_prompt: z.string().optional() },
      safe(async (a) => {
        const w = await dash.upsertWidget(bot, a);
        if (!turn.hidden && a.html != null) pushBlock(turn, { type: 'dash', title: w.title, widgetId: w.id });
        return txt(`Widget "${w.title}" is on the dashboard (id ${w.id}, size ${w.size}${w.refresh ? `, refreshed every ${w.refresh.minutes} min` : ''}).`);
      })),

    tool('dashboard_suggest', 'Put a suggestion card on the user\'s dashboard: something you noticed and what you could do about it. title: what happened, in one short line. text: the detail in one or two sentences. actions: up to 3 next steps, each {label: short button text, prompt: the full instruction you will receive as a chat message if the user taps it}. Pass id to replace an existing suggestion.',
      { title: z.string(), text: z.string().optional(), actions: z.array(z.object({ label: z.string(), prompt: z.string() })).optional(), priority: z.enum(['normal', 'high']).optional(), id: z.string().optional() },
      safe(async (a) => { const s = dash.suggest(bot, a); return txt(`Suggestion is on the dashboard (id ${s.id}).`); })),

    tool('dashboard', 'Inspect or clean up the dashboard. op: list (all widgets and suggestions with their ids) | get_widget (the html and data of one widget, to edit it) | remove_widget | remove_suggestion.',
      { op: z.enum(['list', 'get_widget', 'remove_widget', 'remove_suggestion']), id: z.string().optional() },
      safe(async ({ op, id }) => {
        if (op === 'list') return txt(JSON.stringify(dash.describe(), null, 1));
        if (!id) return errOut('id is required');
        if (op === 'get_widget') { if (!dash.getWidget(id)) return errOut('no such widget'); const src = dash.widgetSource(id); return txt(`DATA:\n${src.data.slice(0, 20000)}\n\nHTML:\n${src.html}`); }
        const ok = op === 'remove_widget' ? await dash.removeWidget(id) : dash.removeSuggestion(id);
        return ok ? txt('removed') : errOut('not found');
      })),

    tool('send_file', 'Send a file from your workspace to the user as a downloadable attachment in the chat.',
      { path: z.string(), caption: z.string().optional() },
      safe(async ({ path: p, caption }) => {
        const full = inside(botDir(bot.id), p);
        const st = fs.statSync(full);
        pushBlock(turn, { type: 'file', name: path.basename(full), path: path.relative(botDir(bot.id), full), size: st.size, caption });
        return txt('File sent.');
      })),

    tool('notify', 'Push a notification to the user\'s phone and desktop apps. Use only for things worth interrupting the user.',
      { title: z.string(), body: z.string(), priority: z.enum(['normal', 'high']).optional() },
      safe(async ({ title, body, priority }) => {
        notify({ botId: bot.id, botName: bot.name, title, body, priority: priority || 'normal' });
        pushBlock(turn, { type: 'notice', title, body, priority: priority || 'normal' });
        turn.notified = true;
        return txt('Notification sent.');
      })),

    tool('remember', 'Save a durable fact to the Brain. scope "user" = a preference/fact about the user (User/Preferences.md, shared by all bots), "bot" = your own working memory. For richer knowledge write a proper note in the Brain vault with Write/Edit instead.',
      { text: z.string(), scope: z.enum(['user', 'bot', 'shared']).optional() },
      safe(async ({ text, scope }) => {
        const f = scope === 'user' || scope === 'shared' ? path.join(BRAIN, 'User/Preferences.md') : memFile(bot);
        fs.appendFileSync(f, `- ${text.trim()} _(${bot.name}, ${new Date().toLocaleDateString('sv-SE')})_\n`);
        emit('brain', {});
        return txt('Saved.');
      })),

    tool('save_skill', 'Save or update a reusable skill in the shared Brain (a how-to procedure in Markdown: when to use, prerequisites, exact numbered steps, inputs that vary, pitfalls, how to verify, when to stop and ask). All bots can use it.',
      { name: z.string(), description: z.string(), content: z.string() },
      safe(async ({ name, description, content }) => {
        const slug = name.replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'skill';
        const f = path.join(SKILLS_DIR, slug + '.md');
        const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        const uses = Number((prev.match(/^uses:\s*(\d+)/m) || [])[1] || 0);
        fs.writeFileSync(f, `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, ' ')}\norigin: ${(prev.match(/^origin:\s*(.+)$/m) || [])[1] || bot.name}\nupdated: ${new Date().toISOString().slice(0, 10)}\nuses: ${uses}\ntags: [skill]\n---\n\n${content}\n`);
        emit('skills', { botId: bot.id }); emit('brain', {});
        return txt(`Skill "${slug}" saved at ${f}.`);
      })),

    tool('routine', 'Manage your routines (recurring/automatic work). op: list | create | delete | enable | disable. For create give name, prompt (what to do each run) and trigger: "interval" (every N minutes), "daily" (time "HH:MM" in the user\'s time zone, optional days 0=Sun..6=Sat), or "email" (check for new mail every N minutes).',
      { op: z.enum(['list', 'create', 'delete', 'enable', 'disable']), id: z.string().optional(), name: z.string().optional(), prompt: z.string().optional(), trigger: z.enum(['interval', 'daily', 'email', 'webhook']).optional(), minutes: z.number().optional(), time: z.string().optional(), days: z.array(z.number()).optional() },
      safe(async (a) => {
        const R = await import('./routines.mjs');
        if (a.op === 'list') return txt(JSON.stringify(state.routines.filter((r) => r.botId === bot.id), null, 1));
        if (a.op === 'create') {
          if (!bot.proactive && a.trigger !== 'daily' && a.trigger !== 'interval') return errOut('This bot is not set as proactive. Ask the user to enable "proactive" in the bot settings.');
          const r = R.createRoutine({ botId: bot.id, name: a.name || 'Routine', prompt: a.prompt || '', trigger: { type: a.trigger || 'interval', minutes: a.minutes, time: a.time, days: a.days } });
          return txt('Created routine ' + r.id);
        }
        const r = state.routines.find((x) => x.id === a.id && x.botId === bot.id);
        if (!r) return errOut('routine not found');
        if (a.op === 'delete') R.deleteRoutine(r.id); else { r.enabled = a.op === 'enable'; save(); emit('routines'); }
        return txt('ok');
      })),

    tool('message_bot', 'Send a message to another bot on the team and get its reply (consult or delegate).',
      { bot_name: z.string(), message: z.string() },
      safe(async ({ bot_name, message }) => {
        if ((turn.ctx.depth || 0) >= 2) return errOut('delegation depth limit reached');
        const target = state.bots.find((b) => b.id !== bot.id && b.name.toLowerCase() === bot_name.toLowerCase()) || state.bots.find((b) => b.id !== bot.id && b.name.toLowerCase().includes(bot_name.toLowerCase()));
        if (!target) return errOut('no such bot');
        const res = await sendMessage(target, message, { source: 'bot', fromBot: bot.name, depth: (turn.ctx.depth || 0) + 1 });
        return txt(res.text || '(no reply)');
      })),

    tool('request_takeover', 'Hand your desktop to the user for a step only they can do (login, 2FA, CAPTCHA, payment). Blocks until the user hands control back.',
      { reason: z.string() },
      safe(async ({ reason }) => {
        await vm.ensureDesktop(bot);
        turn.reveal?.();
        vm.setTakeover(bot.id, true);
        pushBlock(turn, { type: 'takeover', reason, status: 'pending' });
        setStatus(turn, 'waiting');
        notify({ botId: bot.id, botName: bot.name, title: `${bot.name} צריך אותך במחשב`, body: reason, priority: 'high' });
        await vm.waitTakeoverEnd(bot.id);
        turn.msg.blocks.filter((b) => b.type === 'takeover' && b.status === 'pending').forEach((b) => (b.status = 'done'));
        updateMessage(bot.id, turn.msg);
        setStatus(turn, 'working');
        return { content: [{ type: 'text', text: 'The user handed the desktop back.' }, await shot()] };
      })),

    tool('ask_approval', 'Ask the user to approve an action before you take it (required by the approval rules, or whenever an action is risky or irreversible). Returns whether it was approved.',
      { title: z.string(), detail: z.string().optional() },
      safe(async ({ title, detail }) => ((await askUser(turn, { title, detail: detail || '' })) === 'allow' ? txt('approved') : errOut('The user did not approve this.')))),

    tool('vault_list', "List the user's vault: saved logins (site, username — never the password) and contact details.", {},
      safe(async () => txt(JSON.stringify(vault.forBot(), null, 1)))),

    tool('vault_fill', 'Type a saved login field into the currently focused field on your desktop. field: "username" or "password". The password is typed directly; you never see it. Click the target field first.',
      { id: z.string(), field: z.enum(['username', 'password']) },
      safe(async ({ id, field }) => {
        const it = vault.get(id); if (!it || it.kind !== 'login') return errOut('no such login in the vault');
        if (!(await gate(turn, bot.perms.vault || 'ask', { title: `שימוש בכספת: ${it.site}`, detail: `${field === 'password' ? 'הקלדת הסיסמה' : 'הקלדת שם המשתמש'} של ${it.username || ''} (${it.site})`, toolKey: 'vault:' + id }))) return errOut('The user did not allow using this login.');
        const value = field === 'password' ? vault.reveal(id) : it.username;
        if (!value) return errOut('that field is empty in the vault');
        await vm.ensureDesktop(bot);
        await vm.typeSecret(bot.id, value);
        return txt(field + ' typed into the focused field');
      })),

    tool('secure_input', 'Ask the user for a secret (password, API key, 2FA code). It is typed directly into the currently focused field on your desktop; you never see the value. Click the target field first.',
      { label: z.string() },
      safe(async ({ label }) => {
        await vm.ensureDesktop(bot);
        turn.reveal?.();
        const block = pushBlock(turn, { type: 'secret', id: uid(10), label, status: 'pending' });
        setStatus(turn, 'waiting');
        notify({ botId: bot.id, botName: bot.name, title: `${bot.name} מבקש קלט מאובטח`, body: label, priority: 'high' });
        const value = await new Promise((res) => { secrets.set(block.id, res); turn.abort.signal.addEventListener('abort', () => res(null)); setTimeout(() => res(null), 15 * 60000); });
        secrets.delete(block.id);
        setStatus(turn, 'working');
        if (value == null) { block.status = 'cancelled'; updateMessage(bot.id, turn.msg); return errOut('The user did not provide the value.'); }
        await vm.typeSecret(bot.id, value);
        block.status = 'done'; updateMessage(bot.id, turn.msg);
        return { content: [{ type: 'text', text: 'The secret was typed into the focused field.' }, await shot()] };
      })),

    tool('list_devices', 'List the user\'s devices that run the WitBox app (id, name, platform, online).', {},
      safe(async () => txt(JSON.stringify(listDevices().map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: d.online })), null, 1)))),

    tool('device_control', 'Control one of the user\'s own devices through the WitBox app (the device itself approves or denies). action.type: screenshot | click {x,y,button,double} | move | drag {x1,y1,x2,y2} | scroll {x,y,dx,dy} | type {text} | key {keys}; Android also: tap, swipe {x1,y1,x2,y2,ms}, global {name: back|home|recents|notifications}, open_app {package}. Coordinates are pixels of the last screenshot.',
      { device: z.string().describe('device id or name'), action: z.object({ type: z.string() }).passthrough() },
      safe(async ({ device, action }) => {
        if (bot.perms.devices === 'never') return errOut('This bot is not allowed to control user devices (bot setting).');
        const d = listDevices().find((x) => x.id === device) || listDevices().find((x) => (x.name || '').toLowerCase().includes(device.toLowerCase()));
        if (!d) return errOut('device not found');
        setStatus(turn, 'device');
        const r = await deviceRequest(d.id, bot, action);
        if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: 'image/jpeg' }, { type: 'text', text: `screenshot ${r.width}x${r.height}` }] };
        return txt(JSON.stringify(r));
      })),
  ];
}

// ---------------------------------------------------------------- model routing
const tierOf = (id) => MODELS.find((m) => m.id === id)?.tier ?? 0;
export function resolveLocal(modelId) {
  if (!modelId?.startsWith('local:')) return null;
  return state.settings.localModels.find((l) => 'local:' + l.id === modelId) || null;
}
function providerEnv(modelId) {
  const lm = resolveLocal(modelId);
  if (!lm) return { model: modelId, env: {}, provider: 'claude' };
  return { model: lm.model, provider: 'local:' + lm.id, env: { ANTHROPIC_BASE_URL: lm.baseUrl.replace(/\/+$/, ''), ANTHROPIC_AUTH_TOKEN: lm.apiKey || 'local', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' } };
}

async function quickClassify(text, model) {
  const { model: m, env } = providerEnv(model);
  let out = '';
  const q = query({
    prompt: `Classify this request for an AI agent.\n<request>\n${text.slice(0, 3000)}\n</request>\nReturn ONLY JSON: {"complexity":1-4,"effort":"low"|"medium"|"high"}\ncomplexity: 1 = chit-chat, simple question, lookup, triage/classification; 2 = routine multi-step task, using tools/apps, summaries, drafting; 3 = hard reasoning, long multi-app workflows, coding, analysis, planning; 4 = exceptionally hard, long-horizon, research-grade.\neffort = how much thinking is needed.`,
    options: { model: m, env: { ...process.env, ...env }, systemPrompt: 'You are a strict JSON classifier.', maxTurns: 1, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, cwd: DATA, effort: 'low' },
  });
  for await (const msg of q) if (msg.type === 'result') out = msg.result || '';
  const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  return { complexity: Math.max(1, Math.min(4, Number(j.complexity) || 2)), effort: ['low', 'medium', 'high'].includes(j.effort) ? j.effort : 'medium' };
}

export async function chooseModel(bot, text, ctx = {}) {
  let model = bot.model, effort = bot.effort, why = 'manual';
  const needAutoModel = bot.modelMode === 'auto', needAutoEffort = bot.effortMode === 'auto';
  if (ctx.voice && !needAutoModel) return { model, effort: 'low', why: 'voice' };
  if (!needAutoModel && !needAutoEffort) return { model, effort, why };
  const allowed = (state.settings.autoModels || []).filter((id) => MODELS.some((m) => m.id === id) || resolveLocal(id));
  const claudeAllowed = allowed.filter((id) => !id.startsWith('local:')).sort((a, b) => tierOf(a) - tierOf(b));
  const pool = claudeAllowed.length ? claudeAllowed : allowed;
  if (!pool.length) return { model: bot.model, effort: needAutoEffort ? 'medium' : effort, why: 'no auto models configured' };
  if (ctx.voice) return { model: needAutoModel ? pool[0] : model, effort: 'low', why: 'voice · fastest' }; // speed matters most in a spoken conversation
  let cls = { complexity: 2, effort: 'medium' };
  const t = text.trim();
  if (t.length < 25 && !/[?？]/.test(t) && ctx.source !== 'routine') cls = { complexity: 1, effort: 'low' };
  else { try { cls = await quickClassify(t, pool[0]); } catch (e) { console.error('classify failed', e.message); } }
  if (needAutoModel) {
    model = pool.find((id) => tierOf(id) >= cls.complexity) || pool[pool.length - 1];
    why = `auto · complexity ${cls.complexity}`;
  }
  if (needAutoEffort) effort = cls.effort;
  return { model, effort, why };
}

// ---------------------------------------------------------------- turn engine
function setStatus(turn, status) {
  if (turn.status === status) return;
  turn.status = status;
  const r = running.get(turn.bot.id); if (r) r.status = status;
  emit('status', { botId: turn.bot.id, status });
}

export function sendMessage(bot, text, ctx = {}) {
  const prev = chains.get(bot.id) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => runTurn(bot, text, ctx));
  chains.set(bot.id, p.catch(() => {}));
  return p;
}

export function stopBot(botId) {
  const r = running.get(botId); if (!r) return;
  r.interrupted = true;
  // a warm voice session is only interrupted (the process stays up for the next sentence); everything else is aborted
  if (warm.get(botId)?.q === r.q) { try { r.q.interrupt(); } catch {} return; }
  r.abort.abort(); try { r.q?.interrupt?.(); } catch {}
}

const sessionFresh = (bot, provider) => !bot.sessionId || bot.sessionProvider !== provider || (bot.ctxTokens || 0) > 90000 || Date.now() - (bot.lastTurnTs || 0) > 8 * 3600e3;

function buildOpts(bot, turn, ctx, prov, effort, abort, isolated) {
  const server = createSdkMcpServer({ name: 'bot', version: '1.0.0', tools: botTools(turn) });
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'];
  if ((bot.perms.hostShell || 'never') !== 'never') tools.push('Bash');
  return {
    model: prov.model, effort, cwd: botDir(bot.id), additionalDirectories: [SHARED_DIR],
    env: { ...process.env, ...prov.env, MCP_TOOL_TIMEOUT: '1800000', ENABLE_TOOL_SEARCH: 'false' },
    systemPrompt: { type: 'custom', prompt: systemPrompt(bot, ctx), snapshot: false },
    tools, mcpServers: { bot: server }, settingSources: [], permissionMode: 'default', canUseTool: canUseToolFor(turn),
    includePartialMessages: true, abortController: abort, maxTurns: 200, persistSession: !isolated,
    ...(prov.provider !== 'claude' ? { strictMcpConfig: true } : {}),
  };
}

// Claude connectors (Gmail, Drive…) attach asynchronously — wait for them so their tools exist on the first step.
async function waitConnectors(q, target, prov, abort, voice) {
  if (prov.provider !== 'claude') return;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !abort.signal.aborted) {
    try {
      const st = await q.mcpServerStatus();
      target.readOnly = new Set(st.flatMap((sv) => (sv.tools || []).filter((t) => t.annotations?.readOnly).map((t) => `mcp__${sv.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${t.name}`)));
      target.connectors = st.filter((sv) => sv.name !== 'bot').map((sv) => ({ name: sv.name, status: sv.status }));
      const cloud = st.filter((sv) => sv.name !== 'bot');
      if (!st.some((sv) => sv.status === 'pending') && (cloud.length || Date.now() - t0 > 5000)) break;
      if (voice && Date.now() - t0 > 4000) break;
    } catch { break; }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---- warm voice sessions: one live Claude process per bot while a spoken conversation is open ----
const warm = new Map();
export function closeWarm(botId) {
  const w = warm.get(botId); if (!w) return;
  warm.delete(botId); clearTimeout(w.timer); w.dead = true; w.end();
  setTimeout(() => { try { w.abort.abort(); } catch {} }, 5000);
}
export async function openWarm(bot) {
  const choice = await chooseModel(bot, '', { voice: true }); const prov = providerEnv(choice.model);
  let w = warm.get(bot.id);
  if (w && !w.dead && !w.abort.signal.aborted && w.prov.model === prov.model) { clearTimeout(w.timer); w.timer = setTimeout(() => closeWarm(bot.id), 150000); return w; }
  closeWarm(bot.id);
  const ctx = { source: 'chat', voice: true };
  const holder = { turn: { bot, ctx, msg: { blocks: [] } } };
  const T = new Proxy({}, { get: (_, k) => holder.turn[k], set: (_, k, v) => { holder.turn[k] = v; return true; } });
  const abort = new AbortController();
  const queue = []; let wake = null, ended = false;
  const gen = (async function* () { for (;;) { while (!queue.length && !ended) await new Promise((r) => (wake = r)); if (!queue.length) return; yield { type: 'user', message: { role: 'user', content: queue.shift() }, parent_tool_use_id: null, session_id: '' }; } })();
  const fresh = sessionFresh(bot, prov.provider);
  const q = query({ prompt: gen, options: { ...buildOpts(bot, T, ctx, prov, 'low', abort, false), ...(fresh ? {} : { resume: bot.sessionId }) } });
  w = { q, iter: q[Symbol.asyncIterator](), holder, abort, choice, prov, fresh, used: false, dead: false, push: (p) => { queue.push(p); wake?.(); }, end: () => { ended = true; wake?.(); } };
  w.ready = waitConnectors(q, w, prov, abort, true).catch(() => {});
  w.timer = setTimeout(() => closeWarm(bot.id), 150000);
  warm.set(bot.id, w);
  return w;
}

async function runTurn(bot, text, ctx) {
  if (!getBot(bot.id)) return { text: '' };
  const source = ctx.source || 'chat';
  let userMsg = null;
  if (source === 'chat') userMsg = addMessage(bot.id, { role: 'user', blocks: [{ type: 'text', text }, ...(ctx.attachments || []).map((a) => ({ type: 'file', name: a.name, path: a.path, size: a.size, mine: true }))] });
  else if (source === 'bot') addMessage(bot.id, { role: 'user', from: ctx.fromBot, blocks: [{ type: 'text', text }] });
  else if (source === 'routine' && !ctx.silent) { /* routine prompt is not shown; result is */ }

  const abort = new AbortController();
  const msg = { id: uid(12), ts: Date.now(), role: 'assistant', status: 'streaming', blocks: [], meta: { source, routine: ctx.routineName, voice: !!ctx.voice } };
  const turn = { bot, msg, abort, ctx, status: 'thinking' };
  running.set(bot.id, { abort, msg, status: 'thinking' });
  turn.hidden = source === 'routine'; // only shown at the end, if not NOOP (or as soon as it needs the user)
  turn.reveal = () => { if (turn.hidden) { turn.hidden = false; turn.revealed = true; messages(bot.id).push(msg); updateMessage(bot.id, msg); } };
  if (!turn.hidden) { messages(bot.id).push(msg); updateMessage(bot.id, msg); }
  emit('status', { botId: bot.id, status: 'thinking' });

  let prompt = text + (ctx.promptExtra || '');
  if (ctx.attachments?.length) prompt += '\n\n[The user attached files, saved in your workspace: ' + ctx.attachments.map((a) => a.path).join(', ') + ' — use the Read tool to view them (images are viewable).]';

  let finalText = '', lastEmit = 0, streamBlock = null, pendingEmit = null;
  const flush = () => { pendingEmit = null; lastEmit = Date.now(); if (!turn.hidden) updateMessage(bot.id, msg); };
  const soon = () => { if (Date.now() - lastEmit > 70) flush(); else pendingEmit ||= setTimeout(flush, 80); };

  try {
    let warmS = null;
    if (ctx.voice) { try { warmS = await openWarm(bot); } catch (e) { console.error('voice session failed, using a normal turn', e.message); } }
    else { if (warm.has(bot.id)) { closeWarm(bot.id); await new Promise((r) => setTimeout(r, 400)); } }
    const choice = warmS ? warmS.choice : ctx.model ? { model: ctx.model, effort: ctx.effort || 'low', why: 'routine' } : await chooseModel(bot, text, ctx);
    const prov = providerEnv(choice.model);
    msg.meta.model = choice.model; msg.meta.effort = choice.effort; msg.meta.why = choice.why;
    const isolated = source === 'routine';
    // Keep sessions lean (quota): continue the same Claude session only while it is recent and small; otherwise
    // start a fresh one with a short recap — long-term continuity comes from the Brain, not from a huge context.
    const fresh = warmS ? warmS.fresh && !warmS.used : sessionFresh(bot, prov.provider);
    const resume = !isolated && !fresh ? bot.sessionId : undefined;
    if (!isolated && fresh) {
      const prior = messages(bot.id).filter((m) => m.id !== msg.id && m.id !== userMsg?.id).slice(-10).map((m) => { const t = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim(); return t ? `${m.role === 'user' ? (m.from || 'User') : bot.name}: ${t.slice(0, 500)}` : ''; }).filter(Boolean).join('\n');
      if (prior) prompt = `[Recap of the latest messages in this chat, for continuity — older context lives in the Brain:\n${prior.slice(-3500)}\n]\n\n` + prompt;
      bot.ctxTokens = 0;
    }
    if (!isolated) bot.lastTurnTs = Date.now();
    const baseOpts = buildOpts(bot, turn, ctx, prov, choice.effort, abort, isolated);
    const onMsg = (m) => {
        if (m.type === 'system' && m.subtype === 'init') { if (!isolated) { bot.sessionId = m.session_id; bot.sessionProvider = prov.provider; save(); } }
        else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
          const e = m.event;
          if (e.type === 'content_block_start' && e.content_block?.type === 'text') { streamBlock = { type: 'text', text: '' }; msg.blocks.push(streamBlock); }
          else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && streamBlock) { streamBlock.text += e.delta.text; setStatus(turn, 'writing'); soon(); }
          else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') setStatus(turn, 'thinking');
        } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
          { const u = m.message.usage; if (u && !isolated) bot.ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
          for (const c of m.message.content || []) {
            if (c.type === 'text') {
              if (streamBlock) { streamBlock.text = c.text; streamBlock = null; } else if (c.text.trim()) msg.blocks.push({ type: 'text', text: c.text });
              finalText = c.text;
            } else if (c.type === 'tool_use') {
              const inp = { ...c.input }; if (typeof inp.content === 'string' && inp.content.length > 600) inp.content = inp.content.slice(0, 600) + '…';
              msg.blocks.push({ type: 'tool', id: c.id, name: c.name, input: inp, status: 'running' });
              setStatus(turn, c.name.includes('computer') ? 'computer' : 'working');
            }
          }
          soon();
        } else if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
          for (const c of m.message.content) {
            if (c.type !== 'tool_result') continue;
            const b = msg.blocks.find((x) => x.type === 'tool' && x.id === c.tool_use_id);
            if (!b) continue;
            b.status = c.is_error ? 'error' : 'done';
            const t = Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : String(c.content || '');
            b.result = t.slice(0, 700);
            if (Array.isArray(c.content) && c.content.some((x) => x.type === 'image')) b.hasImage = true;
          }
          soon();
        }
    };
    const exec = async (opts) => {
      let ready; const gate = new Promise((r) => (ready = r));
      const q = query({ prompt: (async function* () { await gate; yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }; })(), options: opts });
      running.get(bot.id).q = q;
      waitConnectors(q, turn, prov, abort, false).then(ready);
      let result = null;
      for await (const m of q) { if (m.type === 'result') result = m; else onMsg(m); }
      return result;
    };
    let result;
    if (warmS) {
      // live voice conversation: one warm Claude process stays up between turns, so replies start in about a second
      clearTimeout(warmS.timer); warmS.holder.turn = turn; warmS.used = true;
      running.get(bot.id).q = warmS.q; running.get(bot.id).abort = warmS.abort;
      await warmS.ready; turn.readOnly = warmS.readOnly; turn.connectors = warmS.connectors;
      warmS.push(prompt);
      for (;;) { const { value: m, done } = await warmS.iter.next(); if (done) { warmS.dead = true; break; } if (m.type === 'result') { result = m; break; } onMsg(m); }
      if (warmS.dead || warmS.abort.signal.aborted) closeWarm(bot.id); else warmS.timer = setTimeout(() => closeWarm(bot.id), 150000);
      if (!result && !warmS.abort.signal.aborted) throw new Error('voice session ended unexpectedly');
    } else {
        try { result = await exec({ ...baseOpts, ...(resume ? { resume } : {}) }); }
      catch (e) {
        if (resume && !abort.signal.aborted && msg.blocks.length === 0) { bot.sessionId = null; save(); result = await exec(baseOpts); } else throw e;
      }
    }
    if (result && running.get(bot.id)?.interrupted) { msg.status = 'stopped'; result = null; }
    if (result) {
      msg.meta.cost = result.total_cost_usd; msg.meta.ms = result.duration_ms; msg.meta.turns = result.num_turns;
      if (result.subtype !== 'success') { msg.status = 'error'; msg.error = result.subtype === 'error_max_turns' ? 'הגעתי למגבלת הצעדים' : (result.errors || []).join('; ') || result.subtype; }
      else if (result.is_error) { msg.status = 'error'; msg.error = String(result.result || 'error').slice(0, 500); }
      if (!finalText && typeof result.result === 'string') finalText = result.result;
    }
    if (msg.status !== 'error' && msg.status !== 'stopped') msg.status = 'done';
  } catch (e) {
    if (ctx.voice) closeWarm(bot.id);
    if (abort.signal.aborted || running.get(bot.id)?.abort?.signal.aborted) { msg.status = 'stopped'; }
    else { msg.status = 'error'; msg.error = String(e.message || e).slice(0, 600); console.error('turn error', bot.name, e); }
  } finally {
    if (pendingEmit) clearTimeout(pendingEmit);
    msg.blocks.forEach((b) => { if (b.type === 'tool' && b.status === 'running') b.status = msg.status === 'done' ? 'done' : 'stopped'; if ((b.type === 'approval' || b.type === 'secret') && b.status === 'pending') b.status = 'cancelled'; });
    running.delete(bot.id);
    const allText = msg.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const noop = turn.hidden && msg.status === 'done' && !turn.notified && (!allText || /^NOOP\.?$/i.test(allText));
    if (turn.hidden && !noop) messages(bot.id).push(msg);
    if (!noop) {
      updateMessage(bot.id, msg, { persist: true });
      bot.lastActivity = Date.now();
      if (source !== 'chat') bot.unread = (bot.unread || 0) + 1;
      save(); emit('bots');
    }
    emit('status', { botId: bot.id, status: null });
    import('./learn.mjs').then((L) => L.afterTurn(bot, msg, text, source)).catch(() => {});
  }
  return { text: finalText, message: msg };
}

// One-off helper used by "create bot from description" and teach-a-task drafting.
export async function oneShot(prompt, { model = 'claude-sonnet-5-5', cwd = DATA, tools = [], effort = 'low' } = {}) {
  const allowed = state.settings.autoModels.filter((id) => !id.startsWith('local:'));
  if (allowed.length && !allowed.includes(model)) model = allowed.sort((a, b) => tierOf(a) - tierOf(b)).find((id) => tierOf(id) >= 2) || allowed[allowed.length - 1];
  let out = '';
  const q = query({ prompt, options: { model, cwd, tools, maxTurns: tools.length ? 40 : 1, settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, effort, systemPrompt: 'You are a precise assistant inside the WitBox server. Follow the output format exactly.', permissionMode: 'default', canUseTool: async (name, input) => (['Read', 'Glob'].includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'not allowed' }) } });
  for await (const m of q) if (m.type === 'result') out = m.result || '';
  return out;
}

// Status of the user's Claude connectors as seen by the bots (cached).
let connCache = { t: 0, v: null };
export async function connectorStatus(force = false) {
  if (!force && connCache.v && Date.now() - connCache.t < 5 * 60000) return connCache.v;
  const ac = new AbortController(); let release; const hold = new Promise((r) => (release = r));
  const q = query({ prompt: (async function* () { await hold; })(), options: { model: 'claude-haiku-5-5', cwd: DATA, settingSources: [], persistSession: false, tools: [], systemPrompt: 'x', abortController: ac, env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' } } });
  let st = [];
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { st = await q.mcpServerStatus(); if (st.length && !st.some((s) => s.status === 'pending')) break; await new Promise((r) => setTimeout(r, 500)); }
  } catch (e) { console.error('connectorStatus', e.message); }
  release(); try { ac.abort(); } catch {}
  (async () => { try { for await (const _ of q) {} } catch {} })();
  const v = st.map((s) => ({ name: s.name.replace(/^claude\.ai /, ''), status: s.status, tools: (s.tools || []).length, error: s.error }));
  connCache = { t: Date.now(), v };
  return v;
}
