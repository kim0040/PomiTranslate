# PomiTranslate user guide

English | [한국어](user-guide.md) | [日本語](user-guide.ja.md) | [简体中文](user-guide.zh.md)

## Before you start

![Keep an independent world copy](../assets/illustrations/docs/doc_backup_first_en_v1.png)

The app is in development. Main workflows have been exercised in a macOS Apple Silicon development app; signed distribution and full OS validation remain unfinished. Read the [development guide (Korean)](development.md) and [support matrix (Korean)](support-matrix.md).

Close Minecraft or the server and make an **independent copy of your world**. Automatic backups do not replace your own backup. The original creators retain their rights to maps and resource packs; the software's MIT license does not grant permission to redistribute them.

## 1. Settings

### First run: the setup assistant

![Selected source text and instructions go to your chosen provider and may incur charges](../assets/illustrations/docs/doc_api_notice_en_v1.png)

On first launch the **setup assistant** opens after the notice. You can put it off (**Later**) and still scan and review; you only need to finish setup before you start translating. Reopen it any time with **Open the setup assistant** in Help.

1. **Choose an AI provider:** pick OpenRouter, Gemini, OpenAI, Anthropic or Comet. **Open the key page** on a card opens that provider's key page in your default browser. To point at an OpenAI- or Anthropic-compatible server instead, choose **Advanced: custom endpoint**.
2. **API key:** paste your key and the app checks the connection automatically and shows how many models are available. The check uses the key you typed for that single model-list request only, and nothing is stored until you save in the last step. If a key is already saved for this provider, it is used when you do not type a new one.
3. **Choose a model:** a recommended model (the cheapest fast one) is preselected, and each model shows its input and output price per million tokens. Models without price information say so.
4. **Language and style:** choose the target language from the list or type your own, then pick a style.
5. **Finish:** **Save and finish** saves provider, model, language, style and the typed key together. Closing the assistant earlier saves nothing, and you are asked whether to continue setup or discard it.

### How Settings is organized

Settings has four tabs. The number beside a tab name counts unsaved changes in that tab, and a tab with an error is marked. The pinned bottom bar appears **only when a change needs saving**, and lets you save or discard. Items that apply the moment you pick them, such as Display Language, Appearance and the notification switch, need no save. **Reset this section to defaults** in a section restores only that section.

### Translation tab

- **Provider:** choose OpenAI, Gemini, Anthropic, OpenRouter, Comet or Custom endpoint. The Custom endpoint URL and OpenAI/Anthropic-compatible wire format are set in the **Advanced** tab.
- **API key:** save your own key for AI translation. **Check connection** asks the provider for its model list with the key you typed (or the saved key) and does not save the typed key. Saved keys are represented by their storage status and mode, never their original value. You can change or delete them, and choose the storage mode under **Key management and security**.
- **Model:** choose from the list or enter a model ID. The list is split into recommended and all models, can be searched, and hides models that are unsuitable for translation by default. When known, input and output prices are shown per million tokens.
- **Load model list:** OpenRouter's public catalog loads automatically and can be refreshed manually. This lookup does not save settings or send keys or world text. Other providers need a typed or saved key. Cached information, lookup failures and missing models are distinguished in the UI.
- **Enter prices:** appears when the selected model has no price in the catalog. Enter input and output prices (USD per million tokens, 0–1,000, both required) and they are used for that model's cost estimate; the Run screen then says it uses user-entered prices.
- **Reasoning (OpenRouter and Gemini):** choose Model default, Disable reasoning or Custom. Verified model information restricts the available effort levels; mandatory reasoning cannot be disabled. For Gemini, load the model list once to check thinking support. Gemini 3 models enable thinking by default and can consume many billed output tokens even for short translations. Disable reasoning for translation where possible. Some models cannot turn it off completely; the app adjusts to the lowest accepted level. Thinking tokens are included in reported output usage.
- **Check OpenRouter usage:** retrieves cumulative credits used by the saved key without translating or saving settings. Other jobs using that key and reporting delays can affect the before/after difference. It may differ from this job's cost.
- **Target language and tone:** choose the target language from the list or type one (it is independent of the UI language). Tone: neutral/natural, casual/conversational, formal/clear, polite, story, or a custom system prompt. **Extra instructions** add rules such as “Keep proper names in the original language.” **Refine with AI** expands a short note with AI; it sends a separate request to the chosen provider and may cost money, so confirm before running it.
- **Translation review and spending cap:** both are explained in [Run and result](#4-run-and-result). By default **Review translations before writing to the world** is on and the cap is 0 (no limit).
- **Glossary:** edit the glossary that applies to all worlds here. See [Glossary](#glossary).

### Scan scope tab

- **World text kinds:** choose signs, book pages, book titles, filtered book titles, entity/block names, item names/lore, text displays and command text components. Recommended and story presets, select/clear all and exclusion of command-like plain strings are available.
- **Skip text already written in the target language** to reduce repeated translation.
- **ZIP resource packs:** optionally translate the in-world `resources.zip` and up to 16 explicitly selected external ZIPs. A scope change requires another scan.
- **Saved manual translations:** edit exact source-to-translation pairs for every world in a table, with search, **Add row**, per-row errors and **Import JSON / Export JSON**. They apply only when the source matches exactly, no API is called, and translations entered in Review take priority. Limits: 5,000 pairs, 32,000 characters each, 1 MB total.

### Advanced tab

- **Speed and rate limits:** configure concurrency, sentences per batch, requests per minute (RPM), tokens per minute (TPM), request timeout, maximum retries and Temperature. A zero rate limit adds no separate throttling. Configure safe file-write retries and whether other files should continue after a file error; continuing can produce a partial result.
- **File and translation key rules:** add or remove extra region directories, excluded file patterns and translation-key prefixes as chips. You rarely need to change them.
- **Custom endpoint:** shown only when the Custom provider is selected; set the address and the OpenAI/Anthropic-compatible wire format.
- **Import and export settings:** import PomiTranslate or legacy Web UI JSON, or public string constants from `translate.py`. Python files are never executed. Keys, world paths, UI language and external ZIP paths are omitted, and exported files contain no keys. Imported values only load into the editor and apply after you save.

### App tab

- **Display Language:** Korean, English, Japanese or Simplified Chinese. It is independent of the translation target language and applies immediately.
- **Appearance:** choose System, Light or Dark with the preview tiles or in the View menu. The selection applies immediately and is stored without pressing Save. System follows OS appearance changes. Startup background handling is implemented; current macOS/Windows native appearance checks remain pending.
- **Notify me when work finishes:** on by default. When a scan, translation or restore that took more than 10 seconds finishes while the app window is in the background, the app sends an OS notification. Notification permission is requested once, when the first notification is about to be sent, and a denial does not affect the job. A notification contains only the world name, counts and status, never source text, translations, paths or keys.
- **Updates:** check in Settings. Optional daily automatic checks fetch only GitHub version metadata. Builds containing a signature-verification key can install and restart; other builds open the download page. Installation is blocked during scan, translation and restore. Settings, saved keys and backups are intended to persist. Signed updates are not yet release-validated.
- **Data location:** Settings displays and opens the settings/jobs/backups and encrypted-key directories. Updates and cache cleanup must not delete these directories. See [updates and data preservation (Korean)](updates-and-data.md).
- **Reset:** two confirmations clear settings, recent worlds, resumable jobs, model catalogs and optionally saved API keys, then restart the app. **World backups and original worlds are retained.**

### Zoom, menus and window

- **Zoom:** View offers 75–200%. `Cmd/Ctrl+0` resets to 100%; `Cmd/Ctrl+2` selects 200%.
- **Menus and shortcuts:** `Cmd/Ctrl+O` opens a world, `Cmd+,` opens Settings on macOS, and `Cmd/Ctrl+F` focuses Review search. Help includes the guide, getting started, shortcuts, licenses and issue reporting. Update checks appear in the macOS app menu or the Help menu elsewhere. Web links open in the default browser.
- **Window:** the window size and position are remembered and restored on the next launch (if the saved position is off every screen, the window is centered again). Long jobs report progress in the Dock/taskbar and request attention when finished in the background. Closing or quitting is blocked during an active job with an explanation. Latest native behavior is still subject to the pending OS checks.
- **Close guard:** if you have unsaved settings, unfinished setup-assistant input or unsaved glossary changes, closing the window or quitting asks whether to save, discard or keep editing. Leaving the screen asks the same.
- **About:** app version, supported/unsupported formats, diagnostics, repository/license/contact links and the original Minecraft non-affiliation notice. Open-source licenses are viewable here or from Help.
- **Help/getting started:** open Help from the sidebar, `F1`, or macOS `Cmd+?`. It includes quick start, FAQs, shortcuts and provider key pages. After accepting the first-launch notice and finishing the setup assistant, a four-step introduction appears once and can be reopened from Help.

## 2. Select a world and scan

![Scan without API calls or world writes](../assets/illustrations/docs/doc_scan_first_en_v1.png)

Select a copied world folder containing `level.dat` or a server root. Open a folder, drop a folder/`level.dat` onto the window, or choose a discovered Minecraft world. Discovery reads launcher saves folders, including Prism/MultiMC on macOS/Linux and CurseForge on Windows, without modifying them. The app reads the selected folder directly rather than copying it. Check dimensions, DataVersion, embedded resource packs and stored backups.

Bedrock, legacy `.mcr`, `.linear`, worlds in use, inaccessible folders and paths pointing outside the selected world are blocked before starting.

Scan collects candidates **without translation API requests or world writes**. Distinguish unique strings from total occurrences and read the scope and exclusions. Unreadable chunks are preserved and reported. A readable fixture is not proof of complete version/mod support. `tellraw`/`title` JSON and Java 1.21.5+ SNBT components are parsed; only changed strings are rewritten in their original quoting. Unparsed commands are preserved with a warning. Export the latest scan report as JSON when needed.

The **Recent activity in this world** summary at the top of the scan screen shows the last scan (candidate count) and the last translation (status, translated and failed counts). If a job can be continued, a **Continue job** card appears.

## 3. Review candidates

Search text/locations, sort by world order/source/frequency/kind, and filter by kind or state. Select a row to inspect its source and occurrences and enter a manual translation. Uncheck it to exclude it; bulk inclusion/exclusion applies to the current filter, and the **Undo** shown right after a bulk change reverts it.

- **Occurrences:** shown in a readable form, such as the dimension name and x/y/z coordinates. For a location with coordinates, **Copy teleport command** copies an in-game command that takes you there (it only goes to the clipboard and writes nothing to the world).
- **Candidate actions menu:** right-click a row (or press the Menu key or `Shift+F10`) to include or exclude it, enter a translation manually, or copy the source text.

Keep `§` formatting codes and placeholders such as `%s` and `{0}`. If required tokens are missing or extra tokens appear, the source is retained and the result reports formatting protection. Moving a token while preserving its count is allowed.

One candidate applies the same translation to all occurrences of that source. Per-occurrence translation and translation memory are not available yet and remain follow-up work. An entirely manual run needs no translation API request.

![English candidate review with a manual translation](images/locales/en/review.png)

### Glossary

A glossary fixes how terms such as proper names are translated. For example, always translate `Elder Mira` as a specific name, or never translate `Nether`.

- **Scope:** the glossary for **All worlds** is edited in Settings → Translation; the glossary for **This world only** is edited with **This world's glossary** on the Review screen. If both contain the same source term, the world's entry wins. **Add to glossary** in the candidate detail adds the selected string as a term.
- **Mode:** **Translate** (use a fixed translation) or **Keep untranslated**. You can add a note and choose whether matching is case sensitive. Each scope holds up to 2,000 terms; a source term is up to 200 characters, a translation and a note up to 500. Formatting codes such as `§a` cannot be used.
- **Import and export:** JSON or CSV (columns `source`, `target`, `mode`, `note`, `caseSensitive`).
- **How it is used:** a translation request includes only the terms that appear in that batch's source text. If the AI answers against a rule, the app asks once more for that sentence with a reminder, and if it still disagrees the sentence is marked **Glossary checks** in review. The cost of these extra requests is included in the estimated cost range.
- **Changing the glossary after translating:** before applying, the app tells you which sentences are affected and offers **Retranslate affected rows**. Other translations and the scan result are kept.
- **Where it is stored:** the glossary lives in app data, not in the world folder. See [Privacy](privacy.en.md).

## 4. Run and result

![English pre-run confirmation using synthetic data](images/locales/en/run.png)

### Before running

In Run, check the world, target language, provider/model, strings to send, manual overrides, reasoning, estimated requests/cost and external-transfer notice. The estimated cost is a low–high range that includes allowances for reasoning tokens and extra requests for glossary reminders. It is still not a billing cap: retries, account or routing differences and reporting delays apply, so check your provider's dashboard. A run that applies only manual translations sends no API request.

Set a **spending cap (USD)** on this screen or in Settings → Translation; 0 means no limit. If the estimated maximum cost exceeds the cap, a warning appears before the run starts and you can **Change cap** or **Start anyway**. If the actual cost reaches the cap during a run, translation stops and nothing is written to the world. Translations done so far are kept, so after changing the cap you can continue and only the remaining strings are requested. **Continue once without a cap** on the result screen applies to that one run only and does not change the saved cap.

### Progress

The progress screen shows the stage (collect text → AI translation → write world files), an estimate of the remaining time, requests, failures and **Recent translations**. Cancelling is cooperative, and a checkpoint lets you continue the remaining strings later. Cancelling or failing does not always mean zero file changes, so check the changed-file count, errors and usage in the result. If files were already written, consider restoring the backup. A changed resume setting or file fingerprint may require a new scan. Closing the window and quitting the app are blocked while the job runs.

### Review, then apply

When **Review translations before writing to the world** (also **Review translations before applying** on the Run screen) is on, which is the default, a **Review translations** screen opens after translation and before anything is written. Nothing has been written to the world at that point.

- Search source text and translations in the table and filter by translated, failed, kept, edited and glossary check needed.
- Select a row to edit its translation. If `§` formatting codes or placeholders such as `%s` and `{name}` differ from the source, the row is flagged and not applied; so are empty translations and translations containing characters that cannot be written. **Revert to AI translation** drops an edit.
- Failures are explained in plain language (a slow provider response, a rejected key, a rate limit, low credit, a malformed answer, the provider's safety filter, a network error and so on). **Translate N failed again** requests only those sentences and shows the estimated cost.
- **Apply to world** opens a confirmation. Before writing, the app backs up the files that will change and verifies the backup. Strings that could not be translated keep their original text. A job under review is saved, so you can leave and come back later to apply it.

With review turned off, translations are applied as soon as they finish, and you choose the behavior for failed sentences (stop safely / apply only completed ones) on the Run screen.

### Editing after applying

Use **Edit translations** on the completed result screen to change translations that are already applied. Edit rows in the same review screen, then choose **Apply N edits again**. The app (1) stores the current world state as a recovery snapshot, (2) restores the world from the backup taken before translation, and (3) applies the saved translations plus your edits with a new backup. No AI request is sent, so there is no extra cost. Because it keeps a recovery snapshot and a progress record, an interruption leaves the unfinished job and a recovery point behind when you reopen the app. Do it with Minecraft closed. If you changed the world yourself after applying, you cannot apply again and need to scan again.

### Result

| State | Meaning |
| --- | --- |
| Completed | All translations were applied. |
| Partial | Untranslated strings were retained. |
| Retry needed | World files are unchanged; completed translations are saved so only remaining strings need another request. |
| Stopped at the spending cap | The run stopped before writing. Completed translations are kept and you can continue. |
| Failed | Check changed-file counts and errors; restore if needed. |
| Cancelled | Completed translations are saved for resuming. |
| World in use | Close the game/server and try again. |
| World changed | Writes stopped because files changed after the scan. Scan again. |
| Unsupported | World files are unchanged. |

The result reports prepared/applied/retained/failed/protected strings, changed files, requests, tokens and reported cost, with examples, failure details (with reasons) and protected strings. **View All Translations** opens every translation. Check translations and commands **in game**. Exported reports may contain world paths, source text and translations; inspect them before sharing.

## 5. Restore

With Minecraft and the server closed, open Backups. Verify the world and restore point, read the confirmation and restore. A recovery snapshot saves the state immediately before restore. Restoring can undo edits and game progress made since that backup.

Backups may live in app data or a legacy in-world directory. The list shows one compact card per backup with its kind, creation time, file count and verification status, and you can copy a backup ID. If external ZIPs were translated, select the same ZIPs again in Settings before restoring.

Desktop manages backup/checkpoint locations and provides no backup-off, suffix or arbitrary-path options. Newly created large-chunk files can be removed to restore the previous file layout after taking a recovery snapshot. Restore these new backups with the latest app. Legacy backups remain discoverable/restorable.

Do not ignore verification, path or corruption warnings. Backups cannot guarantee recovery from every storage failure or external modification.

## CLI

The CLI shares the Python core but uses its existing OS keyring/environment compatibility, independently of the desktop vault. Do not put secrets in command arguments, plain settings or Git; use the OS keyring. Desktop keys are not shared automatically.

```bash
# Store reports outside the world.
.venv/bin/python mc_world_translator.py \
  --world-dir "/path/to/World-copy" \
  --dry-run \
  --report-path "/tmp/pomi-scan-report.json"

.venv/bin/python mc_world_translator.py --help
```

| Option | Purpose |
| --- | --- |
| `--dry-run` | Scan without API calls or world writes. |
| `--expect-fingerprint` | Refuse writing if the world differs from the scan fingerprint. |
| `--resume` | Continue remaining translations from a checkpoint. |
| `--restore-backup` | Restore the latest verified backup. |
| `--no-backup` | Run without a backup; discouraged. |
| `--resource-pack-zip` | ZIP path; repeat for multiple packs. |
| `--enable-resource-pack-translation` / `--disable-resource-pack-translation` | Override ZIP translation settings. |
| `--list-models` | List provider models and exit. |
| `--enhance-style-brief` | Expand instructions with AI; may cost money. |
| `--print-notices` | Print first-launch safety information. |
| `--provider`, `--model`, `--base-url`, `--wire-format`, `--api-key` | Provider, model, endpoint, format and key options. |
| `--target-language`, `--style-preset`, `--style-prompt`, `--custom-system-prompt` | Translation language and tone. |
| `--batch-size`, `--temperature` | Request batch size and variation. |
| `--config`, `--data-dir`, `--report-path` | Config, app data and report paths. |

These examples use macOS/Linux. Windows uses `.venv\Scripts\python.exe`. Actual translation can modify files and incur API charges.

## Troubleshooting

![Unsupported compression is never written](../assets/illustrations/docs/doc_unsupported_en_v1.png)

| Symptom | Action |
| --- | --- |
| App could not get ready | Startup stops after 30 seconds for core handshake or 60 seconds for initial world/backup data. Retry, restart and check the recent world's drive. These limits do not apply to long running translations/restores. |
| `AUTH_FAILED` | Check your API key in Settings. |
| `NO_CREDIT` | Check provider credit/balance. |
| `RATE_LIMITED` | Wait or lower concurrency. |
| `MODEL_NOT_FOUND` | Check the model ID or use **Load model list** again. Old Gemini `flash`/`pro` aliases become `gemini-flash-latest`/`gemini-pro-latest`. |
| Slow Gemini response / output token limit | Disable thinking where possible or choose a flash-lite model. |
| `NETWORK_ERROR` | Check connectivity and provider status. |
| World in use | Fully close Minecraft/server. |
| Translation stopped at the spending cap | Completed translations are kept. Change the cap, or use **Continue once without a cap** on the result screen, to translate only the remaining strings. |
| “N translations need a fix” | Make the `§`, `%s` or `{name}` codes of the flagged rows match the source, or choose **Revert to AI translation**, then apply again. |
| Glossary check needed | The translation differs from a glossary rule. Edit the translation or check the glossary. You can still apply it as is. |
| Cannot apply again because the world changed | You changed the world after applying. Scan the world again. |
| Stale scan | Scan again after world/scope changes. |
| Saved-key status unavailable | Re-enter or delete and save the key again. |

Report OS, version and reproduction steps without secrets in [Issues](https://github.com/kim0040/PomiTranslate/issues). [Disclaimer](disclaimer.en.md) · [Privacy](privacy.en.md)
