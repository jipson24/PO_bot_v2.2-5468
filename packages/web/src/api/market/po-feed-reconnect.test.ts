import { expect, mock, test } from "bun:test";

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  readyState = 1;
  binaryType = "arraybuffer";
  constructor() {
    super(); sockets.push(this);
    setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
      data: '42["successauth",{}]',
    })), 10);
  }
  send() {}
  close() { this.readyState = 3; setTimeout(() => this.dispatchEvent(new Event("close")), 20); }
  terminate() { this.close(); }
}
mock.module("../env", () => ({
  WS: FakeSocket,
  envStr: (key: string, fallback = "") => key === "POCKET_OPTION_SSID"
    ? '42["auth",{"session":"synthetic-only"}]' : fallback,
  envFlag: () => true,
}));

test("hot reconnect authorizes new socket and ignores delayed old close", async () => {
  const feed = await import("./po-feed");
  expect(await feed.reconnectFeed(1000)).toBe(true);
  const first = sockets[0]!;
  expect(feed.feedState().state).toBe("live");
  expect(await feed.reconnectFeed(1000)).toBe(true);
  expect(first.readyState).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sockets).toHaveLength(2);
  expect(feed.feedState().state).toBe("live");
  expect(feed.feedState().authedAt).toBeGreaterThan(0);
});