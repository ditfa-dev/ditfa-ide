import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { delimiter, join } from "node:path";

/** 16 kHz little-endian PCM16 mono frames, wherever they come from. */
export interface Microphone {
  readonly source: "system" | "browser";
  start(onFrame: (pcm: Uint8Array) => void, onEnded: (reason: string | null) => void): Promise<void>;
  stop(): void;
}

function onPath(binary: string): string | null {
  const names = process.platform === "win32" ? [`${binary}.exe`, binary] : [binary];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (process.platform !== "win32" && existsSync(join(dir, binary))) return join(dir, binary);
  }
  return null;
}

/**
 * The machine's own recorder, when one is installed: `sox` (any OS) or `ffmpeg` (with the platform's capture
 * device). No window opens; the OS may ask once for microphone permission for the editor.
 */
export function systemMicrophone(): Microphone | null {
  const sox = onPath("sox");
  const ffmpeg = onPath("ffmpeg");
  const raw = ["-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16", "-c", "1", "-"];
  let command: { bin: string; args: string[] } | null = null;
  if (sox) {
    command = { bin: sox, args: ["-q", "-d", ...raw] };
  } else if (ffmpeg) {
    const input =
      process.platform === "darwin"
        ? ["-f", "avfoundation", "-i", ":0"]
        : process.platform === "win32"
          ? ["-f", "dshow", "-i", "audio=default"]
          : ["-f", "pulse", "-i", "default"];
    command = { bin: ffmpeg, args: ["-hide_banner", "-loglevel", "error", ...input, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"] };
  }
  if (!command) return null;
  const { bin, args } = command;
  let child: ChildProcess | null = null;
  return {
    source: "system",
    async start(onFrame, onEnded) {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => onFrame(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-400);
      });
      child.on("error", (error) => onEnded(error.message));
      child.on("exit", (code) => onEnded(code === 0 || code === null ? null : stderr.trim() || `recorder exited with ${code}`));
    },
    stop() {
      child?.kill();
      child = null;
    },
  };
}

const PAGE = (token: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; connect-src 'self'">
<title>Ditfa voice</title><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:15px system-ui,sans-serif;background:#04070d;color:#e8eef6}
.card{text-align:center;max-width:340px;padding:24px}.orb{width:88px;height:88px;margin:0 auto 18px;border-radius:50%;background:linear-gradient(160deg,#7cc0ec,#4f94c5 45%,#1d3a73);transition:transform .08s}
button{margin-top:14px;padding:8px 18px;border:0;border-radius:8px;background:#4f94c5;color:#fff;font:inherit;cursor:pointer}small{color:#8ea2b8}</style></head>
<body><div class="card"><div class="orb" id="orb"></div><div id="text">Allow the microphone to talk to Ditfa Code.</div>
<button id="go">Start</button><p><small>Keep this window open while you talk. Your editor shows what Ditfa hears.</small></p></div>
<script nonce="${token}">
const T=${JSON.stringify(token)};let ctx,stream,node;const text=document.getElementById("text"),orb=document.getElementById("orb");
async function start(){try{stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}})}catch(e){text.textContent="The microphone is blocked: "+e.message;return}
document.getElementById("go").remove();text.textContent="Listening… talk in your editor's voice mode.";ctx=new AudioContext();const src=ctx.createMediaStreamSource(stream);node=ctx.createScriptProcessor(4096,1,1);
const ratio=ctx.sampleRate/16000;let pos=0;node.onaudioprocess=e=>{const input=e.inputBuffer.getChannelData(0);const out=[];let sum=0;while(pos+ratio<=input.length){const a=Math.floor(pos),b=Math.max(a+1,Math.floor(pos+ratio));let acc=0;for(let i=a;i<b;i++)acc+=input[i];const s=acc/(b-a);out.push(s);sum+=s*s;pos+=ratio}pos=Math.max(0,pos-input.length);
orb.style.transform="scale("+(1+Math.min(.3,Math.sqrt(sum/Math.max(1,out.length))*3))+")";const buf=new DataView(new ArrayBuffer(out.length*2));out.forEach((s,i)=>{const c=Math.max(-1,Math.min(1,s));buf.setInt16(i*2,c<0?c*32768:c*32767,true)});
fetch("/audio?t="+T,{method:"POST",body:buf.buffer}).then(r=>{if(r.status===410){stop("Voice mode ended. You can close this window.")}}).catch(()=>{})};src.connect(node);node.connect(ctx.destination)}
function stop(msg){node&&node.disconnect();stream&&stream.getTracks().forEach(t=>t.stop());text.textContent=msg}
document.getElementById("go").onclick=start;
</script></body></html>`;

/**
 * A small page in the user's browser, served from 127.0.0.1 with a one-time token: browsers grant the microphone
 * to a local page when the editor's panel cannot have it. The page posts audio back to this server only.
 */
export function browserMicrophone(openExternal: (url: string) => Promise<boolean>): Microphone {
  let server: Server | null = null;
  let closed = false;
  return {
    source: "browser",
    async start(onFrame, onEnded) {
      const token = randomBytes(24).toString("base64url");
      closed = false;
      server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        // Only this page may talk to the server: right token, and no other site's origin.
        const origin = request.headers.origin;
        if (url.searchParams.get("t") !== token || (origin && origin !== `http://127.0.0.1:${port()}`)) {
          response.writeHead(403).end();
          return;
        }
        if (request.method === "GET" && url.pathname === "/") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(PAGE(token));
          return;
        }
        if (request.method === "POST" && url.pathname === "/audio") {
          if (closed) {
            response.writeHead(410).end();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          request.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 64_000) chunks.push(chunk);
          });
          request.on("end", () => {
            const body = Buffer.concat(chunks);
            if (body.length > 0) onFrame(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
            response.writeHead(204).end();
          });
          return;
        }
        response.writeHead(404).end();
      });
      const port = () => {
        const address = server?.address();
        return typeof address === "object" && address ? address.port : 0;
      };
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(0, "127.0.0.1", () => resolve());
      });
      server.on("close", () => onEnded(null));
      const opened = await openExternal(`http://127.0.0.1:${port()}/?t=${token}`);
      if (!opened) onEnded("Could not open the browser for the microphone.");
    },
    stop() {
      closed = true;
      // Let the page see 410 once, then close.
      const current = server;
      server = null;
      setTimeout(() => current?.close(), 1500);
    },
  };
}
