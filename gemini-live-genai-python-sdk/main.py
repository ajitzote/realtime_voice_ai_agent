import asyncio
import logging
import os

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from gemini_live import GeminiLive
from google.genai import types

load_dotenv()

logging.basicConfig(level=logging.INFO)
logging.getLogger("gemini_live").setLevel(logging.DEBUG)
logging.getLogger(__name__).setLevel(logging.DEBUG)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = os.getenv("MODEL", "gemini-3.1-flash-live-preview")

# WMO weather interpretation codes → human-readable description
WMO_CODES = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}

WEATHER_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="get_weather",
            description=(
                "Gets current weather for a location. "
                "Call this whenever the user asks about weather. "
                "Use latitude/longitude for current location queries, or city for named places."
            ),
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "latitude": types.Schema(
                        type=types.Type.NUMBER,
                        description="Latitude of the location.",
                    ),
                    "longitude": types.Schema(
                        type=types.Type.NUMBER,
                        description="Longitude of the location.",
                    ),
                    "city": types.Schema(
                        type=types.Type.STRING,
                        description="City name, e.g. 'London'. Used when the user names a specific city.",
                    ),
                },
            ),
        )
    ]
)

AUDIO_QUEUE_MAX = 30  # ~2.5 s at ~85 ms/chunk; oldest chunks dropped when full

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="frontend"), name="static")


@app.get("/")
async def root():
    return FileResponse("frontend/index.html")


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    lat: float = Query(None),
    lon: float = Query(None),
):
    """WebSocket endpoint for Gemini Live."""
    await websocket.accept()
    logger.info(f"WebSocket connection accepted — user location: lat={lat}, lon={lon}")

    audio_input_queue = asyncio.Queue(maxsize=AUDIO_QUEUE_MAX)
    text_input_queue = asyncio.Queue()
    client_connected = True

    async def audio_output_callback(data):
        await websocket.send_bytes(data)

    async def audio_interrupt_callback():
        # Drain queued input so stale pre-interruption audio isn't forwarded to
        # the new turn that Gemini is about to start.
        drained = 0
        while not audio_input_queue.empty():
            try:
                audio_input_queue.get_nowait()
                drained += 1
            except asyncio.QueueEmpty:
                break
        if drained:
            logger.debug(f"Interrupted — drained {drained} queued audio chunks")

    # ── Weather tool implementation ───────────────────────────────────────────

    async def get_weather(
        latitude: float = None,
        longitude: float = None,
        city: str = None,
    ) -> str:
        async with httpx.AsyncClient(timeout=10) as client:
            # Resolve city name to coordinates via Open-Meteo geocoding
            if city and latitude is None:
                geo = await client.get(
                    "https://geocoding-api.open-meteo.com/v1/search",
                    params={"name": city, "count": 1, "language": "en", "format": "json"},
                )
                results = geo.json().get("results", [])
                if not results:
                    return f"Could not find a location named '{city}'."
                latitude = results[0]["latitude"]
                longitude = results[0]["longitude"]
                city = results[0].get("name", city)

            # Fall back to the user's browser-supplied coordinates
            if latitude is None:
                if lat is None:
                    return "Location unavailable. Please ask about a specific city."
                latitude, longitude = lat, lon

            r = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": latitude,
                    "longitude": longitude,
                    "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
                    "wind_speed_unit": "kmh",
                    "timezone": "auto",
                },
            )
            r.raise_for_status()
            data = r.json()

        c = data["current"]
        condition = WMO_CODES.get(c["weather_code"], "Unknown conditions")
        location_label = city if city else f"lat {latitude:.2f}, lon {longitude:.2f}"
        return (
            f"{location_label}: {condition}, {c['temperature_2m']}°C "
            f"(feels like {c['apparent_temperature']}°C), "
            f"wind {c['wind_speed_10m']} km/h, "
            f"humidity {c['relative_humidity_2m']}%"
        )

    # ── System instruction ────────────────────────────────────────────────────

    location_hint = ""
    if lat is not None and lon is not None:
        location_hint = (
            f" The user's current location is latitude={lat}, longitude={lon}. "
            "When they ask about the weather at their current location, "
            "call get_weather with these coordinates."
        )

    system_instruction = (
        "You are a helpful voice assistant. Keep your responses concise." + location_hint
    )

    # ── Session ───────────────────────────────────────────────────────────────

    gemini_client = GeminiLive(
        api_key=GEMINI_API_KEY,
        model=MODEL,
        input_sample_rate=16000,
        tools=[WEATHER_TOOL],
        tool_mapping={"get_weather": get_weather},
        system_instruction=system_instruction,
    )

    async def receive_from_client():
        nonlocal client_connected
        try:
            while True:
                message = await websocket.receive()
                if message.get("bytes"):
                    if audio_input_queue.full():
                        try:
                            audio_input_queue.get_nowait()
                            logger.debug("Audio queue full — dropped oldest chunk")
                        except asyncio.QueueEmpty:
                            pass
                    await audio_input_queue.put(message["bytes"])
                elif message.get("text"):
                    await text_input_queue.put(message["text"])
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
            client_connected = False
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")
            client_connected = False

    receive_task = asyncio.create_task(receive_from_client())

    MAX_RETRIES = 5
    BASE_DELAY = 1.0
    attempt = 0

    try:
        while client_connected:
            if attempt > 0:
                # Drain audio accumulated during the outage — it is too stale to
                # be useful and would confuse Gemini's VAD on the new session.
                drained = 0
                while not audio_input_queue.empty():
                    try:
                        audio_input_queue.get_nowait()
                        drained += 1
                    except asyncio.QueueEmpty:
                        break
                logger.info(f"Reconnect attempt {attempt}: drained {drained} stale audio chunks")

            error: Exception | None = None
            try:
                async for event in gemini_client.start_session(
                    audio_input_queue=audio_input_queue,
                    text_input_queue=text_input_queue,
                    audio_output_callback=audio_output_callback,
                    audio_interrupt_callback=audio_interrupt_callback,
                ):
                    if event:
                        await websocket.send_json(event)
            except WebSocketDisconnect:
                client_connected = False
                break
            except Exception as e:
                import traceback
                logger.error(
                    f"Gemini session error (attempt {attempt + 1}): "
                    f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
                )
                error = e

            if not client_connected:
                break

            # Session ended (cleanly or via error) — retry with backoff.
            attempt += 1
            if attempt > MAX_RETRIES:
                try:
                    await websocket.send_json(
                        {"type": "error", "error": "Session unavailable. Please reconnect."}
                    )
                except Exception:
                    pass
                break

            delay = min(BASE_DELAY * (2 ** (attempt - 1)), 30.0)
            if error:
                logger.warning(f"Reconnecting in {delay:.1f}s ({attempt}/{MAX_RETRIES})")
            else:
                logger.warning(
                    f"Gemini session ended unexpectedly — reconnecting in {delay:.1f}s "
                    f"({attempt}/{MAX_RETRIES})"
                )
            try:
                await websocket.send_json(
                    {"type": "reconnecting", "attempt": attempt, "delay": delay}
                )
            except Exception:
                break
            await asyncio.sleep(delay)
    finally:
        receive_task.cancel()
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
