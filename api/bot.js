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
  const msg = update.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chat = msg.chat;
  const chatId = chat.id;
  const user = msg.from;
  const text = (msg.text || msg.caption || "").trim();

  try {
    // Advance quiz if time is over (works even without cron, when anyone talks)
    const state = await getQuiz(chatId);
    if (state?.status === "running" && state.phase === "collecting" && Date.now() >= state.deadline) {
      await closeCurrentQuestion(chatId, state);
    }

    const isCmd = text.startsWith("/quiz_wfd") || text.startsWith("/quiz_pred") || text.startsWith("/quiz_stop") || text.startsWith("/quiz_status");
    if (isCmd) {
      const ok = await isGroupAdmin(chatId, user.id);
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

    // Collect answers: must reply to the current question message
    const live = await getQuiz(chatId);
    if (
      live?.status === "running" &&
      live.phase === "collecting" &&
      msg.reply_to_message &&
      live.currentMsgId &&
      msg.reply_to_message.message_id === live.currentMsgId &&
      Date.now() < live.deadline
    ) {
      const answerText = (msg.text || "").trim();
      if (answerText && !answerText.startsWith("/")) {
        live.answers[String(user.id)] = {
          id: String(user.id),
          name: user.first_name || user.username || "User",
          text: answerText,
          at: Date.now(),
        };
        await saveQuiz(chatId, live);
      }
    }
  } catch (err) {
    console.error(err);
  }

  return res.status(200).json({ ok: true });
};
