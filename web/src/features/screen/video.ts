// The screen as live video: H.264 pictures from the server, decoded by the browser
// (WebCodecs) onto a canvas. Speaks to the trackpad and the keys as the VNC client does.

export interface VideoAnswer {
  ok?: boolean;
  error?: string;
  build?: string;
  /** The picture's size; `false` when the server cannot send video and VNC is to be used. */
  video?: { width: number; height: number } | false;
  /** Whether the Mac lets negi move the pointer and press keys. */
  input?: boolean;
  /** The account whose Mac password this device must give once before video. */
  password?: string;
}

export const canDecode = () => typeof VideoDecoder !== "undefined";

/** The codec string of the stream, read from its sequence parameter set. */
function codecOf(data: Uint8Array) {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1 && (data[i + 4] & 31) === 7) {
      return "avc1." + [...data.subarray(i + 5, i + 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  return null;
}

export class VideoViewer {
  viewOnly = false;
  _fbWidth: number;
  _fbHeight: number;
  _canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private decoder: VideoDecoder | null = null;
  private codec = "";
  private waiting = true;
  private latest: VideoFrame | null = null;
  private painting = 0;
  private readonly fit: ResizeObserver;
  private ended = false;
  private readonly target: HTMLElement;
  private readonly socket: WebSocket;
  private readonly onEnd: () => void;

  constructor(target: HTMLElement, socket: WebSocket, size: { width: number; height: number }, onEnd: () => void) {
    this.target = target;
    this.socket = socket;
    this.onEnd = onEnd;
    this._fbWidth = size.width;
    this._fbHeight = size.height;
    const canvas = (this._canvas = document.createElement("canvas"));
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.style.position = "absolute";
    target.appendChild(canvas);
    this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    // Fitted whole inside the stage and centred, as the VNC client draws it.
    this.fit = new ResizeObserver(() => this.place());
    this.fit.observe(target);
    this.place();
    socket.onmessage = (e) => e.data instanceof ArrayBuffer && this.take(e.data);
    socket.onclose = () => this.end();
  }

  private place() {
    const [w, h] = [this.target.clientWidth, this.target.clientHeight];
    const scale = Math.min(w / this._fbWidth, h / this._fbHeight) || 1;
    const [cw, ch] = [this._fbWidth * scale, this._fbHeight * scale];
    Object.assign(this._canvas.style, { width: `${cw}px`, height: `${ch}px`, left: `${(w - cw) / 2}px`, top: `${(h - ch) / 2}px` });
  }

  private take(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    const key = (bytes[0] & 1) === 1;
    const timestamp = Number(new DataView(buffer).getBigUint64(1));
    const data = bytes.subarray(9);
    if (key) {
      const codec = codecOf(data);
      if (codec && (codec !== this.codec || !this.decoder || this.decoder.state === "closed")) this.configure(codec);
    }
    // A picture that depends on one this decoder never saw cannot be shown.
    if (this.waiting && !key) return;
    if (!this.decoder || this.decoder.state !== "configured") return;
    // A phone that falls behind skips ahead to a fresh keyframe rather than show the past.
    if (!key && this.decoder.decodeQueueSize > 2) {
      this.waiting = true;
      this.say({ key: true });
      return;
    }
    this.waiting = false;
    this.decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
  }

  private configure(codec: string) {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.codec = codec;
    this.waiting = true;
    this.decoder = new VideoDecoder({
      output: (frame) => this.show(frame),
      error: () => this.again(),
    });
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
  }

  /** After a decoding error: a new decoder, and a keyframe to start it from. */
  private again() {
    this.decoder = null;
    this.codec = "";
    this.waiting = true;
    this.say({ key: true });
  }

  // Only the newest picture is drawn, once per display frame; one that is overtaken is dropped.
  private show(frame: VideoFrame) {
    this.latest?.close();
    this.latest = frame;
    if (this.painting) return;
    this.painting = requestAnimationFrame(() => {
      this.painting = 0;
      const frame = this.latest;
      this.latest = null;
      if (!frame) return;
      this.context?.drawImage(frame, 0, 0, this._canvas.width, this._canvas.height);
      frame.close();
    });
  }

  private say(message: object) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** A position in the drawing's CSS pixels, as the trackpad gives it. */
  _sendMouse(x: number, y: number, mask: number) {
    if (this.viewOnly) return;
    const scale = this._canvas.offsetWidth / this._fbWidth || 1;
    this.say({ p: [Math.round(x / scale), Math.round(y / scale), mask] });
  }

  sendKey(keysym: number, _code: string | null, down?: boolean) {
    if (this.viewOnly) return;
    if (down === undefined) {
      this.say({ k: [keysym, true] });
      this.say({ k: [keysym, false] });
    } else this.say({ k: [keysym, down] });
  }

  /** Video asks for no login. */
  sendCredentials() {}

  disconnect() {
    this.socket.close();
    this.end();
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.fit.disconnect();
    cancelAnimationFrame(this.painting);
    this.latest?.close();
    if (this.decoder?.state !== "closed") this.decoder?.close();
    this._canvas.remove();
    this.onEnd();
  }
}
