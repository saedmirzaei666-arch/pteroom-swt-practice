const {
  BOT_TOKEN,
  getQuiz,
  isGroupAdmin,
  startQuiz,
  closeCurrentQuestion,
  saveQuiz,
} = require("./lib");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, bot: "group-quiz" });
  }
  if (req.method !== "POST") {
    return res.status(405).end();
  }
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: "BOT_TOKEN missing" });
  }

  const update = req.body || {};
  const msg = update.message || update.channel_post;
  if (!msg) return res.status(200).json({ ok: true });

  const chat = msg.chat;
  const chatId = chat.id;
  const user = msg.from || { id: 0, first_name: "Admin" };
  const text = (msg.text || msg.caption || "").trim().split("@")[0].trim();

  try {
    // Advance quiz if time is over (works even without cron, when anyone talks)
    const state = await getQuiz(chatId);
    if (state?.status === "running" && state.phase === "collecting" && Date.now() >= state.deadline) {
      await closeCurrentQuestion(chatId, state);
    }

    const isCmd = text.startsWith("/quiz_wfd") || text.startsWith("/quiz_pred") || text.startsWith("/quiz_stop") || text.startsWith("/quiz_status");
    if (isCmd) {
      const ok = update.channel_post ? true : await isGroupAdmin(chatId, user.id);
      if (!ok) {
        await require("./lib").tg("sendMessage", {
          chat_id: chatId,
          text: "فقط ادمین می‌تواند مسابقه را شروع یا متوقف کند.",
          reply_to_message_id: msg.message_id,
        });
        return res.status(200).json({ ok: true });
      }
    }

    if (text.startsWith("/quiz_wfd") || text.startsWith("/quiz_pred")) {
      const parts = text.split(/\s+/);
      let pool = "prediction";
      let n = 5;
      if (text.startsWith("/quiz_pred")) {
        n = Number(parts[1] || 5);
        pool = "prediction";
      } else if (parts[1] === "all" || parts[1] === "pred" || parts[1] === "prediction") {
        pool = parts[1] === "all" ? "all" : "prediction";
        n = Number(parts[2] || 5);
      } else {
        n = Number(parts[1] || 5);
        pool = "prediction";
      }
      const current = await getQuiz(chatId);
      if (current?.status === "running") {
        await require("./lib").tg("sendMessage", {
          chat_id: chatId,
          text: "یک مسابقه فعال است. اول /quiz_stop بزنید.",
        });
        return res.status(200).json({ ok: true });
      }
      await startQuiz(chatId, user, n, pool);
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/quiz_stop")) {
      const current = await getQuiz(chatId);
      if (current) {
        current.status = "idle";
        current.phase = "stopped";
        await saveQuiz(chatId, current);
      }
      await require("./lib").tg("sendMessage", { chat_id: chatId, text: "مسابقه متوقف شد." });
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/quiz_status")) {
      const current = await getQuiz(chatId);
      if (!current || current.status !== "running") {
        await require("./lib").tg("sendMessage", { chat_id: chatId, text: "مسابقه فعالی نیست." });
        return res.status(200).json({ ok: true });
      }
      const left = Math.max(0, Math.round((current.deadline - Date.now()) / 1000));
      await require("./lib").tg("sendMessage", {
        chat_id: chatId,
        text: `سوال ${current.qIndex + 1}/${current.questions.length} · باقی‌مانده حدود ${left} ثانیه · جواب‌ها: ${Object.keys(current.answers || {}).length}`,
      });
      return res.status(200).json({ ok: true });
    }

    // Instant check when user replies to the question voice
    const answerText = (msg.text || "").trim();
    const reply = msg.reply_to_message;
    if (answerText && !answerText.startsWith("/") && reply) {
      const live = await getQuiz(chatId);
      const cap = reply.caption || reply.text || "";
      const idMatch = cap.match(/#Q([^\s]+)/);
      let official = live?.questions?.[live.qIndex]?.text || "";
      if (!official && idMatch) {
        const bank = await require("./lib").loadQuestions("all").catch(() => []);
        const found = (bank || []).find((q) => String(q.id) === String(idMatch[1]));
        if (found) official = found.text;
      }
      const isThisQuestion =
        (live?.currentMsgId && reply.message_id === live.currentMsgId) ||
        /WFD Quiz/.test(cap);

      if (isThisQuestion && official) {
        const s = require("./lib").scoreWfd(answerText, official);
        const missed = (s.missing || []).join(" ");
        await require("./lib").tg("sendMessage", {
          chat_id: chatId,
          reply_to_message_id: msg.message_id,
          text:
            `${s.score}/${s.total} کلمه صحیح ✅\n` +
            (missed ? `کلمات اشتباه یا از دست رفته: ❌ ${missed}` : `همه کلمات درست ✅`),
        });
        if (live?.status === "running" && live.phase === "collecting") {
          live.answers[String(user.id)] = {
            id: String(user.id),
            name: user.first_name || user.username || "User",
            text: answerText,
            at: Date.now(),
            score: s.score,
            total: s.total,
          };
          await saveQuiz(chatId, live);
          if (Date.now() >= live.deadline) {
            await closeCurrentQuestion(chatId, live);
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
  }

  return res.status(200).json({ ok: true });
};
