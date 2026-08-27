const { getQuiz, closeCurrentQuestion } = require("./lib");

// Call this on a schedule (every 1 min on Vercel Cron, or every 20s via cron-job.org)
// Body or query: chat_id (optional). If omitted, does nothing unless CHAT_IDS env is set.

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const given = req.headers["x-cron-secret"] || req.query?.secret || "";
  if (secret && given !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const ids = [];
  const q = req.query?.chat_id || req.body?.chat_id;
  if (q) ids.push(q);
  if (process.env.QUIZ_CHAT_IDS) {
    process.env.QUIZ_CHAT_IDS.split(",").forEach((s) => s.trim() && ids.push(s.trim()));
  }

  const results = [];
  for (const chatId of ids) {
    const state = await getQuiz(chatId);
    if (state?.status === "running" && state.phase === "collecting" && Date.now() >= state.deadline) {
      await closeCurrentQuestion(chatId, state);
      results.push({ chatId, action: "closed" });
    } else {
      results.push({ chatId, action: "wait", phase: state?.phase || "none" });
    }
  }

  return res.status(200).json({ ok: true, results });
};
