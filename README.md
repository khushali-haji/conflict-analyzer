# Conflict Lens

Conflict Lens turns a news article about a global conflict into a single, geo-referenced dashboard. Paste a link or upload a PDF, and it pulls out the core incident, plots every relevant location on a map, builds a timeline of the events that led up to it, and flags how the reporting itself might be shaped by bias or missing context.

Live demo: https://khushali-haji.github.io/conflict-analyzer/

## The problem

Conflict coverage is scattered and hard to verify. A single article rarely gives you the full picture: where things happened relative to each other, what led up to the event, or whether the outlet's framing leaves something out. Cross-referencing that by hand across multiple sources takes real effort, and most readers don't do it.

Conflict Lens automates that first pass. It doesn't replace reading other sources, but it gives you a structured starting point and points you toward outlets worth checking next.

## How it works

1. **Input**: paste a news article URL, or upload a PDF for paywalled or scrape-blocked sources (Reuters, AP News, Bloomberg, NYT).
2. **Core extraction**: the backend scrapes or parses the text and asks Gemini to identify the main incident, its location, the actors involved (states, groups, named individuals), casualties, and date.
3. **Map building**: a second pass pulls out every other location mentioned, conflict areas, actor bases, involved third countries, and geocodes them so they can be plotted.
4. **Deep analysis**: a third pass builds a timeline of the events leading up to the incident, generates outlet-specific search links so you can verify the story elsewhere, and produces a short bias read: how the piece is framed, what a non-Western audience might read differently, and what seems to be missing.
5. **Result**: everything renders progressively onto a map-first dashboard as each step completes, rather than making you wait for the whole pipeline to finish before showing anything.

## Design decisions worth knowing about

- **Progressive loading over one big spinner.** The core incident (location, actors, summary) usually comes back in 5 to 10 seconds, so it's shown immediately. The location pass and the deep analysis pass run after, each filling in its own part of the UI when ready, instead of blocking the whole page on the slowest step.
- **No hallucinated article links.** The model can't reliably produce a real, working URL to a specific article. Rather than showing a link that's likely broken, verification links are built as domain-scoped searches (`site:reuters.com <query>`), which always resolve and put the real article at the top of the results.
- **PDF upload as the paywall escape hatch.** Automated scraping fails on paywalled and bot-blocked outlets. Rather than fighting that, the app detects the block and asks the user to save the page as a PDF instead, which sidesteps the problem entirely.
- **Mobile as a first-class layout, not a squeeze.** The map is the main surface on both desktop and mobile, but on mobile the side panels become bottom sheets (Key Details, Summary, Timeline) so the map stays the focus instead of getting buried under stacked content.
- **Retryable analysis, not a failed page.** The deep analysis step is the one most likely to hit rate limits or model overload. If it fails, the rest of the dashboard stays usable and a retry button re-runs just that step, instead of forcing a full restart.

## Tech stack

- **Frontend**: React + Vite, Leaflet/react-leaflet for the map, deployed to GitHub Pages.
- **Backend**: Node/Express, Cheerio for scraping, pdf-parse for PDF text extraction, deployed separately (e.g. Render).
- **AI**: Google Gemini (`gemini-2.5-flash-lite`) for all text analysis, called through three separate prompts (core, locations, deep) so the UI can render each as it lands.

## Running it locally

You'll need a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
# install frontend deps
npm install

# install backend deps
cd server && npm install && cd ..

# copy the env example and add your Gemini key
cp .env.example .env

# run frontend + backend together
npm run dev
```

The frontend runs at `http://localhost:5173`, the backend at `http://localhost:3001`. The first analysis on the hosted demo can take 30 to 60 seconds because the free backend host sleeps when idle; locally it's fast from the first request.
