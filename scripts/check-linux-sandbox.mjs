import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.platform !== "linux") {
  console.log("This check is for the Linux server. macOS uses its own sandbox.");
} else {
  const release = readFileSync("/etc/os-release", "utf8");
  console.log(release.split("\n").find((line) => line.startsWith("PRETTY_NAME=")) ?? "Linux");
  const result = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-user", "--", "/bin/true"], { encoding: "utf8", timeout: 5000 });
  if (result.status === 0) {
    console.log("PASS: bubblewrap can create a user namespace as this user.");
  } else {
    process.exitCode = 1;
    if (result.error?.code === "ENOENT") {
      console.error("bubblewrap is missing. Run: sudo apt update && sudo apt install bubblewrap");
    } else {
      console.error("bubblewrap could not create its sandbox:", result.stderr?.trim() || result.error?.message || `exit ${result.status}`);
      console.error(`On Ubuntu 24.04, install and load the distribution's targeted profile:
sudo apt update
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict

Then rerun npm run server:doctor. If the profile file is missing or this still fails,
inspect the kernel/AppArmor log rather than disabling user-namespace restrictions globally:
sudo journalctl -k --since "5 minutes ago" | grep -Ei 'apparmor|denied|userns'
Reference: https://learn.chatgpt.com/docs/sandboxing#prerequisites`);
    }
  }
}
