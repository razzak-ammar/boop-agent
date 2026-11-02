import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../server/convex-client.js", () => ({ convex: { mutation: vi.fn() } }));
vi.mock("../server/embeddings.js", () => ({ embed: vi.fn().mockResolvedValue(null) }));
import { convex } from "../server/convex-client.js";
import { parseRememberCommand, storeRawNote } from "../server/memory/note-intake.js";
describe("explicit note intake", () => {
  beforeEach(() => vi.clearAllMocks());
  it("preserves complete multiline input and only handles the explicit command", () => {
    expect(parseRememberCommand('/remember My name is Mira.\nI use Google Calendar.')).toBe('My name is Mira.\nI use Google Calendar.');
    expect(parseRememberCommand('/remember@boop_bot note')).toBe('note');
    expect(parseRememberCommand('/remember')).toBe('');
    expect(parseRememberCommand('Please remember my name.')).toBeNull();
    expect(parseRememberCommand('/remembering details')).toBeNull();
  });
  it("persists all text before emitting the saved event, even without embeddings", async () => {
    await storeRawNote('conversation', 'turn_test', 'First fact.\nSecond fact.');
    expect(vi.mocked(convex.mutation).mock.calls[0][1]).toMatchObject({
      collection:'Notes', content:'First fact.\nSecond fact.',
      sourceConversationId:'conversation', sourceKey:'remember:conversation:turn_test',
    });
    expect(vi.mocked(convex.mutation).mock.calls[1][1]).toMatchObject({eventType:'saved.written'});
  });
  it("propagates storage failures so the caller cannot acknowledge an unsaved note", async () => {
    vi.mocked(convex.mutation).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(storeRawNote('conversation', 'turn_failed', 'Keep this')).rejects.toThrow('storage unavailable');
    expect(convex.mutation).toHaveBeenCalledTimes(1);
  });
});
