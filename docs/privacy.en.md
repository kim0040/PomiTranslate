# Data, Privacy, and API Keys

[English](privacy.en.md) · [한국어](privacy.md) · [日本語](privacy.ja.md) · [简体中文](privacy.zh.md)

## Local App and Data Sent Externally

World selection, scanning, and review are handled locally. When you run an AI translation, the selected source text, target language, translation instructions, and other request content are sent to the **API provider or custom endpoint you selected**. Review server names, books, signs, and other text for personal information before including them in a translation. The provider's retention, training, and deletion policies apply to data it receives.

**Update checks** retrieve only the latest version information (`latest.json`) from GitHub (`github.com/kim0040/PomiTranslate`). They do not send worlds, keys, usage history, or installation identifiers. You can turn off the once-daily automatic check in Settings → Updates. Web links in Help and About open only predefined destinations (GitHub, minecraft.net, provider API-key pages, and the contact email) in your default browser.

Model-support information and usage lookups also make network requests to the selected provider. The public OpenRouter model-catalog lookup does not send a key or world text. Usage lookups and authentication requests to other providers use the saved key. Refining translation instructions is a separate AI request.

The desktop app uses a JSONL sidecar and does not open a localhost server for its UI. The development Vite server and legacy Web UI are separate and do not use the same runtime setup.

## Data the App Stores

Settings, recent world paths, model cache, scan plans and checkpoints, translation reports, and backups may remain in app data. They can include paths, source text, or translations, so do not upload them unchanged as diagnostic material or to a public repository. Settings → **Reset** can remove settings, recent worlds, resumable work, and the model list, as well as saved API keys if you choose that option. Reset does not remove world backups; delete the data folder yourself if you want to remove those. **Copy diagnostics** in Help, like the diagnostics export, includes only the app version, build, operating system, error codes, request types, durations, result codes, and known shapes of the core's diagnostic lines. Free text (error messages, paths, world names or text, keys) is never put in by construction, and is not written to the local log file either. Encrypted portable export is not available. See [Update and data retention (Korean)](updates-and-data.md) for how updates and cleanup tools relate to data.

The public Python settings paths are macOS `~/Library/Application Support/PomiTranslate`, Windows `%APPDATA%/PomiTranslate`, and Linux `$XDG_DATA_HOME/PomiTranslate` or `~/.local/share/PomiTranslate`. The native vault uses `credentials/credentials.sqlite` and `credential-key/master.key` under the Tauri app-data path. An isolated Eval identifier uses a separate root, so it does not share data with the regular app.

## API Keys

- Default: **local encrypted storage** — Rust SQLite with AES-256-GCM and a separate, per-installation key file.
- Optional: **session only** — you must enter the key again after restarting the app.
- Optional: **OS keychain** — accessed when you select it or run the existing-key import. The app does not automatically read and import an existing keychain key at startup.

The UI shows only whether a key is stored and the storage method; it never returns the saved key text. When an API request needs a key, Rust passes it to the sidecar through stdin. Keys are not put in public settings JSON or world backups.

A process running with the same user permissions that can read both the database and encrypted key file can decrypt the key. This design is not presented as protection against malicious programs, account takeover, or memory/swap exposure. Do not automatically sync these files or put them in a public backup. Protect your OS account and disk separately. The app checks that the data folder and the vault folders are not links, belong to the user, and cannot be written by other users, but another process running as the same user is outside the protection of that check.

The CLI and legacy UI use the existing OS keyring/environment-variable compatibility path and do not automatically share credentials with the desktop vault. `.env.example` is a template without secrets; storing a real key in a plaintext `.env` file is not recommended.

Use Settings to change or delete a key. Switching from Local to Session/Keychain removes the Local ciphertext. Importing an existing key from the OS keychain only copies it and keeps the original entry; the app notes that the entry exists, so deleting the key or a reset with "delete keys" deletes that entry as well. Switching between Local and Session never touches the keychain. If the key file is lost or ciphertext is damaged, you may need to enter the key again. The app's OS keychain entries are exactly the service name `PomiTranslate` with the account named after a provider (for example `openai`); only PomiTranslate writes that namespace. The app never lists the keychain and never touches any other entry. It deletes those entries only on your explicit action: deleting a provider's key, switching that provider away from Keychain, or resetting the app with "delete keys" (which covers every provider). An entry that is already missing counts as deleted. If the app's settings have no record of the keychain being used for a provider (you never chose Keychain mode for it), the app does not access the keychain for it at all. If the operating system refuses a delete, the app says it could not delete the entry (`KEYCHAIN_UNCONFIRMED`), and trying again asks for the deletion again.

## Costs and Contact

The app itself has no purchase or subscription. Costs for API requests, inference, retries, and refining translation instructions follow the provider's terms. A before-and-after usage difference can include other work and reporting delays, so it may not equal the cost of this task.

Do not attach API keys, private worlds, or complete logs to a public Issue. For a security report, first send a description that contains no secrets to [mini0227kim@gmail.com](mailto:mini0227kim@gmail.com). See the [disclaimer and rights notice](disclaimer.en.md).

For setup and operation, see the [user guide](user-guide.en.md). Verified format and platform scope is listed in the [support matrix (Korean)](support-matrix.md).
