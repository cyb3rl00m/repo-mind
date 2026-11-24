# Installation (all Linux distributions)

RepoMind installs **per user**. Nothing is installed system-wide and the installer never uses `sudo`; when a system package is missing it detects your package manager (pacman, apt, dnf or zypper) and prints the command for you to run.

The short, step-by-step tutorial for every distribution is in the [README](README.md#-installation). This page adds details and troubleshooting.

## 1. Dependencies

Node.js **20 or newer** and git are required. `npm` is only needed when building from source.

| | Arch / CachyOS / Manjaro / EndeavourOS | Debian / Ubuntu / Mint / Pop!_OS | Fedora / Nobara | openSUSE |
|---|---|---|---|---|
| Node.js (required) | `nodejs` | `nodejs` (or NodeSource, see below) | `nodejs` | `nodejs22` |
| git (required) | `git` | `git` | `git` | `git` |
| npm (source builds) | `npm` | `npm` | `npm` | `npm22` |
| keyring CLI `secret-tool` | `libsecret` | `libsecret-tools` | `libsecret` | `secret-tool` |
| folder picker | `kdialog` / `zenity` | `kdialog` / `zenity` | `kdialog` / `zenity` | `kdialog` / `zenity` |
| JDK for Android builds | `jdk17-openjdk` | `openjdk-17-jdk` | `java-17-openjdk-devel` | `java-17-openjdk-devel` |

```bash
# Arch / CachyOS / Manjaro / EndeavourOS
sudo pacman -S --needed nodejs git libsecret kdialog
# Debian / Ubuntu / Mint / Pop!_OS
sudo apt install nodejs git libsecret-tools zenity
# Fedora / Nobara
sudo dnf install nodejs git libsecret zenity
# openSUSE
sudo zypper install nodejs22 git secret-tool zenity
```

**Old Node.js on Debian/Ubuntu.** Debian 12, Ubuntu 22.04/24.04 and Linux Mint 21/22 ship Node.js 18 or older. Check with `node --version`; if it is below v20, install Node.js 22 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
```

Alternatives on any distribution: the prebuilt binaries from <https://nodejs.org/en/download> or [nvm](https://github.com/nvm-sh/nvm). The installer records the absolute path of the `node` it finds, so the engine keeps using the same Node even when Chrome starts it without your shell's `PATH`. If you switch Node versions with nvm later, run the installer again.

For Android builds you also need the Android SDK (usually installed by Android Studio) with `ANDROID_HOME` set, or `sdk.dir` in the project's `local.properties`.

**Keyring:** `secret-tool` talks to the Secret Service API. GNOME (Ubuntu, Fedora Workstation, Pop!_OS) provides it through GNOME Keyring out of the box. On KDE Plasma enable it in *System Settings → KDE Wallet* (or install `gnome-keyring`). Without a keyring RepoMind keeps a token only in browser session memory.

**Browser:** use a natively packaged Chromium-based browser (Chrome `.deb`/`.rpm`/AUR, distro Chromium on Arch/Fedora/openSUSE/Debian, Brave, Vivaldi, Edge). Snap and Flatpak browsers load the extension but their sandbox cannot start the local engine. Ubuntu's `chromium` package is a Snap — install Google Chrome instead.

## 2. Get RepoMind

**Prebuilt release (no npm needed):**

```bash
curl -L -o /tmp/repomind.tar.gz https://github.com/cyb3rl00m/repo-mind/releases/latest/download/repomind-prebuilt.tar.gz
tar -xzf /tmp/repomind.tar.gz -C ~      # creates ~/repomind
cd ~/repomind && ./scripts/install.sh --no-build
```

The archive contains the built extension, the built engine and the scripts. A `.sha256` checksum is attached to every release.

**Or from source** (needs `npm`), as below.

## 2b. Build and install the engine from source

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
