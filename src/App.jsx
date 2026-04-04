import { useState, useRef, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix for default marker icon in Leaflet + React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

function ChangeView({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.flyTo(center, zoom || 10, { duration: 1.5 });
    }
  }, [center, zoom, map]);
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

  const analyze = async () => {
    if (mode === "url" && !url) return;
    if (mode === "pdf" && !file) return;

    setLoading(true);
    setError(null);
    setResult(null);
    
    try {
      let initResponse;
      if (mode === "url") {
        initResponse = await fetch("http://localhost:3001/api/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } else {
        const formData = new FormData();
        formData.append("pdf", file);
        initResponse = await fetch("http://localhost:3001/api/init-pdf", {
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
        const coreRes = await fetch("http://localhost:3001/api/analyze/core", {
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
      fetch("http://localhost:3001/api/analyze/locations", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ sessionId })
      }).then(r => r.json()).then(locData => {
         setResult(prev => prev ? { ...prev, all_locations: locData.all_locations || [] } : prev);
      }).catch(e => console.error("Locations failed:", e));

      // 3. Fetch Deep Analysis (Timeline & Bias) Automatically
      fetch("http://localhost:3001/api/analyze/deep", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ sessionId })
      }).then(r => r.json()).then(deepData => {
         setResult(prev => prev ? { 
            ...prev, 
            timeline: deepData.timeline || [],
            verification_links: deepData.verification_links || [],
            publication_analysis: deepData.publication_analysis || {},
            bias_check: deepData.bias_check || {}
         } : prev);
      }).catch(e => console.error("Deep analysis failed:", e));

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

  const handleTimelineClick = (ev) => {
    if (ev.lat && ev.lon) {
      setActiveCoords([ev.lat, ev.lon]);
      setActiveZoom(8);
    }
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
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
          
          {result?.details?.lat !== undefined && result?.details?.lon !== undefined && !isNaN(result.details.lat) && !isNaN(result.details.lon) && (
            <Marker position={[result.details.lat, result.details.lon]}><Popup><div style={{color:"black"}}><strong>{result.details.location || "Unknown Location"}</strong><br/>Incident Site</div></Popup></Marker>
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
              <Marker key={idx} position={[loc.lat, loc.lon]} icon={L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker" style="background: ${loc.type === 'actor_base' ? '#ef4444' : '#93a886'};"></div>`, iconSize:[18,18], iconAnchor:[9,9] })}>
                <Popup><div style={{color:"black"}}><strong>{loc.name || "Unnamed Area"}</strong><br/>{loc.description || "No description provided."}</div></Popup>
              </Marker>
            )
          ))}

          {result?.timeline === undefined ? null : (result.timeline || []).map((ev, idx) => (
            ev?.lat !== undefined && ev?.lon !== undefined && !isNaN(ev.lat) && !isNaN(ev.lon) && (
              <Marker key={`time-${idx}`} position={[ev.lat, ev.lon]} icon={L.divIcon({ className: 'custom-div-icon', html: `<div class="custom-marker" style="background: #fbbf24; width: 10px; height: 10px; border-width: 1px;"></div>`, iconSize:[10,10], iconAnchor:[5,5] })}>
                <Popup><div style={{color:"black"}}><strong>{ev.date || "Date Unknown"}</strong><br/>{ev.event || "Event description missing."}</div></Popup>
              </Marker>
            )
          ))}
          <ChangeView center={activeCoords} zoom={activeZoom} />
        </MapContainer>
      </div>

      <div className="overlays">
        <div className="overlay-panel header-panel">
          <div className="header-content">
            <button className="back-btn" onClick={() => setResult(null)}>← New Analysis</button>
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
              {result.bias_check === undefined ? (
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
                        <a key={i} href={v.link} target="_blank" rel="noreferrer" className="verify-link">
                          <span className="verify-outlet">{v.outlet || "Unknown Source"}</span> {v.reason || "Verification details missing."}
                        </a>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="overlay-panel timeline-panel">
          <div className="section-title" style={{ padding: "16px 24px 0 24px" }}>Lead-up Events Timeline</div>
           {result.timeline === undefined ? (
              <div style={{display: 'flex', alignItems: 'center', padding: '24px', gap: '12px'}}>
                 <div style={{width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--accent)', borderTopColor: 'transparent', animation: 'spin 1s linear infinite'}} />
                 <span style={{color: 'var(--text-dim)'}}>Extracting historical timeline...</span>
              </div>
           ) : result.timeline.length === 0 ? (
              <div style={{padding: '24px', color: 'var(--text-dim)'}}>No timeline events found in this article.</div>
           ) : (
            <div className="timeline-scroll">
              {result.timeline?.map((ev, i) => (
                <div key={i} className="timeline-event" onClick={() => handleTimelineClick(ev)}>
                  <div className="timeline-date">{ev.date}</div>
                  <div className="timeline-text">{ev.event}</div>
                </div>
              ))}
            </div>
           )}
        </div>
      </div>
    </div>
  );
}

export default App;