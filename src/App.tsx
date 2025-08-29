// src/App.tsx — FULL DROP-IN (image sync fixed)
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import {
  Shuffle,
  ImageIcon,
  Upload,
  Users,
  MessageSquare,
  PlayCircle,
  RotateCcw,
  Link as LinkIcon,
  Grid as GridIcon,
  CheckCircle2,
} from "lucide-react";

/**
 * Co-Play Image Swap Puzzle — robust realtime + image sync
 * - Upload/paste image → shared via Supabase Storage (if available) or Data URL fallback
 * - Click two tiles to swap; restore original to win
 * - Host chooses shuffle and broadcasts canonical state AFTER subscribe
 * - Big win celebration: glow, bounce, confetti
 * - Ping test + explicit status so you know if you're connected
 * - FIXES: non-host uploads now notify host via "image" event; data URLs render correctly
 */
export default function App({
  defaultGrid = 4,
  supabaseUrl = import.meta?.env?.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey = import.meta?.env?.VITE_SUPABASE_ANON_KEY as string | undefined,
  storageBucket = "puzzle", // create this bucket in Supabase Storage (public)
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [grid, setGrid] = useState<number>(defaultGrid);
  const [order, setOrder] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [moves, setMoves] = useState<number>(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<string | null>(() => getRoomFromUrl());
  const [name, setName] = useState<string>(() => localStorage.getItem("puzzle_name") || randomName());
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [messages, setMessages] = useState<{ id: string; name: string; text: string; ts: number }[]>([]);
  const [inputMsg, setInputMsg] = useState("");
  const [isHost, setIsHost] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [lastStateTimestamp, setLastStateTimestamp] = useState<number>(0);

  const n = grid * grid;
  const hasFiredConfettiRef = useRef(false);
  const channel = useRef<any>(null);

  // Create Supabase client if env vars are present
  const supabase: SupabaseClient | null = useMemo(() => {
    if (!supabaseUrl || !supabaseAnonKey) return null;
    try { return createClient(supabaseUrl, supabaseAnonKey); } catch (e) { console.warn("Failed to create Supabase client", e); return null; }
  }, [supabaseUrl, supabaseAnonKey]);

  // Boot logs
  useEffect(() => {
    console.log("[boot]", { roomId, hasSupabase: !!supabase, envUrl: import.meta.env.VITE_SUPABASE_URL });
  }, [roomId, supabase]);

  // Auto-create a room if missing in the URL (Tab A convenience). Tab B must paste Tab A's URL to join same room.
  useEffect(() => {
    if (!roomId) {
      const id = uuidv4().slice(0, 8);
      const url = new URL(window.location.href);
      url.searchParams.set("room", id);
      window.history.replaceState({}, "", url.toString());
      setRoomId(id);
      console.log("[boot] created room", id);
    }
  }, []);

  // Solved?
  const solved = useMemo(() => order.length > 0 && order.every((v, i) => v === i), [order]);

  // Best time/moves per grid
  const bestKey = useMemo(() => `puzzle_best_${grid}`, [grid]);
  const best = useMemo(() => {
    const raw = localStorage.getItem(bestKey);
    return raw ? (JSON.parse(raw) as { time: number; moves: number }) : null;
  }, [bestKey]);

  // Initialize order when image changes — ALL participants create and broadcast state
  useEffect(() => {
    if (!imgUrl) return;
    if (supabase && !subscribed && roomId) return; // wait until subscribed to broadcast

    const now = Date.now();
    const initial = Array.from({ length: n }, (_, i) => i);
    const shuffled = shuffleWithSeed(initial, now);
    if (isTriviallySame(shuffled)) shuffled.reverse();

    setOrder(shuffled);
    setMoves(0);
    setStartedAt(now);
    setCompletedAt(null);

    if (channel.current && (subscribed || !supabase)) {
      const timestamp = Date.now();
      setLastStateTimestamp(timestamp);
      broadcast({ type: "state", state: { imgUrl, grid, order: shuffled, moves: 0, startedAt: now, completedAt: null }, timestamp });
    }
  }, [imgUrl, n, grid, roomId, supabase, subscribed]);

  // Paste to upload → routes through onUpload (so we share correctly)
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      await onUpload(file);
    };
    window.addEventListener("paste", onPaste as any);
    return () => window.removeEventListener("paste", onPaste as any);
  }, [roomId, isHost, supabase]);

  // Completion: record + confetti + broadcast
  useEffect(() => {
    if (!solved || !startedAt || completedAt) return;
    const done = Date.now();
    setCompletedAt(done);
    const time = Math.floor((done - startedAt) / 1000);
    const record = best ? { ...best } : { time: Infinity, moves: Infinity };
    if (time < record.time || (time === record.time && moves < record.moves)) localStorage.setItem(bestKey, JSON.stringify({ time, moves }));
    if (!hasFiredConfettiRef.current) { 
      hasFiredConfettiRef.current = true; 
      confetti({ particleCount: 160, spread: 70, origin: { y: 0.6 } }); 
      setTimeout(() => confetti({ particleCount: 100, spread: 100, origin: { y: 0.7 } }), 150); 
      setTimeout(() => confetti({ particleCount: 120, spread: 90, origin: { y: 0.5 } }), 350); 
    }
    // Broadcast completion to all participants
    if (channel.current) {
      const timestamp = Date.now();
      setLastStateTimestamp(timestamp);
      broadcast({ type: "complete", timestamp, time, moves });
    }
  }, [solved, startedAt, completedAt, moves, best, bestKey]);

  // ---------- Realtime via Supabase Realtime Channels ----------
  useEffect(() => {
    if (!supabase || !roomId) return;
    setConnecting(true);
    setSubscribed(false);

    const ch = supabase.channel(`puzzle:${roomId}`, { config: { broadcast: { ack: true } } });
    channel.current = ch;
    console.log("[channel] created for room:", roomId);

    // Explicit per-event listeners (robust across SDK versions)
    ch.on("broadcast", { event: "state" }, (evt) => {
      const msg = evt.payload; console.log("[rx] state", msg);
      if (msg?.state && msg.timestamp > lastStateTimestamp) {
        setLastStateTimestamp(msg.timestamp);
        setImgUrl(msg.state.imgUrl);
        setGrid(msg.state.grid);
        setOrder(msg.state.order);
        setMoves(msg.state.moves);
        setStartedAt(msg.state.startedAt);
        setCompletedAt(msg.state.completedAt);
      }
    });
    ch.on("broadcast", { event: "image" }, (evt) => {
      const msg = evt.payload; console.log("[rx] image", msg);
      // All participants adopt the incoming image
      if (msg?.url) {
        setImgUrl(msg.url);
      }
    });
    ch.on("broadcast", { event: "swap" }, (evt) => {
      const msg = evt.payload; console.log("[rx] swap", msg);
      if (Array.isArray(msg?.order)) { setOrder(msg.order); setMoves(msg.moves); setSelected(null); }
    });
    ch.on("broadcast", { event: "select" }, (evt) => { const msg = evt.payload; console.log("[rx] select", msg); setSelected(msg?.index ?? null); });
    ch.on("broadcast", { event: "chat" },   (evt) => { const msg = evt.payload; console.log("[rx] chat", msg); if (msg?.message) setMessages((m) => [...m, msg.message]); });
    ch.on("broadcast", { event: "hello" },  (evt) => { const msg = evt.payload; console.log("[rx] hello", msg); if (imgUrl) { const timestamp = Date.now(); setLastStateTimestamp(timestamp); ch.send({ type: "broadcast", event: "state", payload: { type: "state", state: snapshot(), timestamp } }); } });
    ch.on("broadcast", { event: "ping" },   (evt) => { console.log("[rx] ping", evt.payload); });
    ch.on("broadcast", { event: "reshuffle" }, (evt) => {
      const msg = evt.payload; console.log("[rx] reshuffle", msg);
      if (msg?.seed && msg.timestamp > lastStateTimestamp) {
        setLastStateTimestamp(msg.timestamp);
        const initial = Array.from({ length: n }, (_, i) => i);
        let sh = shuffleWithSeed(initial, msg.seed);
        if (isTriviallySame(sh)) sh.reverse();
        setOrder(sh);
        setMoves(0);
        setStartedAt(Date.now());
        setCompletedAt(null);
        hasFiredConfettiRef.current = false;
      }
    });
    ch.on("broadcast", { event: "reset" }, (evt) => {
      const msg = evt.payload; console.log("[rx] reset", msg);
      if (msg?.timestamp > lastStateTimestamp) {
        setLastStateTimestamp(msg.timestamp);
        const initial = Array.from({ length: n }, (_, i) => i);
        setOrder(initial);
        setMoves(0);
        setStartedAt(Date.now());
        setCompletedAt(null);
        hasFiredConfettiRef.current = false;
      }
    });
    ch.on("broadcast", { event: "complete" }, (evt) => {
      const msg = evt.payload; console.log("[rx] complete", msg);
      if (msg?.timestamp > lastStateTimestamp) {
        setLastStateTimestamp(msg.timestamp);
        setCompletedAt(Date.now());
        if (!hasFiredConfettiRef.current) {
          hasFiredConfettiRef.current = true;
          confetti({ particleCount: 160, spread: 70, origin: { y: 0.6 } });
          setTimeout(() => confetti({ particleCount: 100, spread: 100, origin: { y: 0.7 } }), 150);
          setTimeout(() => confetti({ particleCount: 120, spread: 90, origin: { y: 0.5 } }), 350);
        }
      }
    });
    ch.on("broadcast", { event: "gridChange" }, (evt) => {
      const msg = evt.payload; console.log("[rx] gridChange", msg);
      if (msg?.grid && msg.timestamp > lastStateTimestamp) {
        setLastStateTimestamp(msg.timestamp);
        setGrid(msg.grid);
      }
    });

    ch.subscribe((status: string) => {
      console.log("[sub status]", status);
      if (status === "SUBSCRIBED") {
        setConnecting(false);
        setSubscribed(true);
        const hostKey = `host_${roomId}`;
        if (!localStorage.getItem(hostKey)) {
          localStorage.setItem(hostKey, "1");
          setIsHost(true);
        } else {
          setIsHost(false);
        }
        // All participants send their state when joining
        if (imgUrl) {
          const timestamp = Date.now();
          setLastStateTimestamp(timestamp);
          ch.send({ type: "broadcast", event: "state", payload: { type: "state", state: snapshot(), timestamp } });
        }
        ch.send({ type: "broadcast", event: "hello", payload: { type: "hello", who: name } });
      }
    });

    return () => { try { ch.unsubscribe(); } catch {} channel.current = null; setSubscribed(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, roomId]);

  const snapshot = useCallback(() => ({ imgUrl, grid, order, moves, startedAt, completedAt }), [imgUrl, grid, order, moves, startedAt, completedAt]);

  const broadcast = useCallback(async (payload: any) => {
    if (!channel.current) { console.warn("[tx] no channel", payload); return; }
    const res = await channel.current.send({ type: "broadcast", event: payload.type, payload });
    console.log("[tx ack]", payload.type, res);
  }, []);

  // ---------- Handlers ----------
  const onUpload = useCallback(async (file: File) => {
    // Prefer Storage (small payloads), fall back to a compressed Data URL
    let url: string | null = null;
    try {
      if (supabase) {
        const bucket = storageBucket;
        const path = `rooms/${roomId ?? "solo"}/${Date.now()}-${sanitize(file.name)}`;
        const { error, data } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: "3600", upsert: true, contentType: file.type });
        if (error) throw error;
        const { data: pub } = supabase.storage.from(bucket).getPublicUrl(data.path);
        url = pub.publicUrl; console.log("[upload->storage]", url);
      }
    } catch (e) {
      console.warn("Storage upload failed, falling back to data URL", e);
    }
    if (!url) { url = await fileToDataURL(file, 1200, "image/jpeg", 0.85); console.log("[upload->dataURL] length", url.length); }

    // Set locally so the uploader sees the image immediately
    setImgUrl(url);
    hasFiredConfettiRef.current = false;

    // If in a room with realtime, broadcast the image to all participants
    if (supabase && roomId) {
      broadcast({ type: "image", url, by: name });
    }
  }, [supabase, roomId, storageBucket, isHost, name]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) onUpload(f); }, [onUpload]);

  const handleTileClick = (i: number) => {
    if (solved) return;
    if (selected === null) { setSelected(i); broadcast({ type: "select", index: i, by: name }); return; }
    if (selected === i) { setSelected(null); broadcast({ type: "select", index: null, by: name }); return; }
    const next = order.slice(); [next[selected], next[i]] = [next[i], next[selected]];
    setOrder(next); setSelected(null); setMoves((m) => m + 1);
    console.log("[swap]", { selected, i, orderBefore: order });
    broadcast({ type: "swap", order: next, moves: moves + 1, by: name });
  };

  const reshuffle = () => {
    if (!imgUrl) return;
    const seed = Date.now(); // Use timestamp as seed for deterministic shuffle
    const initial = Array.from({ length: n }, (_, i) => i); 
    let sh = shuffleWithSeed(initial, seed); 
    if (isTriviallySame(sh)) sh.reverse();
    setOrder(sh); setMoves(0); setStartedAt(Date.now()); setCompletedAt(null); hasFiredConfettiRef.current = false;
    const timestamp = Date.now();
    setLastStateTimestamp(timestamp);
    broadcast({ type: "reshuffle", seed, timestamp });
  };

  const reset = () => {
    const initial = Array.from({ length: n }, (_, i) => i);
    setOrder(initial);
    setMoves(0);
    setStartedAt(Date.now());
    setCompletedAt(null);
    hasFiredConfettiRef.current = false;
    const timestamp = Date.now();
    setLastStateTimestamp(timestamp);
    broadcast({ type: "reset", timestamp });
  };

  const makeRoom = () => { const id = uuidv4().slice(0, 8); const url = new URL(window.location.href); url.searchParams.set("room", id); window.history.replaceState({}, "", url.toString()); setRoomId(id); };
  const copyLink = async () => { const url = new URL(window.location.href); if (!roomId) url.searchParams.set("room", uuidv4().slice(0, 8)); await navigator.clipboard.writeText(url.toString()); };

  const seconds = useTimer(startedAt, completedAt);
  const debug = new URLSearchParams(location.search).get("debug") === "1";

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto p-4">
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <GridIcon className="w-6 h-6" />
            <h1 className="text-2xl font-semibold">Co-Play Image Swap Puzzle</h1>
          </div>
          <div className="flex items-center gap-2">
            <input className="px-3 py-2 rounded-xl border bg-white shadow-sm w-40" value={name} onChange={(e) => { setName(e.target.value); localStorage.setItem("puzzle_name", e.target.value); }} placeholder="Your name" />
            <button onClick={() => setChatOpen((s) => !s)} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border shadow-sm hover:shadow"><MessageSquare className="w-4 h-4" /> Chat</button>
          </div>
        </header>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div className="flex items-center gap-2 p-3 rounded-2xl bg-white border shadow-sm">
            <ImageIcon className="w-5 h-5" />
            <label className="cursor-pointer inline-flex items-center gap-2">
              <input type="file" accept="image/*" className="hidden" onChange={onFileInput} />
              <span className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 inline-flex items-center gap-2"><Upload className="w-4 h-4"/>Upload</span>
            </label>
            <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200" onClick={() => setImgUrl(sampleImages[Math.floor(Math.random() * sampleImages.length)])}>Try a sample</button>
            <button className="ml-auto px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 disabled:opacity-50" disabled={!subscribed || !channel.current} onClick={() => broadcast({ type: "ping", at: Date.now(), by: name })}>Ping</button>
          </div>

          <div className="flex items-center gap-2 p-3 rounded-2xl bg-white border shadow-sm">
            <GridIcon className="w-5 h-5" /> Grid:
            <select className="px-3 py-2 rounded-xl border bg-white" value={grid} onChange={(e) => {
              const newGrid = parseInt(e.target.value);
              setGrid(newGrid);
              if (channel.current) {
                const timestamp = Date.now();
                setLastStateTimestamp(timestamp);
                broadcast({ type: "gridChange", grid: newGrid, timestamp });
              }
            }}>
              {[3,4,5,6,7,8].map((g) => (<option key={g} value={g}>{g}×{g}</option>))}
            </select>
            <span className="ml-auto inline-flex items-center gap-2">
              <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 inline-flex items-center gap-2" onClick={reshuffle}><Shuffle className="w-4 h-4"/>Shuffle</button>
              <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 inline-flex items-center gap-2" onClick={reset}><RotateCcw className="w-4 h-4"/>Reset</button>
            </span>
          </div>

          <div className="flex items-center gap-3 p-3 rounded-2xl bg-white border shadow-sm">
            <Users className="w-5 h-5" />
            {roomId ? (
              <>
                <span className="text-sm">Room: <code className="px-2 py-1 bg-gray-100 rounded">{roomId}</code></span>
                <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 inline-flex items-center gap-2" onClick={copyLink}><LinkIcon className="w-4 h-4"/>Copy Link</button>
                <span className="text-xs">
                  {!supabase ? "Realtime disabled (no env)" : !roomId ? "No room" : subscribed ? "Realtime ready" : connecting ? "Realtime connecting..." : "Not subscribed"}
                </span>
              </>
            ) : (
              <button className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 inline-flex items-center gap-2" onClick={makeRoom}><Users className="w-4 h-4"/> Create room</button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 mb-4">
          <div className="px-4 py-2 rounded-2xl bg-white border shadow-sm inline-flex items-center gap-2"><PlayCircle className="w-4 h-4"/> {seconds}s</div>
          <div className="px-4 py-2 rounded-2xl bg-white border shadow-sm inline-flex items-center gap-2"><GridIcon className="w-4 h-4"/> Moves: {moves}</div>
          {best && (<div className="px-4 py-2 rounded-2xl bg-white border shadow-sm text-sm">Best ({grid}×{grid}): {best.time}s / {best.moves} moves</div>)}
        </div>

        {/* Board with big congrats */}
        <motion.div initial={false} animate={solved ? { scale: 1.05 } : { scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 12 }} className={`relative rounded-2xl overflow-hidden mx-auto transition-all border ${solved ? "ring-8 ring-green-400/80 shadow-2xl shadow-green-300/50" : "bg-white shadow"}`} style={{ width: "min(90vw, 720px)", aspectRatio: "1/1" }}>
          {/* Overlay when solved */}
          <AnimatePresence>
            {solved && (
              <motion.div key="solved-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-20 flex items-center justify-center">
                <div className="backdrop-blur-[1px] bg-white/10 rounded-2xl p-4">
                  <div className="flex flex-col items-center text-green-700 drop-shadow">
                    <CheckCircle2 className="w-16 h-16 mb-2" />
                    <div className="text-2xl font-bold">Puzzle Complete!</div>
                    <div className="text-sm opacity-80">Nice work — {seconds}s • {moves} moves</div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Grid (show waiting message for non-host until state arrives) */}
          {!imgUrl ? (
            <div className="absolute inset-0 flex items-center justify-center text-center p-8">
              <div className="text-gray-500">
                <p className="mb-2 font-medium">Drop an image here, paste from clipboard, or use Upload.</p>
                <p className="text-sm">Then share your room link to solve it together 💕</p>
              </div>
            </div>
          ) : (order.length === 0 && supabase && roomId) ? (
            <div className="absolute inset-0 flex items-center justify-center text-center p-8">
              <div className="text-gray-500">
                <p className="mb-2 font-medium">Waiting for puzzle to start…</p>
                <p className="text-sm">Upload an image to begin the game.</p>
              </div>
            </div>
          ) : (
            <TileGrid imgUrl={imgUrl} order={order} grid={grid} selected={selected} onTileClick={handleTileClick} />
          )}
        </motion.div>

        {/* Completed banner (secondary) */}
        <AnimatePresence>
          {solved && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="mt-4 p-4 rounded-2xl border bg-green-50 text-green-900 shadow-sm">🎉 Nice! Puzzle solved in {seconds}s and {moves} moves.</motion.div>
          )}
        </AnimatePresence>

        {debug && (
          <pre className="text-xs bg-gray-100 p-2 rounded mt-4 overflow-x-auto">{JSON.stringify({ roomId, hasSupabase: !!supabase, subscribed, connecting, hasChannel: !!channel.current, envUrl: import.meta.env.VITE_SUPABASE_URL }, null, 2)}</pre>
        )}
      </div>

      {/* Chat drawer */}
      <AnimatePresence>
        {chatOpen && (
          <motion.aside initial={{ x: 320, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 320, opacity: 0 }} transition={{ type: "spring", damping: 20, stiffness: 200 }} className="fixed right-4 bottom-4 w-80 h-[60vh] bg-white border rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-3 border-b flex items-center justify-between">
              <div className="font-semibold inline-flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Room Chat</div>
              <button onClick={() => setChatOpen(false)} className="text-sm px-2 py-1 rounded-lg bg-gray-100">Close</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {messages.map((m) => (<div key={m.id} className="text-sm"><span className="font-medium">{m.name}</span>: {m.text}</div>))}
            </div>
            <div className="p-3 border-t flex items-center gap-2">
              <input 
                value={inputMsg} 
                onChange={(e) => setInputMsg(e.target.value)} 
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!inputMsg.trim()) return;
                    const m = { id: uuidv4(), name, text: inputMsg.trim(), ts: Date.now() };
                    setMessages((x) => [...x, m]);
                    setInputMsg("");
                    broadcast({ type: "chat", message: m });
                  }
                }}
                className="flex-1 px-3 py-2 rounded-xl border bg-white" 
                placeholder="Type a message..." 
              />
              <button onClick={() => { if (!inputMsg.trim()) return; const m = { id: uuidv4(), name, text: inputMsg.trim(), ts: Date.now() }; setMessages((x) => [...x, m]); setInputMsg(""); broadcast({ type: "chat", message: m }); }} className="px-3 py-2 rounded-xl bg-gray-900 text-white">Send</button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <footer className="py-6 text-center text-xs text-gray-500">Pro tip: click two tiles to swap. Paste an image directly (Ctrl/Cmd+V). Share a room link to play together.</footer>
    </div>
  );
}

function TileGrid({ imgUrl, order, grid, selected, onTileClick }: { imgUrl: string; order: number[]; grid: number; selected: number | null; onTileClick: (i: number) => void; }) {
  const tiles = order;
  return (
    <div className="w-full h-full grid" style={{ gridTemplateColumns: `repeat(${grid}, 1fr)`, gridTemplateRows: `repeat(${grid}, 1fr)` }}>
      {tiles.map((origIndex, pos) => {
        const x = origIndex % grid;
        const y = Math.floor(origIndex / grid);
        const bgSize = `${grid * 100}% ${grid * 100}%`;
        const bgPos = `${(x * 100) / (grid - 1)}% ${(y * 100) / (grid - 1)}%`;
        const isSel = selected === pos;
        return (
          <button key={pos} onClick={() => onTileClick(pos)} className={`relative overflow-hidden border transition-transform ${isSel ? "ring-2 ring-indigo-500 z-10 scale-[0.98]" : "hover:scale-[0.99]"}`} style={{ aspectRatio: "1/1" }}>
            <div className="absolute inset-0 bg-center bg-no-repeat" style={{ backgroundImage: `url("${imgUrl}")`, backgroundSize: bgSize, backgroundPosition: bgPos }} />
          </button>
        );
      })}
    </div>
  );
}

function useTimer(startedAt: number | null, completedAt: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => { if (!startedAt) return; const id = setInterval(() => setTick((t) => t + 1), 1000); return () => clearInterval(id); }, [startedAt]);
  if (!startedAt) return 0; const end = completedAt ?? Date.now(); return Math.floor((end - startedAt) / 1000);
}

function shuffle<T>(arr: T[]) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function shuffleWithSeed<T>(arr: T[], seed: number) { 
  const a = arr.slice(); 
  const rng = (max: number) => {
    seed = (seed * 9301 + 49297) % 233280;
    return Math.floor((seed / 233280) * max);
  };
  for (let i = a.length - 1; i > 0; i--) { 
    const j = rng(i + 1); 
    [a[i], a[j]] = [a[j], a[i]]; 
  } 
  return a; 
}
function isTriviallySame(a: number[]) { return a.every((v, i) => v === i); }
function getRoomFromUrl() { try { return new URL(window.location.href).searchParams.get("room"); } catch { return null; } }
function randomName() { const a = ["Comet","Echo","Nova","Pixel","Sunny","Bliss","Lucky","Maple","Zest","Luna"]; const b = ["Fox","Panda","Otter","Koala","Cat","Bee","Husky","Robin","Bunny","Seal"]; return `${a[Math.floor(Math.random()*a.length)]}${b[Math.floor(Math.random()*b.length)]}`; }
function sanitize(name: string) { return name.replace(/[^a-zA-Z0-9._-]/g, "_"); }

// Convert a File to a data URL, with optional downscale for smaller payloads
async function fileToDataURL(file: File, maxDim = 1200, mime: "image/jpeg" | "image/png" = "image/jpeg", quality = 0.85): Promise<string> {
  const toBitmap = async (): Promise<ImageBitmap | HTMLImageElement> => { if ("createImageBitmap" in window) { return await createImageBitmap(file); } return await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = URL.createObjectURL(file); }); };
  const bmp = await toBitmap();
  const width = "width" in bmp ? (bmp as ImageBitmap).width : (bmp as HTMLImageElement).naturalWidth;
  const height = "height" in bmp ? (bmp as ImageBitmap).height : (bmp as HTMLImageElement).naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(width, height)); const w = Math.max(1, Math.round(width * scale)); const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; const ctx = canvas.getContext("2d")!; ctx.drawImage(bmp as any, 0, 0, w, h);
  if ("close" in bmp && typeof (bmp as any).close === "function") (bmp as any).close();
  return canvas.toDataURL(mime, quality);
}

// Sample images (public URLs)
const sampleImages = [
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1200&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1501785888041-af3ef285b470?q=80&w=1200&auto=format&fit=crop",
];
