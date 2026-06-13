import { useState, useEffect, useLayoutEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix for default marker icon in Leaflet + React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";


function ChangeView({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.flyTo(center, zoom || 10, { duration: 1.5 });
    }
  }, [center, zoom, map]);
  return null;
}

// Build a guaranteed-valid verification link from the model's outlet + query.
// The model can't reliably produce real article URLs, so instead of trusting a
// hallucinated deep link we construct a domain-scoped search that always resolves
// and surfaces the actual matching article at the top of the results.
function buildVerificationUrl(v) {
  const query = (v?.query || v?.outlet || "").trim();
  const domain = (v?.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const scoped = domain ? `${query} site:${domain}` : query;
  return `https://www.google.com/search?q=${encodeURIComponent(scoped)}`;
}

// Muted, harmonious pin palette (keyed off the sage-green accent) — no bright primaries.
const PIN = {
  incident: "#5f8a9b",   // muted teal-blue
  actor_base: "#c58a7d", // muted terracotta
  conflict: "#93a886",   // sage green
  timeline: "#c9a96a",   // muted gold
};
// Translucent ring color per pin, used by the radiating pulse animation.
const RING = {
  incident: "rgba(95,138,155,0.5)",
  actor_base: "rgba(197,138,125,0.5)",
  conflict: "rgba(147,168,134,0.5)",
  timeline: "rgba(201,169,106,0.5)",
};

// Deselect the active timeline event when the user clicks empty map space.
// (Leaflet stops marker clicks from bubbling here, so pin clicks still select.)
function MapClickHandler({ onClear }) {
  useMapEvents({ click: onClear });
  return null;
}

function App() {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("url"); // 'url' or 'pdf'
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [activeCoords, setActiveCoords] = useState([20, 0]);
  const [activeZoom, setActiveZoom] = useState(3);
  const [dragging, setDragging] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [selectedTimeline, setSelectedTimeline] = useState(null);
  const [hoverTimeline, setHoverTimeline] = useState(null);
  const [deepError, setDeepError] = useState(false);
  const [popover, setPopover] = useState(null); // { idx, left, width, bottom }
  const [scrollTick, setScrollTick] = useState(0);

  // The event whose full text should pop out: hover takes priority, else the selected one.
  const popoverIdx = hoverTimeline != null ? hoverTimeline : selectedTimeline;

  // Measure the active card and anchor a floating popover to its bottom edge so the
  // full text pops UP and OUT of the panel (escaping its clipping) without resizing the card.
  useLayoutEffect(() => {
    if (popoverIdx == null) { setPopover(null); return; }
    const el = document.getElementById(`timeline-card-${popoverIdx}`);
    if (!el) { setPopover(null); return; }
    const r = el.getBoundingClientRect();
    setPopover({ idx: popoverIdx, left: r.left, width: r.width, bottom: window.innerHeight - r.bottom });
  }, [popoverIdx, scrollTick, result]);

  const analyze = async () => {
    if (mode === "url" && !url) return;
    if (mode === "pdf" && !file) return;

    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      let initResponse;
      if (mode === "url") {
        initResponse = await fetch(`${API_BASE_URL}/api/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } else {
        const formData = new FormData();
        formData.append("pdf", file);
        initResponse = await fetch(`${API_BASE_URL}/api/init-pdf`, {
          method: "POST",
          body: formData,
        });
      }

      if (!initResponse.ok) {
         const err = await initResponse.json();
         throw new Error(err.message || err.error || "Failed to initialize scraper");
      }
      
      const { sessionId } = await initResponse.json();
      setActiveSessionId(sessionId);

      let coreData = {};
      // 1. Get Core Data (Summary, Actors, Main Location)
      try {
        const coreRes = await fetch(`${API_BASE_URL}/api/analyze/core`, {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ sessionId })
        });
        if (!coreRes.ok) {
            const err = await coreRes.json();
            throw new Error(err.error || "Core analysis failed");
        }
        coreData = await coreRes.json();
        
        // Show dashboard!
        setResult({ ...coreData });
        if (coreData.details?.lat !== undefined && coreData.details?.lon !== undefined) {
          setActiveCoords([Number(coreData.details.lat), Number(coreData.details.lon)]);
          setActiveZoom(6);
        }
      } catch (err) {
         throw err;
      } finally {
        setLoading(false); // Remove big overlay spinner
      }

      // 2. Fetch Deep Map Locations in Background
      fetch(`${API_BASE_URL}/api/analyze/locations`, {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ sessionId })
      }).then(r => r.json()).then(locData => {
         setResult(prev => prev ? { ...prev, all_locations: locData.all_locations || [] } : prev);
      }).catch(e => console.error("Locations failed:", e));

      // 3. Fetch Deep Analysis (Timeline & Bias) Automatically (retryable)
      runDeepAnalysis(sessionId);

    } catch (err) {
      let msg = err.message;
      if (msg.toLowerCase().includes("busy") || msg.toLowerCase().includes("high demand") || msg.toLowerCase().includes("503")) {
        msg = "Gemini is currently experiencing high demand. Please wait a few seconds and try again.";
      } else if (msg.toLowerCase().includes("429")) {
        msg = "Rate limit exceeded. Please wait a minute before trying again.";
      }
      setError(msg);
      setLoading(false);
    }
  };

  // Deep analysis (timeline + bias) runs in the background and is retryable on failure.
  const runDeepAnalysis = async (sessionId) => {
    if (!sessionId) return;
    setDeepError(false);
    // Reset to the loading state (spinners) while it runs / re-runs.
    setResult(prev => prev ? { ...prev, timeline: undefined, verification_links: undefined, publication_analysis: undefined, bias_check: undefined } : prev);
    try {
      const r = await fetch(`${API_BASE_URL}/api/analyze/deep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!r.ok) throw new Error("Deep analysis request failed");
      const deepData = await r.json();
      if (deepData.error) throw new Error(deepData.error);
      setResult(prev => prev ? {
        ...prev,
        timeline: deepData.timeline || [],
        verification_links: deepData.verification_links || [],
        publication_analysis: deepData.publication_analysis || {},
        bias_check: deepData.bias_check || {},
      } : prev);
    } catch (e) {
      console.error("Deep analysis failed:", e);
      setDeepError(true);
    }
  };

  const selectTimeline = (ev, idx) => {
    setSelectedTimeline(idx);
    if (ev.lat && ev.lon) {
      setActiveCoords([ev.lat, ev.lon]);
      setActiveZoom(8);
    }
    // Bring the matching card into view when triggered from a map pin
    const card = document.getElementById(`timeline-card-${idx}`);
    if (card) card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  // Phase 1: Original Landing Page
  if (!result && !loading) {
    return (
      <div className="app-container">
        <header className="header">
          <h1>Conflict Lens</h1>
          <p>Condense noise into analysis. Geo-reference, verify, and contextualize <br /> global conflict reporting all in one place.</p>
        </header>

        <div className="input-tabs">
          <button className={`tab-btn ${mode === "url" ? "active" : ""}`} onClick={() => setMode("url")}>Paste Link</button>
          <button className={`tab-btn ${mode === "pdf" ? "active" : ""}`} onClick={() => setMode("pdf")}>Upload PDF</button>
        </div>

        <div className="main-input-wrapper">
          {mode === "url" ? (
            <div className="pdf-or-url-container">
              <div className="input-section">
                <input className="landing-input" type="text" placeholder="Paste news article URL here..." value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="landing-button" onClick={analyze}>Analyze Link</button>
              </div>
              <p className="input-hint">Paste a link from a non-paywalled news site. Use PDF for paywalled content.</p>
            </div>
          ) : (
            <div className="pdf-section">
              <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); setFile(e.dataTransfer.files[0]); }} onClick={() => document.getElementById("fileInput").click()}>
                <input type="file" id="fileInput" hidden accept=".pdf" onChange={(e) => setFile(e.target.files[0])} />
                <div style={{ fontSize: "2.5rem", marginBottom: 10 }}>📄</div>
                {file ? <div className="file-info">{file.name}</div> : <p>Drag your news PDF here or click to browse</p>}
              </div>
              <p className="input-hint">Best for paywalled articles (NYT, Bloomberg, etc.) saved as PDF.</p>
              <button className="secondary-btn" onClick={analyze} disabled={!file} style={{ width: "100%", marginTop: 16, borderRadius: 8, height: 48, background: "var(--accent)", color: "#1a1e1a", fontWeight: "600", border: "none", cursor: "pointer" }}>Analyze Document</button>
            </div>
          )}
          {error && <div style={{ color: "var(--danger)", textAlign: "center", marginTop: 24 }}>{error}</div>}

          <p className="cold-start-note">
            Heads up: the first analysis may take ~30–60 seconds. This demo runs on a free server that
            sleeps when idle, so the initial request has to wake it up. Subsequent analyses are fast.
          </p>
        </div>
      </div>
    );
  }

  // Phase 2: Core Loading State
  if (loading) {
    return (
      <div className="dashboard" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div className="spinner"></div>
          <h2 style={{ marginTop: 24, fontStyle: "italic", fontFamily: "Newsreader" }}>Extracting Core Incident...</h2>
          <p style={{ color: "var(--text-dim)", marginTop: 8 }}>
            Georeferencing primary location and key actors. <br />
            <small>(This usually takes 5-10 seconds)</small>
          </p>
        </div>
      </div>
    );
  }

  // Phase 3: Dashboard Results (Progressive)
  return (
    <div className="dashboard">
      <div className="map-background">
        <MapContainer center={activeCoords} zoom={activeZoom} zoomControl={false} style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution='Tiles &copy; Esri' url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
          {/* Political boundaries + soft gray labels (styled to match the light base — no black halo) */}
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}" />
          
          <MapClickHandler onClear={() => setSelectedTimeline(null)} />

          {result?.details?.lat !== undefined && result?.details?.lon !== undefined && !isNaN(result.details.lat) && !isNaN(result.details.lon) && (
            <Marker position={[result.details.lat, result.details.lon]} icon={L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker incident-marker" style="background: ${PIN.incident}; --ring: ${RING.incident};"></div>`, iconSize:[22,22], iconAnchor:[11,11] })}>
              <Popup><div style={{color:"black"}}><strong>{result.details.location || "Unknown Location"}</strong><br/>Incident Site</div></Popup>
            </Marker>
          )}

          {result?.all_locations === undefined ? null : (result.all_locations || [])
            .filter(loc => {
               if (!result?.details?.lat || !result?.details?.lon) return true;
               // Filter out pins that are roughly at the exact same coordinate as the primary incident site
               const isDuplicate = Math.abs(loc.lat - result.details.lat) < 0.01 && Math.abs(loc.lon - result.details.lon) < 0.01;
               return !isDuplicate;
            })
            .map((loc, idx) => (
            loc?.lat !== undefined && loc?.lon !== undefined && !isNaN(loc.lat) && !isNaN(loc.lon) && (
              <Marker key={idx} position={[loc.lat, loc.lon]} icon={L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker" style="background: ${loc.type === 'actor_base' ? PIN.actor_base : PIN.conflict}; --ring: ${loc.type === 'actor_base' ? RING.actor_base : RING.conflict};"></div>`, iconSize:[18,18], iconAnchor:[9,9] })}>
                <Popup><div style={{color:"black"}}><strong>{loc.name || "Unnamed Area"}</strong><br/>{loc.description || "No description provided."}</div></Popup>
              </Marker>
            )
          ))}

          {result?.timeline === undefined ? null : (result.timeline || []).map((ev, idx) => (
            ev?.lat !== undefined && ev?.lon !== undefined && !isNaN(ev.lat) && !isNaN(ev.lon) && (
              <Marker
                key={`time-${idx}`}
                position={[ev.lat, ev.lon]}
                eventHandlers={{
                  click: () => selectTimeline(ev, idx),
                  mouseover: () => setHoverTimeline(idx),
                  mouseout: () => setHoverTimeline(null),
                }}
                icon={selectedTimeline === idx
                  ? L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker timeline-marker-selected" style="background: ${PIN.timeline}; --ring: ${RING.timeline};"></div>`, iconSize:[20,20], iconAnchor:[10,10] })
                  : hoverTimeline === idx
                    ? L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker timeline-marker-hover" style="background: ${PIN.timeline}; --ring: ${RING.timeline};"></div>`, iconSize:[16,16], iconAnchor:[8,8] })
                    : L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker timeline-marker" style="background: ${PIN.timeline}; --ring: ${RING.timeline}; width: 11px; height: 11px;"></div>`, iconSize:[11,11], iconAnchor:[6,6] })}
              />
            )
          ))}
          <ChangeView center={activeCoords} zoom={activeZoom} />
        </MapContainer>
      </div>

      <div className="overlays">
        <div className="overlay-panel header-panel">
          <div className="header-content">
            <button className="back-btn" onClick={() => setResult(null)}>← Analyze another clip</button>
            <h1 style={{ fontSize: "2rem" }}>Conflict Lens</h1>
            <div className="section-title" style={{ marginTop: 16 }}>Key Details</div>
            <div className="details-grid">
              <div className="detail-row" style={{alignItems: 'start'}}>
                <span className="detail-label">Actors:</span>
                <span className="detail-value">
                  {result?.details?.actors ? (
                    Array.isArray(result.details.actors) 
                      ? result.details.actors.join(", ") 
                      : (
                        <div style={{display: 'flex', flexDirection: 'column', gap: '4px'}}>
                          {result.details.actors.countries_and_states?.length > 0 && <div><span style={{color: 'var(--text-dim-dash)', fontSize: '0.75rem'}}>STATES:</span> {result.details.actors.countries_and_states.join(", ")}</div>}
                          {result.details.actors.groups?.length > 0 && <div><span style={{color: 'var(--text-dim-dash)', fontSize: '0.75rem'}}>GROUPS:</span> {result.details.actors.groups.join(", ")}</div>}
                          {result.details.actors.specific_people?.length > 0 && <div><span style={{color: 'var(--text-dim-dash)', fontSize: '0.75rem'}}>PEOPLE:</span> {result.details.actors.specific_people.join(", ")}</div>}
                        </div>
                      )
                  ) : "N/A"}
                </span>
              </div>
              <div className="detail-row"><span className="detail-label">Location:</span><span className="detail-value">{result?.details?.location || "N/A"}</span></div>
              <div className="detail-row"><span className="detail-label">Date:</span><span className="detail-value">{result?.details?.date || "N/A"}</span></div>
            </div>
          </div>
        </div>

        <div className="overlay-panel sidebar-panel">
          <div className="sidebar-content">
            <div className="section-title">Incident Summary</div>
            <div className="summary-box">
              {typeof result.summary === 'string' ? result.summary : (
                <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                  <div><strong>The Latest:</strong> {result?.summary?.headline}</div>
                  <div><strong>Backdrop:</strong> {result?.summary?.historical_context}</div>
                  <div><strong>Why it matters:</strong> {result?.summary?.importance}</div>
                </div>
              )}
            </div>
            
            <div className="section-title">Journalistic Analysis</div>
            <div className="analysis-box">
              {deepError ? (
                <div className="analysis-error">
                  <p>Deep analysis couldn’t be completed — the model may be busy or rate-limited.</p>
                  <button className="retry-btn" onClick={() => runDeepAnalysis(activeSessionId)}>↻ Retry analysis</button>
                </div>
              ) : result.bias_check === undefined ? (
                <div className="analysis-item" style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                   <div style={{width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 1s linear infinite'}} />
                   <span style={{color: 'var(--text-dim)'}}>Performing deep bias analysis...</span>
                </div>
              ) : (
                <>
                  <div className="analysis-item"><h4>Framing</h4><p>{result?.bias_check?.framing || "No framing analysis available."}</p></div>
                  <div className="analysis-item"><h4>Source Analysis</h4><p><strong>{result?.publication_analysis?.lean || "Unknown Bias"}</strong>: {result?.publication_analysis?.reasoning || "No reasoning provided."}</p></div>
                  <div className="analysis-item"><h4>Cross-Border Context</h4><p>{result?.bias_check?.non_western_context || "No context analysis available."}</p></div>
                  <div className="analysis-item"><h4>Verification Sources</h4>
                    <div className="link-list">
                      {(result?.verification_links || []).map((v, i) => (
                        <a key={i} href={buildVerificationUrl(v)} target="_blank" rel="noreferrer" className="verify-link">
                          <span className="verify-outlet">{v.outlet || "Unknown Source"}</span> {v.reason || "Verification details missing."}
                        </a>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="powered-by">
              AI analysis by Google Gemini · Verification links via web search.
              <span>Generated content may contain errors — verify against original sources.</span>
            </div>
          </div>
        </div>

        <div className="overlay-panel timeline-panel">
          <div className="timeline-header">
            <div className="section-title" style={{ padding: 0 }}>Lead-up Events Timeline</div>
            <div className="map-legend">
              <span className="legend-item"><span className="legend-dot" style={{ background: PIN.incident }} />Incident site</span>
              <span className="legend-item"><span className="legend-dot" style={{ background: PIN.actor_base }} />Actor base</span>
              <span className="legend-item"><span className="legend-dot" style={{ background: PIN.conflict }} />Conflict area</span>
              <span className="legend-item"><span className="legend-dot" style={{ background: PIN.timeline }} />Timeline event</span>
            </div>
          </div>
           {deepError ? (
              <div className="analysis-error" style={{ margin: '12px 24px' }}>
                 <p>Timeline couldn’t be extracted.</p>
                 <button className="retry-btn" onClick={() => runDeepAnalysis(activeSessionId)}>↻ Retry</button>
              </div>
           ) : result.timeline === undefined ? (
              <div style={{display: 'flex', alignItems: 'center', padding: '24px', gap: '12px'}}>
                 <div style={{width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 1s linear infinite'}} />
                 <span style={{color: 'var(--text-dim)'}}>Extracting historical timeline...</span>
              </div>
           ) : result.timeline.length === 0 ? (
              <div style={{padding: '24px', color: 'var(--text-dim)'}}>No timeline events found in this article.</div>
           ) : (
            <div className="timeline-scroll" onScroll={() => setScrollTick((t) => t + 1)}>
              <div className="timeline-inner">
              <div className="timeline-track" />
              {result.timeline?.map((ev, i) => (
                <div
                  key={i}
                  id={`timeline-card-${i}`}
                  className={`timeline-event ${selectedTimeline === i ? "active" : ""} ${hoverTimeline === i ? "hovered" : ""}`}
                  onClick={(e) => { e.stopPropagation(); selectTimeline(ev, i); }}
                  onMouseEnter={() => setHoverTimeline(i)}
                  onMouseLeave={() => setHoverTimeline(null)}
                >
                  <span className="timeline-node" />
                  <div className="timeline-date">{ev.date}</div>
                  <div className="timeline-text">{ev.event}</div>
                </div>
              ))}
              </div>
            </div>
           )}
        </div>

        {/* Floating full-text popover — pops out above the panel, card stays fixed-size */}
        {popover && result?.timeline?.[popover.idx] && (
          <div
            className="timeline-popover"
            style={{ left: popover.left, width: popover.width, bottom: popover.bottom }}
          >
            <div className="timeline-date">{result.timeline[popover.idx].date}</div>
            <div className="timeline-popover-text">{result.timeline[popover.idx].event}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;