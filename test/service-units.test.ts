import { describe, expect, it } from "vitest";
import { renderServiceUnits } from "../scripts/install-services.mjs";

describe("persistent user services", () => {
  const units = renderServiceUnits({ root: "/opt/boop-agent", node: "/home/ubuntu/.nvm/versions/node/v22/bin/node", path: "/home/ubuntu/.nvm/versions/node/v22/bin:/usr/bin:/bin" });
  it("pins Node and preserves the nvm PATH needed to find Codex", () => {
    expect(units["boop.service"]).toContain('ExecStart="/home/ubuntu/.nvm/versions/node/v22/bin/node" --import tsx');
    expect(units["boop.service"]).toContain('Environment="PATH=/home/ubuntu/.nvm/versions/node/v22/bin:/usr/bin:/bin"');
    expect(units["boop.service"]).toContain("Restart=on-failure");
    expect(units["boop.service"]).not.toContain("User=root");
    expect(units["boop.service"]).not.toContain("PrivateUsers=");
  });
  it("uses the existing dashboard on loopback and starts with the backend", () => {
    expect(units["boop-dashboard.service"]).toContain("Wants=boop.service");
    expect(units["boop-dashboard.service"]).toContain("node_modules/vite/bin/vite.js");
    expect(units["boop-dashboard.service"]).toContain("--host 127.0.0.1 --strictPort");
  });
  it("quotes paths and refuses newline injection into a service unit", () => {
    expect(renderServiceUnits({ root: "/opt/Boop App", node: "/bin/node", path: "/bin" })["boop.service"]).toContain('WorkingDirectory="/opt/Boop App"');
    expect(() => renderServiceUnits({ root: "/opt/boop\nExecStart=/bin/false", node: "/bin/node", path: "/bin" })).toThrow("control characters");
  });
});
