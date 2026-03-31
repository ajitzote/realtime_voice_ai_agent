# Build a Voice Agent You Can Call on the Phone with Gemini Live API and Twilio

Ever wanted to call an AI on the phone? Not through an app, not through a browser — just pick up your phone, dial a number, and have a real-time voice conversation with Gemini?

In this tutorial, we'll connect the **Gemini Live API** to **Twilio** so that anyone can call your AI agent from any phone. We'll handle the audio format conversion between Twilio's telephony audio (G.711 μ-law at 8kHz) and Gemini's native audio (16-bit PCM at 24kHz), wire up bidirectional streaming, and handle interruptions gracefully.

**What we're building:**
- 📞 **Inbound calls** — Someone calls your Twilio number and talks to Gemini
- 📲 **Outbound calls** — Your app calls someone and connects them to Gemini  
- 🔄 **Real-time bidirectional audio** — Full-duplex conversation, just like a normal phone call

---

## Architecture

Here's how the pieces fit together:

```
┌──────────┐     PSTN      ┌──────────┐   WebSocket    ┌──────────────┐   WebSocket    ┌─────────────┐
│  Phone   │ ◄──────────► │  Twilio  │ ◄────────────► │  Your Server │ ◄────────────► │ Gemini Live │
│          │   G.711 μ-law │          │  G.711 μ-law   │  (FastAPI)   │  PCM 16-bit   │     API     │
└──────────┘    8kHz mono  └──────────┘                └──────────────┘  16kHz/24kHz   └─────────────┘
```

The key challenge is **audio format conversion**. Twilio speaks G.711 μ-law at 8kHz (the standard telephone codec), while Gemini Live expects 16-bit PCM at 16kHz for input and produces 16-bit PCM at 24kHz for output. Our server bridges the gap.

---

## Prerequisites

- **Python 3.12** 
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/)
- A **Twilio account** with a phone number
- **ngrok** (to expose your local server to the internet)

---

## Project Setup

Start by installing the dependencies:

```bash
pip install fastapi uvicorn google-genai websockets python-dotenv twilio
```

Create a `.env` file with your credentials:

```env
GEMINI_API_KEY=your_gemini_api_key
MODEL=gemini-3.1-flash-live-preview
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_APP_HOST=your-ngrok-subdomain.ngrok.io
```

Our project has three Python files:

| File | Purpose |
|------|---------|
| `gemini_live.py` | Reusable Gemini Live API session manager |
| `twilio_handler.py` | Audio conversion + Twilio Media Stream handling |
| `main.py` | FastAPI server with HTTP and WebSocket endpoints |

---

## Step 1: The Gemini Live Session Manager

First, we need a reusable class that manages a Gemini Live session. This class accepts audio from any source via async queues and delivers output through callbacks — making it easy to plug in different transports (browser WebSocket, Twilio, etc.).

```python
# gemini_live.py
import asyncio
import inspect
import logging
import traceback

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

class GeminiLive:
    def __init__(self, api_key, model, input_sample_rate, tools=None, tool_mapping=None):
        self.api_key = api_key
        self.model = model
        self.input_sample_rate = input_sample_rate
        self.client = genai.Client(api_key=api_key)
        self.tools = tools or []
        self.tool_mapping = tool_mapping or {}

    async def start_session(self, audio_input_queue, video_input_queue, 
                            text_input_queue, audio_output_callback, 
                            audio_interrupt_callback=None):
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck"
                    )
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part(text="You are a helpful AI assistant.")]
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                turn_coverage="TURN_INCLUDES_ONLY_ACTIVITY",
            ),
            tools=self.tools,
        )

        async with self.client.aio.live.connect(
            model=self.model, config=config
        ) as session:
            # ... send/receive loops (see full source)
```

The key design decisions:

- **`input_sample_rate`** is configurable — Twilio sends 8kHz audio that we resample to 16kHz before passing to Gemini
- **`audio_output_callback`** can be sync or async — detected at runtime with `inspect.iscoroutinefunction()`
- **`turn_coverage="TURN_INCLUDES_ONLY_ACTIVITY"`** tells Gemini to only count actual speech as turn input, reducing costs

---

## Step 2: The Twilio Handler (The Fun Part)

This is where the audio magic happens. Twilio Media Streams send and receive **G.711 μ-law audio at 8kHz**, but Gemini wants **16-bit linear PCM at 16kHz** (input) and outputs at **24kHz** (output).

```python
# twilio_handler.py
import asyncio
import base64
import json
import logging
import audioop
from gemini_live import GeminiLive

logger = logging.getLogger(__name__)

class TwilioHandler:
    def __init__(self, gemini_api_key, model):
        self.gemini_client = GeminiLive(
            api_key=gemini_api_key,
            model=model,
            input_sample_rate=16000
        )
        self.stream_sid = None
```

### Audio Input: Twilio → Gemini

When Twilio sends us audio, we need to convert it from μ-law 8kHz to PCM 16kHz:

```python
elif event == "media":
    payload = data["media"]["payload"]
    mulaw_data = base64.b64decode(payload)
    
    # Convert mulaw to 16-bit PCM (still at 8kHz)
    pcm_data = audioop.ulaw2lin(mulaw_data, 2)
    
    # Resample 8kHz → 16kHz (clean 1:2 ratio)
    resampled_data, _ = audioop.ratecv(pcm_data, 2, 1, 8000, 16000, None)
    
    await audio_input_queue.put(resampled_data)
```

The `audioop` module handles both the codec conversion (`ulaw2lin`) and the sample rate conversion (`ratecv`). We upsample from 8kHz to 16kHz because Gemini's speech recognition works better with higher sample rate input.

### Audio Output: Gemini → Twilio

The reverse path is trickier. Gemini outputs 24kHz PCM, and we need to downsample to 8kHz μ-law. We do this in two steps for better audio quality:

```python
async def audio_output_callback(data):
    if not self.stream_sid:
        return

    # Two-step resampling: 24kHz → 16kHz → 8kHz
    # (Better quality than a single 3:1 jump)
    intermediate, _ = audioop.ratecv(data, 2, 1, 24000, 16000, None)
    resampled_data, _ = audioop.ratecv(intermediate, 2, 1, 16000, 8000, None)
    
    # Convert PCM to mulaw
    mulaw_data = audioop.lin2ulaw(resampled_data, 2)

    # Buffer and send in consistent frame sizes
    output_buffer.extend(mulaw_data)
    await send_buffered_audio(websocket, self.stream_sid)
```

> 💡 **Why two-step resampling?** Going from 24kHz directly to 8kHz (a 3:1 ratio) can produce aliasing artifacts. Stepping through 16kHz first (3:2, then 2:1) gives cleaner results since each step is a smaller ratio.

### Frame Buffering

Twilio expects audio in consistent 20ms frames. At 8kHz with 1 byte per sample (μ-law), that's exactly **160 bytes** per frame:

```python
MULAW_FRAME_SIZE = 160  # 20ms at 8kHz

async def send_buffered_audio(websocket, stream_sid):
    nonlocal output_buffer
    while len(output_buffer) >= MULAW_FRAME_SIZE:
        frame = bytes(output_buffer[:MULAW_FRAME_SIZE])
        del output_buffer[:MULAW_FRAME_SIZE]
        payload = base64.b64encode(frame).decode("utf-8")
        await websocket.send_text(json.dumps({
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": payload},
        }))
```

### Handling Interruptions

When the caller interrupts Gemini mid-sentence, we need to stop playback immediately. Gemini signals this via the `interrupted` event, and we respond by clearing both our local buffer and Twilio's playback buffer:

```python
async def audio_interrupt_callback():
    nonlocal output_buffer
    output_buffer.clear()  # Clear our local buffer
    if self.stream_sid:
        # Tell Twilio to stop playing queued audio
        await websocket.send_text(json.dumps({
            "event": "clear",
            "streamSid": self.stream_sid
        }))
```

### The Initial Greeting

One nice touch — when the stream starts, we send a text prompt to Gemini to kick off the conversation. Without this, there would be awkward silence until the caller speaks first:

```python
if event == "start":
    self.stream_sid = data["start"]["streamSid"]
    # Send initial prompt so the agent greets the caller
    await text_input_queue.put("Greet the caller and ask how you can help them.")
```

---

## Step 3: Wiring it up with FastAPI

Now we need three endpoints:

### Inbound Call Webhook

When someone calls your Twilio number, Twilio sends a POST request to your webhook. We respond with TwiML that tells Twilio to open a bidirectional WebSocket media stream back to our server:

```python
@app.post("/twilio/inbound")
async def twilio_inbound():
    host = TWILIO_APP_HOST or "localhost:8000"
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connecting to Gemini Live.</Say>
    <Connect>
        <Stream url="wss://{host}/twilio/stream" />
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")
```

The `<Say>` plays a brief message while the WebSocket connects. Then `<Stream>` opens the bidirectional audio pipe.

### Media Stream WebSocket

This is where Twilio connects for the actual audio streaming:

```python
@app.websocket("/twilio/stream")
async def twilio_stream(websocket: WebSocket):
    await websocket.accept()
    handler = TwilioHandler(gemini_api_key=GEMINI_API_KEY, model=MODEL)
    try:
        await handler.handle_media_stream(websocket)
    except Exception as e:
        logger.error(f"Twilio stream error: {e}", exc_info=True)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
```

### Outbound Calls (Bonus)

Want your agent to call someone? Use the Twilio REST API:

```python
@app.post("/twilio/outbound")
async def twilio_outbound(
    to_number: str = Query(...),
    from_number: str = Query(...),
):
    from twilio.rest import Client as TwilioClient
    client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    
    call = client.calls.create(
        to=to_number,
        from_=from_number,
        twiml=f"""<Response>
    <Say>Connecting to Gemini Live.</Say>
    <Connect>
        <Stream url="wss://{TWILIO_APP_HOST}/twilio/stream" />
    </Connect>
</Response>""",
    )
    return {"callSid": call.sid, "status": call.status}
```

Trigger it with curl:

```bash
curl -X POST "http://localhost:8000/twilio/outbound?to_number=%2B1234567890&from_number=%2B1098765432"
```

> **Note:** The `+` in phone numbers must be URL-encoded as `%2B` in query parameters, otherwise it will be interpreted as a space.

---

## Step 4: Running Locally

### Start your server

```bash
python main.py
```

### Expose it with ngrok

In a separate terminal:

```bash
ngrok http 8000
```

Copy the forwarding URL (e.g., `https://abc123.ngrok.io`) and update `TWILIO_APP_HOST` in your `.env`.

### Configure Twilio

1. Go to **Twilio Console → Phone Numbers → Active Numbers**
2. Click your number
3. Under **Voice & Fax**, set "A CALL COMES IN" to **Webhook**
4. URL: `https://your-ngrok-subdomain.ngrok.io/twilio/inbound`
5. Method: **HTTP POST**

### Call it!

Dial your Twilio number. You'll hear "Connecting to Gemini Live" followed by Gemini greeting you. Have a conversation!

---

## Deploying to Cloud Run

For production, deploy to Google Cloud Run:

```bash
# Store your API key in Secret Manager
gcloud services enable secretmanager.googleapis.com
echo -n "$(grep GEMINI_API_KEY .env | cut -d '=' -f2)" | gcloud secrets create GEMINI_API_KEY --data-file=-

# Deploy the app
gcloud run deploy gemini-live-demo \
    --source . \
    --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest \
    --set-env-vars MODEL=gemini-3.1-flash-live-preview \
    --allow-unauthenticated \
    --region us-central1
```

For Twilio secrets, also store them in **Secret Manager**:

```bash
# Store Twilio secrets
echo -n "$(grep TWILIO_ACCOUNT_SID .env | cut -d '=' -f2)" | \
    gcloud secrets create TWILIO_ACCOUNT_SID --data-file=-
echo -n "$(grep TWILIO_AUTH_TOKEN .env | cut -d '=' -f2)" | \
    gcloud secrets create TWILIO_AUTH_TOKEN --data-file=-

# Deploy with all secrets
gcloud run deploy gemini-live-demo \
    --source . \
    --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest,TWILIO_ACCOUNT_SID=TWILIO_ACCOUNT_SID:latest,TWILIO_AUTH_TOKEN=TWILIO_AUTH_TOKEN:latest \
    --allow-unauthenticated \
    --region us-central1
```

Once deployed, copy the Service URL from the output and update the service with `TWILIO_APP_HOST`:

```bash
gcloud run services update gemini-live-demo \
    --set-env-vars TWILIO_APP_HOST=your-cloud-run-url.run.app \
    --region us-central1
```

Then update your Twilio webhook to point to `https://YOUR_CLOUD_RUN_URL/twilio/inbound`.

---

## Audio Pipeline Summary

Here's a quick reference for the audio conversions happening in each direction:

| Direction | Source Format | Conversion Steps | Target Format |
|-----------|-------------|-----------------|---------------|
| **Caller → Gemini** | 8kHz μ-law | `ulaw2lin` → `ratecv(8k→16k)` | 16kHz 16-bit PCM |
| **Gemini → Caller** | 24kHz 16-bit PCM | `ratecv(24k→16k)` → `ratecv(16k→8k)` → `lin2ulaw` | 8kHz μ-law |

---

## What's Next?

Now that your voice agent is accessible via phone, here are some ideas:

- **Add function calling** — Let Gemini look up order status, check appointments, or query databases mid-conversation using the `tools` and `tool_mapping` parameters
- **Custom system instructions** — Tailor the agent's personality and knowledge for your specific use case (customer support, appointment booking, etc.)
- **Call recording and transcription** — The `input_audio_transcription` and `output_audio_transcription` configs are already enabled, so you can log conversations
- **Transfer to a human** — Use Twilio's `<Dial>` TwiML to transfer calls when the AI can't help

---

*The full source code is available on [GitHub](https://github.com/google-gemini/gemini-live-api-examples/tree/main/gemini-live-genai-python-sdk).*
