// Renders WrappedSummary data into PNG card images, Spotify-Wrapped-
// style. Uses @napi-rs/canvas (Skia-backed, prebuilt binaries, no
// Cairo/Pango system deps needed -- confirmed current as of this
// writing, package reached 1.0.0). Uses the async canvas.encode('png')
// API rather than the older synchronous toBuffer('image/png') --
// encoding runs off the main thread, which matters here since this
// process also holds the Discord gateway connection and shouldn't
// block on image encoding.
//
// Generates a SEPARATE PNG per "card" (total minutes, top tracks, top
// artists, genre + personality) rather than one long image, so the
// slash command can present them as a button-paginated carousel.
 
import {injectable} from 'inversify';
import {createCanvas, GlobalFonts} from '@napi-rs/canvas';
import {join} from 'path';
import {existsSync} from 'fs';
import type {WrappedSummary} from './wrapped-service.js';
 
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920; // Instagram-story aspect ratio, matches Spotify Wrapped's own format
 
let fontsRegistered = false;
 
function ensureFontsRegistered(): void {
  if (fontsRegistered) {
    return;
  }
 
  // Bundle a font with the app rather than relying on system fonts --
  // Docker base images (node:*-slim) ship with few/no fonts installed,
  // and canvas text rendering needs at least one registered font or
  // fillText silently renders nothing.
  const fontPath = join(process.cwd(), 'assets', 'fonts', 'Inter-Bold.ttf');
  if (existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, 'Inter');
  } else {
    console.warn(`[Wrapped] font not found at ${fontPath} -- text will fall back to a system default if any is available. See README for the assets/fonts setup step.`);
  }
 
  fontsRegistered = true;
}
 
@injectable()
export default class WrappedCardRenderer {
  async renderCards(summary: WrappedSummary): Promise<Buffer[]> {
    ensureFontsRegistered();
 
    return Promise.all([
      this.renderIntroCard(summary),
      this.renderTopTracksCard(summary),
      this.renderTopArtistsCard(summary),
      this.renderPersonalityCard(summary),
    ]);
  }
 
  private async renderIntroCard(summary: WrappedSummary): Promise<Buffer> {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
 
    this.drawBackground(ctx, '#1DB954', '#191414');
 
    ctx.fillStyle = '#fff';
    ctx.font = '700 72px Inter';
    ctx.fillText(`Your ${summary.year} Wrapped`, 60, 220);
 
    ctx.font = '400 40px Inter';
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(summary.guildId ? 'This server' : 'All servers', 60, 280);
 
    ctx.font = '700 140px Inter';
    ctx.fillStyle = '#fff';
    ctx.fillText(summary.totalMinutesListened.toLocaleString(), 60, 700);
 
    ctx.font = '400 44px Inter';
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText('minutes listened', 60, 760);
 
    ctx.font = '400 36px Inter';
    ctx.fillText(`across ${summary.totalTracksPlayed.toLocaleString()} tracks`, 60, 820);
 
    return Buffer.from(await canvas.encode('png'));
  }
 
  private async renderTopTracksCard(summary: WrappedSummary): Promise<Buffer> {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
 
    this.drawBackground(ctx, '#191414', '#1DB954');
 
    ctx.fillStyle = '#fff';
    ctx.font = '700 64px Inter';
    ctx.fillText('Top Tracks', 60, 180);
 
    if (summary.topTracks.length === 0) {
      ctx.font = '400 36px Inter';
      ctx.fillStyle = '#ccc';
      ctx.fillText('Not enough data yet -- keep listening!', 60, 280);
    } else {
      summary.topTracks.forEach((track, i) => {
        const y = 320 + i * 140;
 
        ctx.font = '700 56px Inter';
        ctx.fillStyle = '#1DB954';
        ctx.fillText(`#${i + 1}`, 60, y);
 
        ctx.font = '700 44px Inter';
        ctx.fillStyle = '#fff';
        this.fillTextTruncated(ctx, track.title, 180, y, CARD_WIDTH - 240);
 
        ctx.font = '400 34px Inter';
        ctx.fillStyle = '#ccc';
        this.fillTextTruncated(ctx, track.artist, 180, y + 50, CARD_WIDTH - 240);
      });
    }
 
    return Buffer.from(await canvas.encode('png'));
  }
 
  private async renderTopArtistsCard(summary: WrappedSummary): Promise<Buffer> {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
 
    this.drawBackground(ctx, '#1DB954', '#191414');
 
    ctx.fillStyle = '#fff';
    ctx.font = '700 64px Inter';
    ctx.fillText('Top Artists', 60, 180);
 
    if (summary.topArtists.length === 0) {
      ctx.font = '400 36px Inter';
      ctx.fillStyle = '#222';
      ctx.fillText('Not enough data yet -- keep listening!', 60, 280);
    } else {
      summary.topArtists.forEach((artist, i) => {
        const y = 320 + i * 140;
 
        ctx.font = '700 56px Inter';
        ctx.fillStyle = '#191414';
        ctx.fillText(`#${i + 1}`, 60, y);
 
        ctx.font = '700 48px Inter';
        ctx.fillStyle = '#fff';
        this.fillTextTruncated(ctx, artist.artist, 180, y, CARD_WIDTH - 240);
 
        ctx.font = '400 32px Inter';
        ctx.fillStyle = '#222';
        ctx.fillText(`${artist.playCount} plays`, 180, y + 50);
      });
    }
 
    return Buffer.from(await canvas.encode('png'));
  }
 
  private async renderPersonalityCard(summary: WrappedSummary): Promise<Buffer> {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
 
    this.drawBackground(ctx, '#191414', '#1DB954');
 
    ctx.fillStyle = '#fff';
    ctx.font = '700 56px Inter';
    ctx.fillText('Your Listening Personality', 60, 180, CARD_WIDTH - 120);
 
    if (summary.topGenre) {
      ctx.font = '400 40px Inter';
      ctx.fillStyle = '#1DB954';
      ctx.fillText(`Top genre: ${summary.topGenre}`, 60, 260);
    }
 
    ctx.font = '700 48px Inter';
    ctx.fillStyle = '#fff';
    this.wrapText(ctx, summary.listeningPersonality, 60, 400, CARD_WIDTH - 120, 60);
 
    return Buffer.from(await canvas.encode('png'));
  }
 
  private drawBackground(ctx: any, colorTop: string, colorBottom: string): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    gradient.addColorStop(0, colorTop);
    gradient.addColorStop(1, colorBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  }
 
  /** Truncates text with an ellipsis if it would overflow maxWidth, rather than letting it run off the card edge. */
  private fillTextTruncated(ctx: any, text: string, x: number, y: number, maxWidth: number): void {
    let displayText = text;
    while (ctx.measureText(displayText).width > maxWidth && displayText.length > 1) {
      displayText = displayText.slice(0, -1);
    }
 
    if (displayText !== text) {
      displayText = displayText.slice(0, -1) + '...';
    }
 
    ctx.fillText(displayText, x, y);
  }
 
  /** Simple word-wrap for the personality blurb, which varies in length. */
  private wrapText(ctx: any, text: string, x: number, y: number, maxWidth: number, lineHeight: number): void {
    const words = text.split(' ');
    let line = '';
    let currentY = y;
 
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (ctx.measureText(testLine).width > maxWidth && line) {
        ctx.fillText(line, x, currentY);
        line = word;
        currentY += lineHeight;
      } else {
        line = testLine;
      }
    }
 
    if (line) {
      ctx.fillText(line, x, currentY);
    }
  }
}
