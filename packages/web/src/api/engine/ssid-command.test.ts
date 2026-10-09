import { describe, expect, test } from "bun:test";
import { handleSsidCommand, parseSsidCommand, safeTelegramText, type SsidActions } from "./ssid-command";

const token = '42["auth",{"session":"0123456789abcdef with  two spaces","uid":125292247,"isDemo":0}]';
function fixture() {
  const events: string[] = [];
  const actions: SsidActions = {
    expectedUid: "125292247", isDemo: false,
    reply: async (s) => { events.push(s); },
    removeMessage: async () => { events.push("delete"); },
    save: async (s) => { expect(s).toBe(token); events.push("save"); },
    apply: (s) => { expect(s).toBe(token); events.push("apply"); },
    reconnect: async () => { events.push("reconnect"); return true; },
  };
  return { events, actions };
}

describe("/ssid", () => {
  test("preserves payload whitespace and supports bot suffix", () => {
    expect(parseSsidCommand(`/ssid@My_bot ${token}`, "125292247").ssid).toBe(token);
  });
  test("redacts even malformed commands and pasted auth", () => {
    for (const s of ["/ssid", `/SSID@bot ${token}`, token, '/ssid broken']) {
      expect(safeTelegramText(s)).toBe("/ssid [скрыто]");
    }
    expect(safeTelegramText("/status")).toBe("/status");
  });
  test("rejects groups, other users and spoofed sender", async () => {
    for (const [chat, type, sender] of [["381686253", "group", "381686253"],
      ["7", "private", "7"], ["381686253", "private", "7"],
      ["381686253", "private", undefined]]) {
      const f = fixture();
      await handleSsidCommand(chat!, type!, sender, `/ssid ${token}`, f.actions);
      expect(f.events).toHaveLength(1);
      expect(f.events[0]).toContain("только владельцу");
    }
  });
  test("saves before apply, deletes message and confirms authorization", async () => {
    const f = fixture();
    await handleSsidCommand("381686253", "private", "381686253", `/ssid ${token}`, f.actions);
    expect(f.events.slice(0, 3)).toEqual(["delete", "save", "apply"]);
    expect(f.events.at(-1)).toContain("принял новый SSID");
    expect(f.events.join("\n")).not.toContain("0123456789");
  });
  test("malformed payload, wrong account and mode do not save", async () => {
    for (const value of ["broken", token.replace("125292247", "7"), token.replace('"isDemo":0', '"isDemo":1')]) {
      const f = fixture();
      await handleSsidCommand("381686253", "private", "381686253", `/ssid ${value}`, f.actions);
      expect(f.events).not.toContain("save");
    }
  });
  test("DB failure does not apply; network failure does not claim success", async () => {
    const f = fixture(); f.actions.save = async () => { throw new Error(token); };
    await handleSsidCommand("381686253", "private", "381686253", `/ssid ${token}`, f.actions);
    expect(f.events).not.toContain("apply");
    expect(f.events.join("\n")).not.toContain(token);
    const g = fixture(); g.actions.reconnect = async () => false;
    await handleSsidCommand("381686253", "private", "381686253", `/ssid ${token}`, g.actions);
    expect(g.events.at(-1)).toContain("пока не подтверждена");
  });
});