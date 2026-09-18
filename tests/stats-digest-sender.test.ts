import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';
import {deliverDigest} from '../src/services/stats-digest-sender.js';

const makeEmbed = () => ({toJSON: () => ({title: 'digest'})} as never);

describe('deliverDigest', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the embed to the webhook URL when one is configured', async () => {
    await deliverDigest(null, 'guild-1', makeEmbed(), {webhookUrl: 'https://discord.test/webhook', dmOwner: false});

    expect(fetchMock).toHaveBeenCalledWith('https://discord.test/webhook', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({embeds: [{title: 'digest'}]}),
    }));
  });

  it('does not call fetch when no webhook is configured', async () => {
    await deliverDigest(null, 'guild-1', makeEmbed(), {webhookUrl: null, dmOwner: false});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows a webhook failure instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(deliverDigest(null, 'guild-1', makeEmbed(), {webhookUrl: 'https://discord.test/webhook', dmOwner: false}))
      .resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('opens a DM with the guild owner and sends the embed there when dmOwner is set', async () => {
    const rest = {
      get: vi.fn().mockResolvedValue({owner_id: 'owner-1'}),
      post: vi.fn()
        .mockResolvedValueOnce({id: 'dm-channel-1'}) // open DM
        .mockResolvedValueOnce(undefined), // send message
    };

    await deliverDigest(rest as never, 'guild-1', makeEmbed(), {webhookUrl: null, dmOwner: true});

    expect(rest.get).toHaveBeenCalledWith('/guilds/guild-1');
    expect(rest.post).toHaveBeenNthCalledWith(1, '/users/@me/channels', {body: {recipient_id: 'owner-1'}});
    expect(rest.post).toHaveBeenNthCalledWith(2, '/channels/dm-channel-1/messages', {body: {embeds: [{title: 'digest'}]}});
  });

  it('does not attempt a DM when dmOwner is set but no REST client is given', async () => {
    await expect(deliverDigest(null, 'guild-1', makeEmbed(), {webhookUrl: null, dmOwner: true})).resolves.toBeUndefined();
  });

  it('swallows a DM failure instead of throwing', async () => {
    const rest = {get: vi.fn().mockRejectedValue(new Error('forbidden'))};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(deliverDigest(rest as never, 'guild-1', makeEmbed(), {webhookUrl: null, dmOwner: true}))
      .resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
