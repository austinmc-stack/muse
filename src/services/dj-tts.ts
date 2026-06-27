// Renders DJ commentary text to audio via a self-hosted Kokoro-FastAPI
// server (https://github.com/remsky/Kokoro-FastAPI) — a free, Apache
// 2.0-licensed, OpenAI-compatible TTS server wrapping the Kokoro-82M
// model. Runs fine on CPU for this volume of usage (one short line
// every few tracks); add the GPU image instead only if you already
// have a free NVIDIA GPU and want faster cold starts.
//
// Add the `kokoro` service from docker-compose-additions.yml to your
// compose file — no separate pull/setup step needed, the Docker image
// ships with model weights baked in.
 
import {inject, injectable} from 'inversify';
import {existsSync, mkdirSync, promises as fs} from 'fs';
import {join} from 'path';
import crypto from 'crypto';
import {TYPES} from '../types.js';
import Config from './config.js';
 
const KOKORO_BASE_URL = process.env.KOKORO_BASE_URL ?? 'http://kokoro:8880';
const DEFAULT_KOKORO_VOICE = process.env.KOKORO_VOICE ?? 'af_heart';
 
@injectable()
export default class DjTts {
  private readonly cacheDir: string;
 
  constructor(@inject(TYPES.Config) private readonly config: Config) {
    this.cacheDir = join(this.config.DATA_DIR, 'dj-tts-cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, {recursive: true});
    }
  }
 
  /**
   * Renders text to a cached mp3 file via Kokoro, returning its path.
   * `voiceId` is a Kokoro voice name (e.g. "af_heart", "am_adam", or a
   * weighted combo like "af_sky+af_bella") — see GET /v1/audio/voices
   * on your running Kokoro instance for the full list.
   */
  async renderToFile(text: string, voiceId?: string | null): Promise<string> {
    const voice = voiceId ?? DEFAULT_KOKORO_VOICE;
    const key = crypto.createHash('sha256').update(`${voice}:${text}`).digest('hex');
    const filePath = join(this.cacheDir, `${key}.mp3`);
 
    if (existsSync(filePath)) {
      return filePath;
    }
 
    const res = await fetch(`${KOKORO_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: 'kokoro', // required by the OpenAI-compatible schema, unused otherwise
        voice,
        input: text,
        response_format: 'mp3',
      }),
    });
 
    if (!res.ok) {
      throw new Error(`Kokoro TTS request failed: ${res.status} ${res.statusText}`);
    }
 
    // Deliberately NOT using Readable.fromWeb(res.body) here — its types
    // are inconsistently declared across @types/node versions (missing
    // entirely on older versions, incompatible with the DOM ReadableStream
    // type on others — a long-standing, widely-reported TS/Node typing
    // issue, not something specific to this code). res.arrayBuffer() sidesteps
    // it completely. These TTS responses are a few seconds of speech at
    // most, so buffering the whole thing in memory before writing is fine.
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(filePath, audioBuffer);
 
    return filePath;
  }
}

