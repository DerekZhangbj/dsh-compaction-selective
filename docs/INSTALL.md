# Installing dsh-compaction-selective

Two ways. Both end with the plugin **enabled as a bundle in a DSH profile** — installing the package alone is not enough, because DSH only loads plugins listed in `dsh.profile.bundles`.

Which profile? A DSH install can have several (`~/.dsh/profiles/web`, `~/.dsh/profiles/desktop`, …). The desktop app uses its **own** profile, so if you use both surfaces you install into both.

---

## A. From npm (recommended for a released version)

```text
# 1) inside your profile directory
cd ~/.dsh/profiles/<profile>
npm add dsh-compaction-selective@0.1.8

# 2) enable it as a bundle — edit package.json
"dsh": { "profile": { "bundles": [ "...", "dsh-compaction-selective" ] } }
```

Restart DSH. The plugin shows up under **Plugins**, its settings live on its own detail page.

Pin the version (`@0.1.8`) — npm versions are immutable, and a floating range will silently move you onto a newer release with different behaviour.

## B. From a checkout (for development / trying `main`)

```text
# 1) profile dependency points at your working copy
"dependencies": { "dsh-compaction-selective": "link:<path-to-repo>" }

# 2) enable the bundle
"dsh": { "profile": { "bundles": [ "...", "dsh-compaction-selective" ] } }

# 3) link it into the profile's node_modules
#    Windows:  cmd /c mklink /J <profile>\node_modules\dsh-compaction-selective <path-to-repo>
#    POSIX:    ln -s <path-to-repo> <profile>/node_modules/dsh-compaction-selective
```

With `link:` you are editing the same files DSH reads — a restart picks up changes, no reinstall step.

## After installing

| Step | Why |
|---|---|
| Restart DSH | host-side code is loaded at boot |
| Refresh the browser (`Ctrl+F5`) | the client bundle is fetched once per page load |
| Open the panel once | it reports whether the environment can fold from the panel; on the desktop app it says *during a turn only (local patch missing)* and disables the actions |

## About the local patch (CLI installs only)

The panel's "fold exactly this span while idle" needs a small patch to `@deepseek-ai/dsh-compaction-basic`:

```powershell
# Windows
powershell -File patches/apply-compaction-patch.ps1
```

It is idempotent: it patches both known copies, refuses to touch files when the upstream anchor changed, and writes `*.bak-*` backups. Every DSH upgrade replaces the CLI tree, so re-run it after upgrading.

**The desktop app cannot be patched** (its core lives inside `app.asar`), so there the plugin degrades gracefully: the tool path and the summary template work, and the panel explains why it cannot fold. Tracked upstream: https://github.com/deepseek-ai/deepseek-harness/discussions/12813

## Verifying an install

```text
node tests/run.mjs          # core logic: 139 assertions, no host required
```

Inside DSH, the plugin's own log lines appear in `~/.dsh/restart-web.err.log` (or the desktop app's log): `compact_turns registered`, `可选依赖`, `客户端 API 已注册`, `捕获到第 N 个 compaction 实例`.
