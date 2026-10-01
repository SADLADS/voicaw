import { describe, it, expect } from 'vitest';
import { continuesGroup } from './messageGroups';

const at = (h, m) => new Date(2026, 8, 30, h, m).getTime() / 1000;
const msg = (over) => ({ id: 1, sender_id: 1, timestamp: at(12, 0), ...over });

describe('continuesGroup', () => {
  it("joins the same person's next message within 7 minutes", () => {
    expect(continuesGroup(msg(), msg({ timestamp: at(12, 6) }))).toBe(true);
    expect(continuesGroup(msg(), msg({ timestamp: at(12, 7) }))).toBe(false);
  });

  it("doesn't join someone else, a reply, the first row, system lines or across midnight", () => {
    expect(continuesGroup(msg(), msg({ sender_id: 2 }))).toBe(false);
    expect(continuesGroup(msg(), msg({ parent_message_id: 5 }))).toBe(false);
    expect(continuesGroup(undefined, msg())).toBe(false);
    expect(continuesGroup({ system: true, timestamp: at(12, 0) }, msg())).toBe(false);
    expect(continuesGroup(msg({ timestamp: at(23, 58) }), msg({ timestamp: at(23, 58) + 180 }))).toBe(false);
  });

  it('never groups a group DM message whose sender is not verified, or joins one', () => {
    expect(continuesGroup(msg(), msg({ unverified: true }))).toBe(false);
    expect(continuesGroup(msg({ unverified: true }), msg())).toBe(false);
    expect(continuesGroup(msg(), msg({ unsigned: true }))).toBe(false);
  });

  it("groups a webhook's messages only with the same webhook, name and picture", () => {
    const hook = (over) => msg({ sender_id: 0, webhook_id: 5, webhook_name: 'CI', webhook_avatar: null, ...over });
    expect(continuesGroup(hook(), hook({ timestamp: at(12, 1) }))).toBe(true);
    expect(continuesGroup(hook(), hook({ webhook_id: 6 }))).toBe(false);
    expect(continuesGroup(hook(), hook({ webhook_name: 'Deploys' }))).toBe(false);
    expect(continuesGroup(hook(), hook({ webhook_avatar: 'https://x.test/a.png' }))).toBe(false);
    expect(continuesGroup(msg({ sender_id: 0 }), hook())).toBe(false);
  });
});
