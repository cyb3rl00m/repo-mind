# Installation (CachyOS first)

RepoMind installs **per user**. Nothing is installed system-wide and the installer never uses `sudo`; when a system package is missing it prints the `pacman` command for you to run.

## 1. Dependencies

```bash
# required
sudo pacman -S --needed nodejs npm git
# optional
sudo pacman -S --needed libsecret        # store a private-repo GitHub token in the keyring
sudo pacman -S --needed kdialog          # native folder picker on KDE (zenity on GNOME)
sudo pacman -S --needed jdk17-openjdk    # Android/Gradle builds (match your project's JDK)
```

Node.js 20 or newer is required. For Android builds you also need the Android SDK (usually installed by Android Studio) with `ANDROID_HOME` set, or `sdk.dir` in the project's `local.properties`.

**Keyring:** `secret-tool` talks to the Secret Service API. On KDE Plasma enable it in *System Settings → KDE Wallet* (or install `gnome-keyring`). Without a keyring RepoMind keeps a token only in browser session memory.

## 2. Build and install the engine

```bash
git clone https://github.com/cyb3rl00m/repo-mind.git
cd repo-mind
./scripts/install.sh
```

The installer:

1. checks Node.js, git and optional tools;
2. runs `npm ci && npm run build` (skip with `--no-build`);
3. copies the engine to `~/.local/share/repomind/engine/` with a launcher that pins your absolute Node.js path (Chrome starts native hosts without your shell's `PATH`) and links `~/.local/bin/repomind-engine`;
4. writes `com.repomind.engine.json` into `NativeMessagingHosts/` for every Chromium-based browser profile it finds (Chrome, Chrome Beta/Dev, Chromium, Brave, Vivaldi, Edge). Force one with `--browser chrome` (or `chromium`, `brave`, `vivaldi`, `edge`, `all`);
5. runs `repomind-engine --doctor`.

## 3. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`, …).
2. Enable **Developer mode**.
3. **Load unpacked** → select `repo-mind/packages/extension/dist`.
4. Verify the ID is **`ddblnfbnekcpcpnnbeioffideiikfgmp`**. The host manifest only allows this ID.
5. Pin the RepoMind icon; clicking it opens the side panel.

## 4. Tests

```bash
repomind-engine --doctor           # dependency checks + host registration + toolchains
node scripts/selftest.mjs          # extension↔engine protocol, git integration, Android Gradle detection, command approval
```

The self-test uses temporary directories only. In the extension, the **Engine** pill in the top bar turns green when connected; *Settings → Local engine* shows versions and paths.

**Android Gradle detection test:** open your Android project in *Repositories*, go to *Build & Test*: you should see `./gradlew test`, `assembleDebug`, `lint` and `compileDebugKotlin`, plus the Java/Android SDK status. Run `assembleDebug` after confirming the dialog.

## Engine configuration (optional)

`~/.config/repomind/engine.json`:

```json
{
  "env": { "ANDROID_HOME": "/home/you/Android/Sdk", "JAVA_HOME": "/usr/lib/jvm/java-17-openjdk" },
  "importShellEnv": true,
  "maxOutputBytes": 2097152,
  "defaultTimeoutMs": 1200000,
  "allowedOrigins": []
}
```

`importShellEnv` runs your login shell once (`$SHELL -l -c 'env -0'`, works with fish/bash/zsh) so build commands see the same `PATH`, `ANDROID_HOME` and `JAVA_HOME` as your terminal. Only an allow-list of variables (paths, SDK/toolchain homes, proxies, locale) is passed to commands.

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Local engine is not installed or not registered” | Run `./scripts/install.sh`; restart the browser; check the browser's config folder name matches one the installer knows (`--browser`). |
| “host manifest does not allow this extension ID” | The extension was loaded with a different ID (e.g. packed with another key). Use the unpacked `dist` folder or add the ID to `allowedOrigins` **and** to the host manifest. |
| Engine exits immediately | `repomind-engine --doctor`; read `~/.local/state/repomind/engine.log`. |
| Gradle cannot find the SDK | Set `ANDROID_HOME` in `engine.json` `env`, or `sdk.dir` in `local.properties`. |
| Keyring unavailable | Install `libsecret`, enable KWallet's Secret Service or `gnome-keyring`, then reopen Settings. |
| Folder picker missing | Install `kdialog` or `zenity`, or type the absolute path. |

## Updating

```bash
git pull && ./scripts/install.sh
```
then press the reload icon of RepoMind in `chrome://extensions`. Both sides must speak the same protocol version; the extension reports a mismatch explicitly.

## Uninstalling

```bash
./scripts/uninstall.sh            # engine + host registrations
./scripts/uninstall.sh --purge    # also config, logs and (empty) worktree storage
```
Remove the extension in `chrome://extensions` (deletes its IndexedDB data). If you stored a token: `secret-tool clear service repomind account github-token`, and revoke it at <https://github.com/settings/personal-access-tokens>.

## Other platforms

Windows and macOS are not supported yet. The OS-specific parts (host registration, keyring, folder picker, shell environment) are isolated so they can be added; see [ARCHITECTURE.md](ARCHITECTURE.md#engine-architecture).
