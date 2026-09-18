import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';
import MessageCleanup from '../src/services/message-cleanup.js';

const getGuildSettings = vi.fn();

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: (...args: unknown[]) => getGuildSettings(...args),
}));

const makeChannel = (guildId = 'guild-1') => {
  let nextId = 0;
  const send = vi.fn().mockImplementation(async () => ({
    id: `msg-${nextId++}`,
    createdTimestamp: Date.now(),
    channel: {bulkDelete},
    delete: vi.fn().mockResolvedValue(undefined),
  }));
  const bulkDelete = vi.fn().mockResolvedValue(undefined);

  return {
    guild: {id: guildId},
    send,
    bulkDelete,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  getGuildSettings.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MessageCleanup', () => {
  it('does not schedule a delete when cleanupMode is NONE', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'NONE', ephemeralDelaySeconds: 45, cleanupOnSessionEnd: true});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    const message = await cleanup.send(channel as never, {content: 'hi'}, 'dj');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(message.delete).not.toHaveBeenCalled();
  });

  it('schedules a delete for a dj message under DJ_ONLY but not a control message', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'DJ_ONLY', ephemeralDelaySeconds: 45, cleanupOnSessionEnd: true});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    const djMessage = await cleanup.send(channel as never, {content: 'dj'}, 'dj');
    const controlMessage = await cleanup.send(channel as never, {content: 'control'}, 'control');

    await vi.advanceTimersByTimeAsync(45_000);

    expect(djMessage.delete).toHaveBeenCalledTimes(1);
    expect(controlMessage.delete).not.toHaveBeenCalled();
  });

  it('schedules a delete for both categories under ALL_BOT_MESSAGES, honoring the configured delay', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'ALL_BOT_MESSAGES', ephemeralDelaySeconds: 10, cleanupOnSessionEnd: true});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    const djMessage = await cleanup.send(channel as never, {content: 'dj'}, 'dj');
    const controlMessage = await cleanup.send(channel as never, {content: 'control'}, 'control');

    await vi.advanceTimersByTimeAsync(9_000);
    expect(djMessage.delete).not.toHaveBeenCalled();
    expect(controlMessage.delete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(djMessage.delete).toHaveBeenCalledTimes(1);
    expect(controlMessage.delete).toHaveBeenCalledTimes(1);
  });

  it('sweeps pending tracked messages on session end without double-deleting', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'ALL_BOT_MESSAGES', ephemeralDelaySeconds: 45, cleanupOnSessionEnd: true});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    const a = await cleanup.send(channel as never, {content: 'a'}, 'dj');
    const b = await cleanup.send(channel as never, {content: 'b'}, 'dj');

    await cleanup.sweep('guild-1');

    expect(channel.bulkDelete).toHaveBeenCalledWith([a.id, b.id]);

    // The per-message timers must have been cancelled by the sweep,
    // so they must not also fire an individual delete afterward.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.delete).not.toHaveBeenCalled();
    expect(b.delete).not.toHaveBeenCalled();
  });

  it('does nothing on sweep when cleanupOnSessionEnd is false', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'ALL_BOT_MESSAGES', ephemeralDelaySeconds: 45, cleanupOnSessionEnd: false});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    await cleanup.send(channel as never, {content: 'a'}, 'dj');
    await cleanup.sweep('guild-1');

    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });

  it('falls back to individual delete when only one message is pending for the sweep', async () => {
    getGuildSettings.mockResolvedValue({cleanupMode: 'ALL_BOT_MESSAGES', ephemeralDelaySeconds: 45, cleanupOnSessionEnd: true});
    const channel = makeChannel();
    const cleanup = new MessageCleanup();

    const a = await cleanup.send(channel as never, {content: 'a'}, 'dj');
    await cleanup.sweep('guild-1');

    expect(channel.bulkDelete).not.toHaveBeenCalled();
    expect(a.delete).toHaveBeenCalledTimes(1);
  });
});
