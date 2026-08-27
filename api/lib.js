const PROJECT = process.env.FIREBASE_PROJECT || "bot-pte-room";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = String(process.env.ADMIN_IDS || "600029017")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ANSWER_SECONDS = Number(process.env.ANSWER_SECONDS || 100);
const QUESTIONS_URL = process.env.QUESTIONS_URL || "";
const AUDIO_BASE = (process.env.AUDIO_BASE || "").replace(/\/$/, "");

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function quizDocPath(chatId) {
  return `${FS}/group_quizzes/${encodeURIComponent(String(chatId))}`;
}

async function tg(method, payload) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram error", method, data);
  }
  return data;
}

async function getQuiz(chatId) {
  const res = await fetch(quizDocPath(chatId));
  if (res.status === 404) return null;
  const data = await res.json();
  const raw = data.fields?.payload?.stringValue;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveQuiz(chatId, state) {
  const body = JSON.stringify({
    fields: {
      payload: { stringValue: JSON.stringify(state) },
      updatedAt: { integerValue: String(Date.now()) },
    },
  });
  await fetch(quizDocPath(chatId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function wordsOf(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:"']/g, ""))
    .filter(Boolean);
}

function scoreWfd(userText, official) {
  const orig = wordsOf(official);
  const pool = wordsOf(userText).map((w) => w.toLowerCase());
  let score = 0;
  const missing = [];
  orig.forEach((token) => {
    const i = pool.indexOf(token.toLowerCase());
    if (i !== -1) {
      score++;
      pool.splice(i, 1);
    } else {
      missing.push(token);
    }
  });
  return { score, total: orig.length, missing };
}

function pickRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

const FALLBACK_QUESTIONS = [
  {
    id: "demo1",
    text: "Climate change requires coordinated international action.",
    audioUrl: "",
  },
  {
    id: "demo2",
    text: "Students should review their notes after every lecture.",
    audioUrl: "",
  },
  {
    id: "demo3",
    text: "The research highlights the importance of clean energy.",
    audioUrl: "",
  },
  {
    id: "demo4",
    text: "Effective communication is essential in academic writing.",
    audioUrl: "",
  },
  {
    id: "demo5",
    text: "Public transport can reduce traffic in large cities.",
    audioUrl: "",
  },
];

async function loadQuestions(pool) {
  const want = String(pool || process.env.QUIZ_POOL || "prediction").toLowerCase();
  const usePred = want !== "all";
  if (!QUESTIONS_URL) return FALLBACK_QUESTIONS;
  try {
    const res = await fetch(QUESTIONS_URL, { cache: "no-store" });
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.questions || [];
    const filtered = usePred ? list.filter((q) => q.isPrediction === true) : list;
    const cleaned = filtered
      .map((q) => ({
        id: q.id,
        text: q.text || q.sentence || q.answer || "",
        audioUrl: q.audioUrl || q.audio || "",
        isPrediction: !!q.isPrediction,
      }))
      .filter((q) => q.text);
    return cleaned.length ? cleaned : FALLBACK_QUESTIONS;
  } catch (e) {
    console.error("loadQuestions", e);
    return FALLBACK_QUESTIONS;
  }
}

function isAllowedAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function isGroupAdmin(chatId, userId) {
  if (isAllowedAdmin(userId)) return true;
  const data = await tg("getChatMember", { chat_id: chatId, user_id: userId });
  const st = data.result?.status;
  return st === "creator" || st === "administrator";
}

async function sendQuestion(chatId, state) {
  const q = state.questions[state.qIndex];
  const n = state.qIndex + 1;
  const total = state.questions.length;
  const caption =
    `🎧 WFD Quiz  ${n}/${total}\n` +
    `به همین پیام ریپلای کنید و جمله را بنویسید.\n` +
    `⏱ ${ANSWER_SECONDS} ثانیه وقت دارید.\n` +
    `متن سوال ارسال نمی‌شود — فقط ویس.\n` +
    `#Q${q.id}`;

  let msg;
  const fileName = q.audioUrl || "";
  const audioUrl = fileName && AUDIO_BASE ? `${AUDIO_BASE}/${fileName}` : "";
  if (audioUrl) {
    msg = await tg("sendVoice", {
      chat_id: chatId,
      voice: audioUrl,
      caption,
    });
  }
  if (!msg?.ok) {
    msg = await tg("sendMessage", {
      chat_id: chatId,
      text:
        caption +
        "\n\n⚠️ ویس در دسترس نبود. گوش کنید اگر فایل بعداً وصل شد؛ فعلاً جواب را ریپلای کنید.",
    });
  }
  const messageId = msg.result?.message_id;
  state.currentMsgId = messageId;
  state.phase = "collecting";
  state.deadline = Date.now() + ANSWER_SECONDS * 1000;
  state.answers = {};
  await saveQuiz(chatId, state);
  return state;
}

function leaderboardText(state) {
  const rows = Object.values(state.scores || {});
  rows.sort((a, b) => b.points - a.points || b.correctQs - a.correctQs);
  if (!rows.length) return "شرکت‌کننده‌ای ثبت نشد.";
  const max = rows[0].max || 1;
  return rows
    .slice(0, 20)
    .map((r, i) => {
      const pct = Math.round((r.points / (r.max || 1)) * 100);
      return `${i + 1}. ${r.name} — ${r.points}/${r.max} (${pct}%) · سوال درست: ${r.correctQs}`;
    })
    .join("\n");
}

async function closeCurrentQuestion(chatId, state) {
  const q = state.questions[state.qIndex];
  if (!q) return state;

  const lines = [];
  const entries = Object.values(state.answers || {});
  let answered = 0;
  entries.forEach((a) => {
    answered++;
    const s = scoreWfd(a.text, q.text);
    if (!state.scores[a.id]) {
      state.scores[a.id] = { id: a.id, name: a.name, points: 0, max: 0, correctQs: 0 };
    }
    state.scores[a.id].points += s.score;
    state.scores[a.id].max += s.total;
    if (s.score === s.total && s.total > 0) state.scores[a.id].correctQs += 1;
    const pct = s.total ? Math.round((s.score / s.total) * 100) : 0;
    lines.push(`• ${a.name}: ${s.score}/${s.total} (${pct}%)`);
  });

  if (state.currentMsgId) {
    await tg("deleteMessage", { chat_id: chatId, message_id: state.currentMsgId });
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `✅ وقت سوال ${state.qIndex + 1} تمام شد.\n\n` +
      `📝 جواب صحیح:\n${q.text}\n\n` +
      `👥 ${answered} نفر جواب دادند.\n` +
      (lines.slice(0, 15).join("\n") || "—"),
  });

  state.qIndex += 1;
  state.currentMsgId = null;
  state.phase = "between";
  await saveQuiz(chatId, state);

  if (state.qIndex >= state.questions.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        `🏁 پایان مسابقه WFD (${state.questions.length} سوال)\n\n` +
        leaderboardText(state),
    });
    state.status = "idle";
    state.phase = "done";
    await saveQuiz(chatId, state);
    return state;
  }

  await sendQuestion(chatId, state);
  return state;
}

async function startQuiz(chatId, user, count, pool) {
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  const bank = await loadQuestions(pool);
  const picked = pickRandom(bank, n);
  const state = {
    status: "running",
    phase: "collecting",
    qIndex: 0,
    questions: picked,
    answers: {},
    scores: {},
    currentMsgId: null,
    deadline: 0,
    startedBy: user.id,
    startedName: user.first_name || "Admin",
  };
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `⚔️ مسابقه WFD شروع شد\n` +
      `بانک سوال: ${String(pool || process.env.QUIZ_POOL || "prediction")}\n` +
      `تعداد سوال: ${picked.length}\n` +
      `وقت هر سوال: ${ANSWER_SECONDS} ثانیه\n` +
      `جواب = ریپلای به ویس ربات`,
  });
  return sendQuestion(chatId, state);
}

module.exports = {
  BOT_TOKEN,
  ANSWER_SECONDS,
  tg,
  getQuiz,
  saveQuiz,
  isGroupAdmin,
  startQuiz,
  closeCurrentQuestion,
  scoreWfd,
  loadQuestions,
};
