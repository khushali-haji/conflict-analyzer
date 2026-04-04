import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config({ path: './server/.env' });

const GEMINI_KEY = process.env.GEMINI_KEY || process.env.VITE_GEMINI_KEY;

async function testKey() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Say hello" }] }] })
    });
    const data = await response.json();
    console.log("Response:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Fetch Error:", err);
  }
}

testKey();
