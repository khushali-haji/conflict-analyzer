import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const GEMINI_KEY = process.env.GEMINI_KEY || process.env.VITE_GEMINI_KEY;

async function listModels() {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error listing models:', error);
  }
}

listModels();
