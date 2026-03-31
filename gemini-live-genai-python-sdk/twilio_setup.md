# Twilio Integration Setup

This guide explains how to connect Gemini Live to Twilio for bidirectional voice calls.

## Prerequisites

1.  A Twilio account and a Twilio phone number.
2.  `ngrok` installed and configured to expose your local server.
3.  Gemini API Key.

## Environment Variables

Add the following to your `.env` file:

```env
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_APP_HOST=your-ngrok-subdomain.ngrok.io
```

## Setup Inbound Calling

1.  **Expose your local server:**
    ```bash
    ngrok http 8000
    ```
    Note the forwarding URL (e.g., `https://your-ngrok-subdomain.ngrok.io`).

2.  **Configure Twilio Webhook:**
    - Go to your Twilio Console -> Phone Numbers -> Active Numbers.
    - Click on your number.
    - Under "Voice & Fax", set "A CALL COMES IN" to "Webhook".
    - URL: `https://your-ngrok-subdomain.ngrok.io/twilio/inbound`
    - Method: `HTTP POST`.

3.  **Test:**
    - Call your Twilio number.
    - You should hear "Connecting to Gemini Live" and then be able to talk to Gemini.

## Setup Outbound Calling

1.  **Ensure `TWILIO_APP_HOST` is set** to your ngrok host in `.env`.
2.  **Trigger the call** using the `/twilio/outbound` endpoint. You can use `curl`:

    ```bash
    curl -X POST "http://localhost:8000/twilio/outbound?to_number=%2B1234567890&from_number=%2B1098765432"
    ```

    > **Note:** The `+` in phone numbers must be URL-encoded as `%2B` in query parameters, otherwise it will be interpreted as a space.

    - `to_number`: The destination phone number.
    - `from_number`: Your Twilio phone number.

## How it Works

- `main.py`: Defines the `/twilio/inbound` endpoint which returns TwiML to start a `<Stream>`.
- `twilio_handler.py`: Handles the WebSocket connection from Twilio, converts G.711 mulaw audio to Linear PCM 16-bit for Gemini, and vice versa.
- `gemini_live.py`: Manages the session with Gemini Live API.
