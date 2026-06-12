import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import crypto from "crypto";

const upload = multer({ storage: multer.memoryStorage() });

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const RAW_KEY = process.env.GEMINI_KEY || process.env.VITE_GEMINI_KEY;
const GEMINI_KEY = RAW_KEY ? RAW_KEY.trim().replace(/^["']|["']$/g, '') : null;

if (!GEMINI_KEY) {
  console.error("❌ CRITICAL: GEMINI_KEY is missing or empty in .env!");
} else {
  console.log(`✅ Gemini API Key found`);
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Memory cache for scraped text (ID -> text) to prevent re-scraping for the 3 analysis steps
const sessions = new Map();

// Cleanup old sessions (older than 15 mins) every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of sessions.entries()) {
    if (now - data.timestamp > 15 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// Helper to ask Gemini
async function askGemini(text, prompt, customPrompt) {
  const modelName = "gemini-2.5-flash";
  let aiData;
  let retries = 3;
  let delay = 2000;

  const finalPrompt = customPrompt ? `${customPrompt}\n\nContent:\n${text}` : `${prompt}\n\nContent:\n${text}`;

  for (let i = 0; i < retries; i++) {
    try {
      const apiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: finalPrompt }] }],
          }),
        }
      );

      aiData = await apiResponse.json();

      if (aiData.error) {
        const errMsg = aiData.error.message || "";
        // Quota-exceeded is NOT worth retrying — retrying just burns more of the limit.
        // Only retry transient "server busy / overloaded" conditions (503 / high demand).
        const isQuota = aiData.error.code === 429 && /quota|free_tier/i.test(errMsg);
        const isRetryable = !isQuota && (aiData.error.code === 503 || /high demand|busy|overloaded/i.test(errMsg));
        if (isRetryable && i < retries - 1) {
          console.log(`⚠️ Gemini busy on ${modelName} (Attempt ${i + 1}/${retries}). Retrying...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        throw new Error(aiData.error.message || "Gemini Error");
      }
      
      let aiText = aiData.candidates[0].content.parts[0].text;
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) aiText = jsonMatch[0];
      return JSON.parse(aiText);

    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// 1. INIT ENDPOINT - Scrape/Extract Text
app.post("/api/init", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const html = response.data;
    const $ = cheerio.load(html);
    $("script, style").remove();

    let text = $("article").text() || $("main").text() || $("body").text();
    text = text.replace(/\s+/g, " ").trim();

    const paywallKeywords = ["subscribe", "log in", "create an account", "subscription is required"];
    const lowercaseText = text.toLowerCase().slice(0, 500);
    const isPaywalled = paywallKeywords.some(keyword => lowercaseText.includes(keyword)) || text.length < 400;

    if (isPaywalled) {
      return res.status(403).json({ error: "PAYWALL_BLOCKED", message: "Paywall detected. Upload PDF instead." });
    }

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { text: text.slice(0, 8000), timestamp: Date.now() });
    
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/init-pdf", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
  try {
    const parser = new PDFParse({ data: req.file.buffer });
    const pdfData = await parser.getText();
    const text = pdfData.text.replace(/\s+/g, " ").trim().slice(0, 8000);
    
    if (text.length < 100) throw new Error("Could not extract enough text from PDF.");

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { text, timestamp: Date.now() });
    
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. CORE ANALYSIS
app.post("/api/analyze/core", async (req, res) => {
  const { sessionId, customPrompt } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid or expired session" });

  const prompt = `You are a conflict analyst. Analyze this text for the core incident. Ensure the main event has a real-world latitude and longitude estimate (e.g. 39.9042, 116.4074). Do NOT leave lat/lon as 0.0. If you do not know the exact location, provide coordinates for the country's capital.
  Respond ONLY with valid JSON:
  {
    "summary": {
      "headline": "1 line summary of the recent news event",
      "historical_context": "Brief historical backdrop of the conflict",
      "importance": "Why is this important? Why should readers care?"
    },
    "details": {
      "location": "City, Region, Country",
      "lat": 39.9042,
      "lon": 116.4074,
      "actors": {
        "countries_and_states": ["Country A", "State B"],
        "groups": ["Paramilitary X", "Organization Y"],
        "specific_people": ["Person Z (Minister of Defense)", "Person Y (Rebel Leader)"]
      },
      "casualties": "summary of human impact or 'None reported'",
      "date": "When did this occur?"
    }
  }`;

  try {
    const data = await askGemini(session.text, prompt, customPrompt);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. LOCATIONS ANALYSIS
app.post("/api/analyze/locations", async (req, res) => {
  const { sessionId, modelType } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid session" });

  const prompt = `You are a geographer. Analyze this text for conflict map points. Ensure EVERY single actor, base, and conflict site has a real-world latitude and longitude estimate, do NOT leave as 0.0.
  Respond ONLY with valid JSON:
  {
    "all_locations": [
      { "name": "Include conflict sites and international base locations", "lat": 12.34, "lon": 56.78, "type": "conflict_area|actor_base|international_player", "description": "..." }
    ]
  }`;

  try {
    const data = await askGemini(session.text, prompt);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. DEEP ANALYSIS (Timeline & Bias)
app.post("/api/analyze/deep", async (req, res) => {
  const { sessionId, modelType } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Invalid session" });

  const prompt = `You are a deep journalistic analyst. Analyze this text for institutional bias and historical events. Ensure EVERY timeline event has a real-world latitude and longitude estimate, do NOT leave as 0.0.
  Respond ONLY with valid JSON:
  {
    "timeline": [
      { "date": "...", "event": "3-5 lead-up historical context events", "location": "...", "lat": 12.34, "lon": 56.78 }
    ],
    "verification_links": [
      { "outlet": "Associated Press|Reuters|DW|etc.", "domain": "the outlet's bare domain, e.g. reuters.com, apnews.com, dw.com", "query": "3-6 keyword search phrase a reader would use to find this exact story on that outlet (no quotes, no operators)", "reason": "5-8 words MAX. Specific to THIS outlet's distinct angle on THIS story, never generic boilerplate. e.g. 'Independent Gaza casualty figures', 'On-ground Khartoum eyewitness reporting', 'German-EU diplomatic perspective'. No full sentences." }
    ],
    "publication_analysis": {
      "lean": "Analyze the INSTITUTION ITSELF (e.g., Al Jazeera, NYT). Lean: Left/Center/Right/State-owned/etc.",
      "bias_score": 0.5,
      "reasoning": "Analyze the outlet's institutional history"
    },
    "bias_check": {
      "framing": "How is this story being framed?",
      "non_western_context": "What non-Western context might be missing?",
      "key_omissions": "What details are noticeably absent?"
    }
  }`;

  try {
    const data = await askGemini(session.text, prompt);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
