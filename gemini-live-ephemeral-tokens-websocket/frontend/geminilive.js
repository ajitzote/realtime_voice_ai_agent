/**
 * Gemini Live API Utilities
 * Based on multimodalLiveApi.ts - converted to JavaScript
 */

// Response type constants
const MultimodalLiveResponseType = {
  TEXT: "TEXT",
  AUDIO: "AUDIO",
  SETUP_COMPLETE: "SETUP COMPLETE",
  INTERRUPTED: "INTERRUPTED",
  TURN_COMPLETE: "TURN COMPLETE",
  TOOL_CALL: "TOOL_CALL",
  ERROR: "ERROR",
  INPUT_TRANSCRIPTION: "INPUT_TRANSCRIPTION",
  OUTPUT_TRANSCRIPTION: "OUTPUT_TRANSCRIPTION",
};

/**
 * Parses response messages from the Gemini Live API
 */
class MultimodalLiveResponseMessage {
  constructor(data) {
    this.data = "";
    this.type = "";
    this.endOfTurn = false;

    console.log("raw message data: ", data);

    const serverContent = data?.serverContent;
    this.endOfTurn = serverContent?.turnComplete;
    const parts = serverContent?.modelTurn?.parts;

    try {
      if (data?.setupComplete) {
        console.log("🏁 SETUP COMPLETE response", data);
        this.type = MultimodalLiveResponseType.SETUP_COMPLETE;
      } else if (serverContent?.turnComplete) {
        console.log("🏁 TURN COMPLETE response");
        this.type = MultimodalLiveResponseType.TURN_COMPLETE;
      } else if (serverContent?.interrupted) {
        console.log("🗣️ INTERRUPTED response");
        this.type = MultimodalLiveResponseType.INTERRUPTED;
      } else if (serverContent?.inputTranscription) {
        console.log("📝 INPUT TRANSCRIPTION:", serverContent.inputTranscription);
        this.type = MultimodalLiveResponseType.INPUT_TRANSCRIPTION;
        this.data = {
          text: serverContent.inputTranscription.text || "",
          finished: serverContent.inputTranscription.finished || false,
        };
      } else if (serverContent?.outputTranscription) {
        console.log("📝 OUTPUT TRANSCRIPTION:", serverContent.outputTranscription);
        this.type = MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION;
        this.data = {
          text: serverContent.outputTranscription.text || "",
          finished: serverContent.outputTranscription.finished || false,
        };
      } else if (data?.toolCall) {
        console.log("🎯 🛠️ TOOL CALL response", data?.toolCall);
        this.type = MultimodalLiveResponseType.TOOL_CALL;
        this.data = data?.toolCall;
      } else if (parts?.length && parts[0].text) {
        console.log("💬 TEXT response", parts[0].text);
        this.data = parts[0].text;
        this.type = MultimodalLiveResponseType.TEXT;
      } else if (parts?.length && parts[0].inlineData) {
        console.log("🔊 AUDIO response");
        this.data = parts[0].inlineData.data;
        this.type = MultimodalLiveResponseType.AUDIO;
      }
    } catch (err) {
      console.log("⚠️ Error parsing response data: ", err, data);
    }
  }
}

/**
 * Function call definition for tool use
 */
class FunctionCallDefinition {
  constructor(name, description, parameters, requiredParameters) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.requiredParameters = requiredParameters;
  }

  functionToCall(parameters) {
    console.log("▶️Default function call");
  }

  getDefinition() {
    const definition = {
      name: this.name,
      description: this.description,
      parameters: { required: this.requiredParameters, ...this.parameters },
    };
    console.log("created FunctionDefinition: ", definition);
    return definition;
  }

  runFunction(parameters) {
    console.log(
      `⚡ Running ${this.name} function with parameters: ${JSON.stringify(
        parameters
      )}`
    );
    this.functionToCall(parameters);
  }
}

/**
 * Main Gemini Live API client
 */
class GeminiLiveAPI {
  constructor(token, model) {
    this.token = token;
    this.model = model;
    this.modelUri = `models/${this.model}`;

    this.responseModalities = ["AUDIO"];
    this.systemInstructions = "";
    this.googleGrounding = false;
    this.enableAffectiveDialog = false; // Default affective dialog
    this.voiceName = "Puck"; // Default voice
    this.temperature = 1.0; // Default temperature
    this.proactivity = { proactiveAudio: false }; // Proactivity config
    this.inputAudioTranscription = false;
    this.outputAudioTranscription = false;
    this.enableFunctionCalls = false;
    this.functions = [];
    this.functionsMap = {};
    this.previousImage = null;
    this.totalBytesSent = 0;

    // Automatic activity detection settings with defaults
    this.automaticActivityDetection = {
      disabled: false,
      silence_duration_ms: 2000,
      prefix_padding_ms: 500,
      end_of_speech_sensitivity: "END_SENSITIVITY_UNSPECIFIED",
      start_of_speech_sensitivity: "START_SENSITIVITY_UNSPECIFIED",
    };

    this.activityHandling = "ACTIVITY_HANDLING_UNSPECIFIED";

    this.serviceUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${this.token}`;
    console.log("Service URL (v1alpha): ", this.serviceUrl);

    this.connected = false;
    this.webSocket = null;
    this.lastSetupMessage = null; // Store the last setup message

    // Default callbacks
    this.onReceiveResponse = (message) => {
      console.log("Default message received callback", message);
    };

    this.onOpen = () => {
      console.log("Default onOpen");
    };

    this.onClose = () => {
      console.log("Default onClose");
    };

    this.onError = (message) => {
      alert(message);
      this.connected = false;
    };

    console.log("Created Gemini Live API object: ", this);
  }

  setProjectId(projectId) {
    // No longer needed for Gemini API
  }

  setSystemInstructions(newSystemInstructions) {
    console.log("setting system instructions: ", newSystemInstructions);
    this.systemInstructions = newSystemInstructions;
  }

  setGoogleGrounding(newGoogleGrounding) {
    console.log("setting google grounding: ", newGoogleGrounding);
    this.googleGrounding = newGoogleGrounding;
  }

  setResponseModalities(modalities) {
    this.responseModalities = modalities;
  }

  setVoice(voiceName) {
    console.log("setting voice: ", voiceName);
    this.voiceName = voiceName;
  }

  setProactivity(proactivity) {
    console.log("setting proactivity: ", proactivity);
    this.proactivity = proactivity;
  }

  setInputAudioTranscription(enabled) {
    console.log("setting input audio transcription: ", enabled);
    this.inputAudioTranscription = enabled;
  }

  setOutputAudioTranscription(enabled) {
    console.log("setting output audio transcription: ", enabled);
    this.outputAudioTranscription = enabled;
  }

  setEnableFunctionCalls(enabled) {
    console.log("setting enable function calls: ", enabled);
    this.enableFunctionCalls = enabled;
  }

  addFunction(newFunction) {
    this.functions.push(newFunction);
    this.functionsMap[newFunction.name] = newFunction;
    console.log("added function: ", newFunction);
  }

  callFunction(functionName, parameters) {
    const functionToCall = this.functionsMap[functionName];
    functionToCall.runFunction(parameters);
  }

  connect() {
    this.setupWebSocketToService();
  }

  disconnect() {
    if (this.webSocket) {
      this.webSocket.close();
      this.connected = false;
    }
  }

  sendMessage(message) {
    console.log("🟩 Sending message: ", message);
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }

  async onReceiveMessage(messageEvent) {
    console.log("Message received: ", messageEvent);

    let jsonData;
    if (messageEvent.data instanceof Blob) {
      jsonData = await messageEvent.data.text();
    } else if (messageEvent.data instanceof ArrayBuffer) {
      jsonData = new TextDecoder().decode(messageEvent.data);
    } else {
      jsonData = messageEvent.data;
    }

    try {
      const messageData = JSON.parse(jsonData);
      const message = new MultimodalLiveResponseMessage(messageData);
      this.onReceiveResponse(message);
    } catch (err) {
      console.error("Error parsing JSON message:", err, jsonData);
    }
  }

  setupWebSocketToService() {
    console.log("connecting directly to: ", this.serviceUrl);

    this.webSocket = new WebSocket(this.serviceUrl);

    this.webSocket.onclose = (event) => {
      console.log("websocket closed: ", event);
      this.connected = false;
      this.onClose();
    };

    this.webSocket.onerror = (event) => {
      console.log("websocket error: ", event);
      this.connected = false;
      this.onError("Connection error");
    };

    this.webSocket.onopen = (event) => {
      console.log("websocket open: ", event);
      this.connected = true;
      this.totalBytesSent = 0;
      this.sendInitialSetupMessages();
      this.onOpen();
    };

    this.webSocket.onmessage = this.onReceiveMessage.bind(this);
  }

  getFunctionDefinitions() {
    console.log("🛠️ getFunctionDefinitions called");
    const tools = [];

    for (let index = 0; index < this.functions.length; index++) {
      const func = this.functions[index];
      tools.push(func.getDefinition());
    }
    return tools;
  }

  sendInitialSetupMessages() {
    const tools = this.getFunctionDefinitions();

    const sessionSetupMessage = {
      setup: {
        model: this.modelUri,
        generationConfig: {
          responseModalities: this.responseModalities,
          temperature: this.temperature,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName,
              },
            },
          },
        },
        systemInstruction: { parts: [{ text: this.systemInstructions }] },
        tools: { functionDeclarations: tools },
        proactivity: this.proactivity,

        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: this.automaticActivityDetection.disabled,
            silenceDurationMs: this.automaticActivityDetection.silence_duration_ms,
            prefixPaddingMs: this.automaticActivityDetection.prefix_padding_ms,
            endOfSpeechSensitivity: this.automaticActivityDetection.end_of_speech_sensitivity,
            startOfSpeechSensitivity: this.automaticActivityDetection.start_of_speech_sensitivity,
          },
          activityHandling: this.activityHandling,
        },
      },
    };

    // Add transcription config if enabled
    if (this.inputAudioTranscription) {
      sessionSetupMessage.setup.inputAudioTranscription = {};
    }
    if (this.outputAudioTranscription) {
      sessionSetupMessage.setup.outputAudioTranscription = {};
    }

    if (this.googleGrounding) {
      sessionSetupMessage.setup.tools.googleSearch = {};
      // Currently can't have both Google Search with custom tools.
      console.log(
        "Google Grounding enabled, removing custom function calls if any."
      );
      delete sessionSetupMessage.setup.tools.functionDeclarations;
    }

    // Add affective dialog if enabled
    if (this.enableAffectiveDialog) {
      sessionSetupMessage.setup.generationConfig.enableAffectiveDialog = true;
    }

    // Store the setup message for later access
    this.lastSetupMessage = sessionSetupMessage;

    console.log("sessionSetupMessage: ", sessionSetupMessage);
    this.sendMessage(sessionSetupMessage);
  }

  sendTextMessage(text) {
    const message = {
      realtimeInput: {
        text: text,
      },
    };
    this.sendMessage(message);
  }

  sendToolResponse(toolCallId, response) {
    const message = {
      toolResponse: {
        id: toolCallId,
        response: response,
      },
    };
    console.log("🔧 Sending tool response:", message);
    this.sendMessage(message);
  }

  sendRealtimeInputMessage(data, mimeType) {
    const blob = { mimeType, data };
    const message = { realtimeInput: {} };

    if (mimeType.startsWith("audio/")) {
      message.realtimeInput.audio = blob;
    } else if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
      message.realtimeInput.video = blob;
    }

    this.sendMessage(message);
    this.addToBytesSent(data);
  }

  addToBytesSent(data) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    this.totalBytesSent += encodedData.length;
  }

  getBytesSent() {
    return this.totalBytesSent;
  }

  sendAudioMessage(base64PCM) {
    this.sendRealtimeInputMessage(base64PCM, "audio/pcm");
  }

  async sendImageMessage(base64Image, mimeType = "image/jpeg") {
    this.sendRealtimeInputMessage(base64Image, mimeType);
  }
}

console.log("loaded geminiLiveApi.js");
