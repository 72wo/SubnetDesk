import type { VideoFrame as ProtocolVideoFrame } from "./generated/message";
import type { ProtocolVideoCodec } from "./capabilities";
import {
  closeVideoDecoder,
  createVideoDecoderConfig,
  decodeVideoBatch,
  initialVideoDecodeState,
  type VideoDecodeState,
} from "./video";

interface InitializeMessage {
  type: "initialize";
  canvas?: OffscreenCanvas;
  codec: string;
  protocol: ProtocolVideoCodec;
  width: number;
  height: number;
}

interface FrameMessage {
  type: "frame";
  frame: ProtocolVideoFrame;
}

interface ResetMessage {
  type: "reset";
}

type WorkerInput = InitializeMessage | FrameMessage | ResetMessage;

interface WorkerOutput {
  type: "ack" | "stats" | "error";
  fps?: number;
  droppedFrames?: number;
  message?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null;
  postMessage(message: WorkerOutput): void;
};

let canvas: OffscreenCanvas | undefined;
let context: OffscreenCanvasRenderingContext2D | null = null;
let decoder: VideoDecoder | undefined;
let decodeState: VideoDecodeState = initialVideoDecodeState();
let pendingAcks = 0;
let renderedFrames = 0;
let statsWindowStartedAt = 0;

function post(message: WorkerOutput): void {
  workerScope.postMessage(message);
}

function resetDecoder(): void {
  closeVideoDecoder(decoder);
  decoder = undefined;
  pendingAcks = 0;
  renderedFrames = 0;
  statsWindowStartedAt = 0;
}

async function initialize(message: InitializeMessage): Promise<void> {
  if (message.canvas) {
    canvas = message.canvas;
    context = canvas.getContext("2d", { alpha: false });
  }
  if (!canvas || !context) throw new Error("Offscreen canvas is unavailable");
  resetDecoder();
  canvas.width = message.width;
  canvas.height = message.height;
  decodeState = initialVideoDecodeState(message.protocol);
  const config = createVideoDecoderConfig(message.codec, message.width, message.height);
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`Unsupported video configuration: ${message.codec}`);
  decoder = new VideoDecoder({
    output: (frame) => {
      context?.drawImage(frame, 0, 0, canvas?.width ?? frame.displayWidth, canvas?.height ?? frame.displayHeight);
      frame.close();
      renderedFrames += 1;
      const now = performance.now();
      if (statsWindowStartedAt === 0) statsWindowStartedAt = now;
      if (now - statsWindowStartedAt >= 1_000) {
        post({
          type: "stats",
          fps: Math.round((renderedFrames * 1_000) / (now - statsWindowStartedAt)),
          droppedFrames: decodeState.droppedFrames,
        });
        renderedFrames = 0;
        statsWindowStartedAt = now;
      }
      if (pendingAcks > 0) {
        pendingAcks -= 1;
        post({ type: "ack" });
      }
    },
    error: (error) => post({ type: "error", message: error.message }),
  });
  decoder.configure(config);
}

function decode(frame: ProtocolVideoFrame): void {
  if (!decoder) {
    post({ type: "ack" });
    return;
  }
  const previousDropped = decodeState.droppedFrames;
  decodeState = decodeVideoBatch(decoder, frame, decodeState);
  if (decodeState.awaitingKeyFrame || decodeState.droppedFrames > previousDropped) {
    post({ type: "ack" });
  } else {
    pendingAcks += 1;
  }
}

let messageQueue = Promise.resolve();

workerScope.onmessage = (event) => {
  messageQueue = messageQueue
    .then(async () => {
      if (event.data.type === "initialize") {
        await initialize(event.data);
      } else if (event.data.type === "frame") {
        decode(event.data.frame);
      } else {
        resetDecoder();
      }
    })
    .catch((error: unknown) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : "Video worker failed",
      });
    });
};
