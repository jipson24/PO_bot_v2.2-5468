import { expect, test } from "bun:test";
import { pocketUserAgent, sessionUserAgent } from "./po-session";
import { setEnvOverride } from "../env";

const auth = (ua: string) => '42' + JSON.stringify(["auth", {
  session: `a:4:{s:10:"user_agent";s:${ua.length}:"${ua}";}`, uid: 125292247, isDemo: 0,
}]);

test("UA follows SSID immediately and after reloading persisted SSID", () => {
  const previous = process.env.POCKET_OPTION_SSID;
  try {
    setEnvOverride("POCKET_OPTION_UA", "old-browser");
    setEnvOverride("POCKET_OPTION_SSID", auth("Firefox/157.0"));
    expect(pocketUserAgent()).toBe("Firefox/157.0");
    setEnvOverride("POCKET_OPTION_SSID", auth("Firefox/158.0"));
    expect(pocketUserAgent()).toBe("Firefox/158.0");
    setEnvOverride("POCKET_OPTION_SSID", null);
    process.env.POCKET_OPTION_SSID = auth("Firefox/158.0");
    expect(pocketUserAgent()).toBe("Firefox/158.0");
  } finally {
    setEnvOverride("POCKET_OPTION_UA", null);
    setEnvOverride("POCKET_OPTION_SSID", null);
    if (previous === undefined) delete process.env.POCKET_OPTION_SSID;
    else process.env.POCKET_OPTION_SSID = previous;
  }
});

test("malformed input and header injection are not used as UA", () => {
  expect(sessionUserAgent("broken")).toBeUndefined();
  expect(sessionUserAgent(auth("Firefox\r\nInjected: yes"))).toBeUndefined();
  expect(sessionUserAgent('42["auth",{"sessionToken":"other"}]')).toBeUndefined();
});