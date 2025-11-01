/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionDeclaration,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

const showDirectionFunctionDeclaration: FunctionDeclaration = {
  name: 'showDirection',
  parameters: {
    type: Type.OBJECT,
    description: 'Shows an arrow pointing left or right.',
    properties: {
      direction: {
        type: Type.STRING,
        description:
          "The direction to point the arrow. Can be 'left' or 'right'.",
        enum: ['left', 'right'],
      },
    },
    required: ['direction'],
  },
};

interface TranscriptionEntry {
  speaker: 'user' | 'model';
  text: string;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() private direction: 'left' | 'right' | null = null;
  @state() private currentInputTranscription = '';
  @state() private currentOutputTranscription = '';
  @state() private transcriptionHistory: TranscriptionEntry[] = [];

  @query('#subtitles') private subtitlesEl!: HTMLDivElement;

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext`
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to `any` to access vendor-prefixed `webkitAudioContext`
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    #subtitles {
      position: absolute;
      top: 5vh;
      left: 5vw;
      right: 5vw;
      z-index: 10;
      max-height: 30vh;
      overflow-y: auto;
      padding: 1em;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 12px;
      color: white;
      font-family: sans-serif;
      text-align: left;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.5) transparent;
    }

    #subtitles::-webkit-scrollbar {
      width: 8px;
    }

    #subtitles::-webkit-scrollbar-track {
      background: transparent;
    }

    #subtitles::-webkit-scrollbar-thumb {
      background-color: rgba(255, 255, 255, 0.5);
      border-radius: 4px;
      border: 3px solid transparent;
    }

    #subtitles p {
      margin: 0 0 0.5em;
      padding: 0;
      line-height: 1.4;
    }

    #subtitles strong {
      font-weight: bold;
    }

    #subtitles .speaker-user strong {
      color: #87cefa; /* Light Sky Blue */
    }

    #subtitles .speaker-model strong {
      color: #ffb6c1; /* Light Pink */
    }

    #subtitles .is-live {
      opacity: 0.7;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (
      changedProperties.has('transcriptionHistory') ||
      changedProperties.has('currentInputTranscription') ||
      changedProperties.has('currentOutputTranscription')
    ) {
      this.subtitlesEl.scrollTop = this.subtitlesEl.scrollHeight;
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    // FIX: Use a session promise to avoid race conditions with audio streaming.
    this.sessionPromise = this.client.live.connect({
      model: model,
      callbacks: {
        onopen: () => {
          this.updateStatus('Opened');
        },
        onmessage: async (message: LiveServerMessage) => {
          // Handle audio playback
          const audio =
            message.serverContent?.modelTurn?.parts[0]?.inlineData;

          if (audio) {
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(audio.data),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          // Handle interruption
          const interrupted = message.serverContent?.interrupted;
          if (interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
          }

          // Handle transcriptions
          if (message.serverContent?.inputTranscription) {
            this.currentInputTranscription +=
              message.serverContent.inputTranscription.text;
          } else if (message.serverContent?.outputTranscription) {
            this.currentOutputTranscription +=
              message.serverContent.outputTranscription.text;
          }

          if (message.serverContent?.turnComplete) {
            const history = [...this.transcriptionHistory];
            const fullInput = this.currentInputTranscription.trim();
            const fullOutput = this.currentOutputTranscription.trim();

            if (fullInput) {
              history.push({speaker: 'user', text: fullInput});
            }
            if (fullOutput) {
              history.push({speaker: 'model', text: fullOutput});
            }
            this.transcriptionHistory = history;

            this.currentInputTranscription = '';
            this.currentOutputTranscription = '';
          }

          // Handle tool calls
          if (message.toolCall) {
            for (const fc of message.toolCall.functionCalls) {
              if (fc.name === 'showDirection') {
                const direction = fc.args.direction as
                  | 'left'
                  | 'right'
                  | null;
                if (direction === 'left' || direction === 'right') {
                  this.direction = direction;
                  setTimeout(() => {
                    this.direction = null;
                    // Send response AFTER arrow disappears to trigger audio explanation
                    this.sessionPromise.then((session) => {
                      session.sendToolResponse({
                        functionResponses: {
                          id: fc.id,
                          name: fc.name,
                          response: {result: 'ok'},
                        },
                      });
                    });
                  }, 2000); // Show for 2 seconds
                } else {
                  // If direction is not valid, send response immediately.
                  this.sessionPromise.then((session) => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: {result: 'ok'},
                      },
                    });
                  });
                }
              }
            }
          }
        },
        onerror: (e: ErrorEvent) => {
          this.updateError(e.message);
        },
        onclose: (e: CloseEvent) => {
          this.updateStatus('Close:' + e.reason);
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          // FIX: Use a supported voice name.
          voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Zephyr'}},
        },
        tools: [{functionDeclarations: [showDirectionFunctionDeclaration]}],
        systemInstruction:
          "You are a directional assistant. Your SOLE purpose is to answer user questions by choosing either 'left' or 'right'. You MUST frame every answer within this binary concept. For any user prompt, you MUST FIRST call the `showDirection` function with your choice. Following the function call, you will provide a concise verbal explanation for your reasoning. Direct verbal answers without first calling the function are strictly forbidden. There is no such thing as a question that cannot be answered with 'left' or 'right'. Be as creative as possible; use metaphors, abstract connections, and lateral thinking to connect any topic to a direction. The ONLY exception is if the user says exactly 'hi'. In that case, and only that case, respond with: 'Hi there! Let's play a game. Ask me anything, and I'll do my best to answer by showing you a left or right arrow, and then tell you why!'.",
      },
    });

    this.sessionPromise.catch((e) => {
      this.updateError((e as Error).message);
      console.error(e);
    });
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        // FIX: Use session promise to send real-time input to avoid race conditions.
        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    // FIX: Use session promise to close the session.
    this.sessionPromise?.then((session) => session.close());
    this.initSession();
    this.updateStatus('Session cleared.');
    this.transcriptionHistory = [];
    this.currentInputTranscription = '';
    this.currentOutputTranscription = '';
  }

  render() {
    return html`
      <div>
        <div id="subtitles">
          ${this.transcriptionHistory.map(
            (entry) =>
              html` <p class="speaker-${entry.speaker}">
                <strong>${entry.speaker === 'user' ? 'You' : 'Orb'}:</strong>
                ${entry.text}
              </p>`,
          )}
          ${this.currentInputTranscription
            ? html`<p class="speaker-user is-live">
                <strong>You:</strong> ${this.currentInputTranscription}
              </p>`
            : ''}
          ${this.currentOutputTranscription
            ? html`<p class="speaker-model is-live">
                <strong>Orb:</strong> ${this.currentOutputTranscription}
              </p>`
            : ''}
        </div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status"> ${this.error} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
          .direction=${this.direction}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
