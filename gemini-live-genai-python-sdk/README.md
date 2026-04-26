# Real-Time Voice Agent — Gemini Live API

A real-time voice agent where a user speaks, Gemini listens, and Gemini speaks back — with sub-second latency, natural interruption, and a live weather tool.

**Stack:** Python 3.11 + FastAPI (server) · Google Gemini Live API · Vanilla JS + Web Audio API (client)

---

## Quick Start

```bash
# 1. Install dependencies
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt

# 2. Set your API key
echo "GEMINI_API_KEY=your_key_here" > .env

# 3. Start the server
uv run main.py

# 4. Open http://localhost:8000 and click Connect
```

Get a free API key at [Google AI Studio](https://aistudio.google.com/).

---

## Design Decisions

### Transport: WebSocket

**Why WebSocket over HTTP/SSE, long-polling, or WebRTC:**

The pipeline has two hard requirements: continuous low-latency delivery of raw PCM audio in both directions, and a persistent stateful session with Gemini. WebSocket is the only browser-native protocol that satisfies both at once — it is full-duplex, keeps a single TCP connection alive, and has negligible per-frame overhead (2–10 byte header vs ~800 bytes for an HTTP request).

HTTP SSE could carry Gemini's output to the client but cannot carry audio upload from the client without polling. WebRTC would give better resilience on lossy networks (UDP-based SRTP can drop packets without blocking later ones) but requires a STUN/TURN server, a signaling channel, and codec negotiation — significant infrastructure overhead for a server-to-server forwarding use case.

**Cost on a bad network:**

WebSocket runs over TCP, which means head-of-line blocking: a single lost packet stalls delivery of every subsequent audio frame until the retransmit arrives. On a 200 ms round-trip with 2 % packet loss this can add 400–600 ms spikes to perceived latency. The audio will catch up (Gemini's output is buffered at the client and scheduled sequentially) but the user will hear a pause followed by a burst. There is no mechanism here to skip stale frames — the client plays everything it receives, in order.

---

### Audio Format and Chunking

| Direction | Sample rate | Format | Frame size |
|-----------|-------------|--------|------------|
| Client → Server → Gemini | 16 kHz | 16-bit signed PCM, mono | ~1 365 samples (~85 ms) |
| Gemini → Server → Client | 24 kHz | 16-bit signed PCM, mono | Variable (forwarded as-is) |

**Input path:**

The browser's AudioContext typically runs at 44.1 kHz or 48 kHz. The AudioWorklet (`pcm-processor.js`) buffers 4 096 samples at the device's native rate — at 48 kHz that is ~85 ms of audio. On each flush, `media-handler.js` downsamples to 16 kHz (Gemini's required input rate) using a windowed-average algorithm, converts Float32 to Int16, and sends the raw bytes as a binary WebSocket message.

16 kHz was chosen because that is what the Gemini Live API accepts (`audio/pcm;rate=16000`). Sending at 48 kHz would require server-side resampling, adding latency and a dependency. Downsampling on the client is free (runs in the AudioWorklet thread, off the main thread).

The 4 096-sample buffer is a trade-off: smaller buffers reduce input latency but increase message frequency and per-message overhead; larger buffers do the opposite. 85 ms sits in the range where Gemini's VAD has enough signal to make reliable activity decisions without the user feeling a long pre-send delay.

**Output path:**

Gemini streams 24 kHz Int16 PCM. The server forwards each chunk immediately via `websocket.send_bytes()` — no buffering or resampling on the server. The client decodes each chunk into a `Float32Array`, creates an `AudioBuffer` at 24 kHz, and schedules it against a `nextStartTime` cursor. Each buffer is scheduled to start exactly where the previous one ended, so playback is seamless even when chunks arrive with network jitter. If `audioContext.currentTime` has already passed `nextStartTime` (a burst of late chunks), the cursor resets to `currentTime` to avoid scheduling in the past.

**Backpressure:**

- *Client faster than Gemini (input)*: `audio_input_queue` is bounded at 30 chunks (`AUDIO_QUEUE_MAX`), approximately 2.5 s of audio at 85 ms/chunk. When the queue is full, the oldest chunk is evicted before the new one is inserted (drop-oldest). This keeps the queue from growing without bound and ensures that, under sustained Gemini backpressure, the audio reaching Gemini is always the most recent speech rather than a seconds-old backlog.
- *Gemini faster than client (output)*: There is no server-side output buffer; the server forwards each chunk immediately via `websocket.send_bytes()`. TCP's send buffer absorbs short bursts. A genuinely slow client (congested downlink) will back-pressure the `await websocket.send_bytes()` call, pausing `receive_loop`. The send/receive tasks are independent so this does not block audio arriving from Gemini — it only delays forwarding. The client catches up and plays continuously once the congestion clears.

---

### Turn-Taking and Interruption

Turn detection is delegated entirely to Gemini's built-in Voice Activity Detection. The session is opened with:

```python
realtime_input_config=types.RealtimeInputConfig(
    turn_coverage="TURN_INCLUDES_ONLY_ACTIVITY",
)
```

`TURN_INCLUDES_ONLY_ACTIVITY` tells Gemini to mark turn boundaries based on detected speech, not on the continuous audio stream. The server never sends an explicit end-of-turn signal; Gemini infers it from silence following speech.

**Interruption:** When the user speaks while Gemini is responding, Gemini detects the new speech activity, stops generating, and emits an `interrupted` server content flag. The server's `audio_interrupt_callback` fires first: it drains every chunk currently sitting in `audio_input_queue`, discarding audio that was recorded during the model's reply and is now stale. The server then forwards `{"type": "interrupted"}` over the WebSocket. The client calls `stopAudioPlayback()`, which stops all scheduled `AudioBufferSourceNode`s and resets the `nextStartTime` cursor to `audioContext.currentTime`. The user's new audio is already flowing — there is no push-to-talk, no button press, and no client-side silence timer involved.

The latency of this interruption path is: Gemini VAD detection time (~100–200 ms typical) + one WebSocket round-trip. The user perceives the model as having "heard" them immediately after Gemini stops talking.

---

### Concurrency Model

Each WebSocket connection spawns four concurrent asyncio tasks:

```
receive_from_client   ← reads binary/text frames from the browser
  └─ audio_input_queue (asyncio.Queue)
       └─ send_audio              → writes PCM chunks to Gemini session
  └─ text_input_queue (asyncio.Queue)
       └─ send_text               → writes text turns to Gemini session

receive_loop          ← reads Gemini responses; calls audio_output_callback;
                         puts JSON events onto event_queue
  └─ event_queue (asyncio.Queue)
       └─ run_session (generator) → sends JSON events to browser
```

All four are asyncio coroutines on the same event loop. They yield at every `await`, so none blocks the others. The only shared state between tasks is the two input queues and the event queue; there are no locks.

**Bottleneck:** The Gemini network round-trip. If Gemini is slow to acknowledge audio input, `send_audio` backs up at `session.send_realtime_input()`. This does not affect `receive_loop` or the browser-facing send path.

**What happens if one task stalls:**
- `receive_from_client` stalls → input queues stop filling → Gemini hears silence → no output generated. The session stays open.
- `send_audio` stalls → same as above.
- `receive_loop` stalls → `event_queue` fills → `run_session` blocks at `event_queue.get()` → JSON events to browser are delayed but no data is lost until the queue overflows (unbounded).
- If `receive_loop` raises an unhandled exception, it puts `None` on the event queue. The `run_session` generator sees `None` as a sentinel, breaks, and the outer `finally` block cancels all three sibling tasks.

---

### Failure Modes

| Scenario | Behaviour |
|----------|-----------|
| Browser disconnects | `websocket.receive()` raises `WebSocketDisconnect`. `receive_from_client` sets `client_connected = False` and exits. The retry loop detects the flag, stops retrying, and the `finally` block cancels `receive_task` and closes the WebSocket. |
| Gemini disconnects mid-response | `session.receive()` raises an exception inside `receive_loop`. The loop catches it, puts an error event then `None` on `event_queue`, and exits. The session generator returns. The retry loop catches the exception (or sees the generator exit), waits with exponential backoff (1 s, 2 s, 4 s … up to 30 s), sends `{"type": "reconnecting"}` to the client, and opens a new Gemini session — passing the latest session resumption handle so Gemini can restore context. After 5 failed attempts it sends `{"type": "error"}` and closes cleanly. |
| `GoAway` from Gemini | Logged at WARNING level. The `async with session` context manager handles teardown; the session generator exits normally. The retry loop treats this as an unexpected session end and reconnects with the same backoff path, passing the stored resumption handle. |
| Malformed client message | A non-JSON text frame is put on `text_input_queue` as a raw string. Gemini receives it as a text turn; it is benign. A message that is neither bytes nor text is ignored silently. |
| Weather tool HTTP error | `httpx` raises `HTTPStatusError` from `r.raise_for_status()`. The exception is caught inside `receive_loop`'s tool-call handler and the string `"Error: <message>"` is sent back to Gemini as the tool result. Gemini tells the user it could not fetch the weather. The session continues. |
| Unhandled server exception | Any exception escaping the `async for` loop is caught by the retry loop, logged with a full traceback, and triggers a reconnect attempt rather than closing the WebSocket immediately. The server process itself does not crash. |

---

### Audio Quality

Raw PCM is used end-to-end; there is no codec (no Opus, no MP3). This eliminates codec latency and decode complexity at the cost of higher bandwidth (~512 kbps for 16 kHz Int16 mono). On a local or broadband connection this is fine.

**Downsampling (client-side, input path):** `downsampleBuffer` in `media-handler.js` uses a windowed-average (box filter): each output sample is the mean of all input samples that fall within its window. This is equivalent to a crude low-pass filter with a rectangular impulse response. It prevents clipping and gross aliasing but does not have a sharp roll-off at the Nyquist frequency of the output (8 kHz). For voice, whose fundamental energy is concentrated below 4 kHz, the audible difference versus a polyphase resampler is small. A production system might use a proper anti-aliasing filter for higher-fidelity input, at the cost of a small additional computation in the AudioWorklet.

**Output path:** Gemini's 24 kHz output is fed directly to a `createBuffer(..., 24000)` AudioContext buffer. The Web Audio API handles D/A conversion at whatever rate the device runs at (44.1 or 48 kHz). The browser resamples internally using its own high-quality SRC. No resampling is done in application code on the output side.

---

### Weather Tool

The weather tool is implemented server-side using [Open-Meteo](https://open-meteo.com/) (free, no API key required).

When the frontend connects it passes the browser's geolocation as query parameters (`/ws?lat=X&lon=Y`). These are injected into the system instruction so Gemini knows the user's coordinates without asking. If the user asks "what's the weather like?" Gemini calls `get_weather` with those coordinates automatically.

If the user asks about a named city, Gemini passes a `city` string instead. The server resolves the city to coordinates via Open-Meteo's geocoding endpoint before fetching weather data.

If geolocation is denied or unavailable, the tool falls back to requiring a city name.

---

## Assumptions

1. **Single user per WebSocket connection.** The Gemini Live API's session model is one conversation per connection. There is no session multiplexing — each tab gets its own server task and its own Gemini session.

2. **Modern browser required.** The client uses `AudioWorklet`, `navigator.mediaDevices.getUserMedia`, and the WebSocket binary frame API. These are available in all current Chrome, Firefox, Safari, and Edge versions (circa 2020+). There is no polyfill.

3. **Open-Meteo is reliable enough for a demo.** It is a public, free API with no authentication. A production system would use a paid weather API with SLA guarantees.

4. **HTTPS is not required locally.** `ws://` works on `localhost`. Deploying to any public URL requires `wss://` (TLS), which is handled automatically by Cloud Run.

5. **Gemini's VAD is sufficient for turn detection.** No client-side silence timer or push-to-talk is implemented. This works well for conversational speech in a quiet environment. Background noise can cause false activity detections; a production system might add client-side noise suppression (e.g., `noiseSuppression: true` in `getUserMedia` constraints, which is already a browser default).

---

## Project Structure

```
├── main.py             # FastAPI server, WebSocket endpoint, weather tool
├── gemini_live.py      # Gemini Live API session wrapper (async generator)
├── requirements.txt    # Python dependencies
├── Dockerfile          # Container image for Cloud Run
├── deployment_cloud_run.md
└── frontend/
    ├── index.html      # UI shell
    ├── main.js         # App state, message routing, UI updates
    ├── gemini-client.js # WebSocket client wrapper
    ├── media-handler.js # Audio capture, downsampling, scheduled playback
    └── pcm-processor.js # AudioWorklet: buffers PCM at device sample rate
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Required. Google AI Studio key. |
| `MODEL` | `gemini-3.1-flash-live-preview` | Gemini model to use. |
| `PORT` | `8000` | Server port. |
