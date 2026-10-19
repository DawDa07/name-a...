"use strict";

// Stand-in for lib/judge.js so the multiplayer test runs offline. Enabled by NTG_FAKE_JUDGE=1.

const CHEESES = { brie: "Brie", gouda: "Gouda", cheddar: "Cheddar", "cheddar cheese": "Cheddar" };

async function checkTopic(topic) {
  return /^[a-z ]*cheese/i.test(topic) ? { ok: true, reason: "" } : { ok: false, reason: "the test judge only knows cheeses" };
}

async function checkAnswer(topic, answer, used) {
  const title = CHEESES[answer.toLowerCase()];
  if (!title) return { result: "incorrect", title: answer, reason: `“${answer}” isn't a cheese.` };
  if (used.includes(title)) return { result: "duplicate", title };
  return { result: "correct", title, description: "cheese" };
}

module.exports = { checkAnswer, checkTopic };
