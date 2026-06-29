// src/services/dj-commentary.ts
//
// Generates short DJ intro lines using a SELF-HOSTED LLM via Ollama
// (https://ollama.com) instead of a paid API. Ollama exposes a chat
// endpoint at http://<host>:11434/api/chat — point OLLAMA_BASE_URL at
// the sibling `ollama` container (see docker-compose-additions.yml) or
// at a machine on your network with a GPU, if you have one. CPU-only
// is fine for a 3-4B model generating one short line.
//
// Recommended model: llama3.2:3b or gemma3:4b — both run comfortably
// without a GPU and are more than capable of a 20-word DJ one-liner.
// Pull it once with: `docker compose exec ollama ollama pull llama3.2:3b`
 
import {injectable} from 'inversify';
import {PrismaClient} from '@prisma/client';
 
const prisma = new PrismaClient();
 
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
 
const PERSONA_PROMPTS: Record<string, string> = {
  hype: 'You are an energetic, upbeat radio DJ hyping up the next song. Keep it fun and high-energy.',
  chill: 'You are a relaxed, low-key late-night radio DJ. Calm, smooth, a little laid-back humor.',
  sarcastic: 'You are a witty, sarcastic radio DJ who teases the song choice playfully without being mean.',
};
 
export interface CommentaryContext {
  upcomingTitle: string;
  upcomingArtist: string;
  previousTitle?: string;
  previousArtist?: string;
  persona: string;
}
 
interface OllamaChatResponse {
  message?: {content?: string};
}
 
@injectable()
export default class DjCommentary {
  async generate(ctx: CommentaryContext): Promise<string> {
    const systemPrompt = PERSONA_PROMPTS[ctx.persona] ?? PERSONA_PROMPTS.hype;
 
    const userPrompt = `
Upcoming track: "${ctx.upcomingTitle}" by ${ctx.upcomingArtist}
${ctx.previousTitle ? `Previous track: "${ctx.previousTitle}" by ${ctx.previousArtist}` : 'This is the first track of the session.'}
 
Write a single short DJ intro line (max 20 words) to say right before this track plays.
Don't use quotation marks. Don't say "now playing" every time — vary the phrasing.
Respond with ONLY the line, nothing else.
`.trim();
 
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            {role: 'system', content: systemPrompt},
            {role: 'user', content: userPrompt},
          ],
          stream: false,
          options: {
            num_predict: 60, // keep responses short — this isn't a chat session
            temperature: 0.9, // a bit of variety is good for DJ chatter
          },
        }),
      });
 
      if (!res.ok) {
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
      }
 
      const data = await res.json() as OllamaChatResponse;
      const text = data.message?.content?.trim();
 
      return text || this.fallback(ctx);
    } catch (error) {
      // Ollama being down/unreachable should never block music playback —
      // fall back to a plain templated line instead of throwing.
      console.warn('[DJ] Ollama commentary generation failed, using fallback:', error);
      return this.fallback(ctx);
    }
  }
 
  async generateAndLog(guildId: string, youtubeId: string, ctx: CommentaryContext): Promise<string> {
    const text = await this.generate(ctx);
 
    await prisma.djCommentaryLog.create({
      data: {guildId, youtubeId, text},
    });
 
    return text;
  }
 
  private fallback(ctx: CommentaryContext): string {
    return `Up next: ${ctx.upcomingTitle} by ${ctx.upcomingArtist}.`;
  }
}
