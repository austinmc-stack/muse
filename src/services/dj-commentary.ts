import {injectable} from 'inversify';
import Anthropic from '@anthropic-ai/sdk';
import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();
const anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

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

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      system: systemPrompt,
      messages: [{role: 'user', content: userPrompt}],
    });

    const block = response.content.find(b => b.type === 'text');
    const text = block && block.type === 'text' ? block.text.trim() : '';

    return text || `Up next: ${ctx.upcomingTitle} by ${ctx.upcomingArtist}.`;
  }

  async generateAndLog(guildId: string, youtubeId: string, ctx: CommentaryContext): Promise<string> {
    const text = await this.generate(ctx);

    await prisma.djCommentaryLog.create({
      data: {guildId, youtubeId, text},
    });

    return text;
  }
}
