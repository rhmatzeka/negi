// The VNC client ships no types. These are the parts this app uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, channel: WebSocket | string, options?: { credentials?: Record<string, string> });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    /** 0 to 9: how much picture quality to ask for; lower is faster. */
    qualityLevel: number;
    /** 0 to 9: how hard the host should compress; higher sends less. */
    compressionLevel: number;
    clipViewport: boolean;
    dragViewport: boolean;
    showDotCursor: boolean;
    /** Presses (`down` true), releases (false) or taps (omitted) the key with this X11 keysym. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCredentials(credentials: Record<string, string>): void;
    disconnect(): void;
    focus(): void;
  }
}
