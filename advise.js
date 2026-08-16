// netlify/functions/advise.js
//
// Runs on Netlify's servers, never in the browser, so your API key stays hidden.
//
// Works with EITHER provider. Set one of these in Netlify under
// Site configuration -> Environment variables, then redeploy:
//
//   GEMINI_API_KEY     = ...        (Google, has a free tier — start here)
//   ANTHROPIC_API_KEY  = sk-ant-... (Claude, paid only)
//
// If both are set, Gemini is used. Optional:
//   GEMINI_MODEL       = gemini-2.5-flash   (check AI Studio for current IDs)

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CLAUDE_MODEL = "claude-sonnet-5";
const MAX_CHARS = 6000;   // caps the size of any single message
const MAX_TURNS = 12;     // caps how much history gets resent

const SYSTEM = `You are the academic advisor inside MindMuse, a course-planning site for high school students. You are talking directly to a high schooler, usually 14 to 18 years old.

How to advise:
- Be specific and concrete. "Take AP Statistics junior year, it satisfies the stats requirement at most nursing programs" beats "consider math courses."
- Be honest about tradeoffs, including when a goal is unrealistic on the current trajectory. Say it kindly and immediately offer the alternative route, because a real path is more useful than false reassurance.
- Never promise or predict admission anywhere. You can describe typical ranges and what schools tend to weigh.
- Course offerings, credit policies, and graduation requirements vary enormously by school and state. When something depends on local specifics, say so and tell them to confirm with their counselor.
- Name what's actually going well before what isn't. These are teenagers looking at their own grades.
- Grades are not a measure of a person's worth, and never imply otherwise.
- Keep it to a few short paragraphs or a tight list. They're reading on a phone.

Stay on academics, courses, testing, college planning, and careers. If a student raises something personal or serious — family difficulty, mental health, anything where they sound like they're struggling — respond with warmth, keep it brief, and encourage them to talk to a school counselor or a trusted adult. Do not try to counsel them yourself.`;

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Use POST." }) };
  }

  const gemKey = process.env.GEMINI_API_KEY;
  const antKey = process.env.ANTHROPIC_API_KEY;
  if (!gemKey && !antKey) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: "No API key configured yet. In Netlify, go to Site configuration, Environment variables, and add GEMINI_API_KEY (free tier available at aistudio.google.com) or ANTHROPIC_API_KEY. Then trigger a redeploy — env vars only apply to fresh deploys."
    })};
  }

  let messages;
  try {
    messages = JSON.parse(event.body || "{}").messages;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Body wasn't valid JSON." }) };
  }
  if (!Array.isArray(messages) || !messages.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Send a messages array." }) };
  }

  const clean = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (!clean.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No usable messages." }) };
  }

  try {
    const reply = gemKey ? await askGemini(clean, gemKey) : await askClaude(clean, antKey);
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
  } catch (err) {
    console.error("Advisor error:", err);
    return { statusCode: err.status || 500, headers,
             body: JSON.stringify({ error: err.userMessage || "Couldn't reach the AI service. Try again in a moment." }) };
  }
};

/* ---------------- Google Gemini ---------------- */
async function askGemini(msgs, key) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(GEMINI_MODEL) + ":generateContent";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      // Gemini calls the assistant "model", not "assistant"
      contents: msgs.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: 1200, temperature: 0.7 }
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("Gemini error:", res.status, JSON.stringify(data).slice(0, 400));
    const e = new Error("gemini");
    e.status = res.status;
    e.userMessage =
      res.status === 404 ? 'The model "' + GEMINI_MODEL + '" wasn\'t found. Model IDs change — check the current one in Google AI Studio and set GEMINI_MODEL in your Netlify environment variables.'
    : res.status === 400 ? "Google rejected the request. Usually this means the API key is wrong or the Generative Language API isn't enabled for your project."
    : res.status === 429 ? "You've hit Google's free-tier rate limit. It resets — wait a minute, or check your quota in AI Studio."
    : res.status === 403 ? "Google denied access. Check the key is valid and available in your region."
    : "Google's API returned an error. Try again shortly.";
    throw e;
  }

  const cand = (data.candidates || [])[0];
  if (cand && cand.finishReason === "SAFETY") {
    return "I wasn't able to answer that one. Try rephrasing, and keep it to school and career planning.";
  }
  const text = ((cand && cand.content && cand.content.parts) || [])
    .map(p => p.text).filter(Boolean).join("\n").trim();
  return text || "No response came back. Try again.";
}

/* ---------------- Anthropic Claude ---------------- */
async function askClaude(msgs, key) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 1200, system: SYSTEM, messages: msgs
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("Anthropic error:", res.status, JSON.stringify(data).slice(0, 400));
    const e = new Error("claude");
    e.status = res.status;
    e.userMessage =
      res.status === 401 ? "The API key was rejected. Check it's copied correctly in Netlify."
    : res.status === 429 ? "Rate limited or out of credit. Check your usage in the Anthropic console."
    : "The AI service returned an error. Try again in a moment.";
    throw e;
  }

  return (data.content || []).filter(b => b.type === "text")
           .map(b => b.text).join("\n").trim() || "No response came back. Try again.";
}
