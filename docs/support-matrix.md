# PomiTranslate support matrix

This file is generated from fixture results. A format is supported only when its fixture passed.
Detected formats below are not writable. Platform rows mean release support is unverified.

Fixtures use small synthetic worlds. A passing row means that shape is read and written correctly.
It does not mean every player-visible text in a real world is found.

## Scope

Core fixtures: `region` and `entities` folders of each dimension, and `resources.zip` inside the world when enabled.
Desktop also handles explicitly selected external ZIPs; see [user guide](user-guide.md) and [current evidence](current-state.md).
Not scanned: data packs, `data/*.dat` (command storage, scoreboard), `level.dat` and player data.

## Chunk coverage

A scan counts every chunk by its own DataVersion, compression and status (`processed`, `skipped_unsupported`,
`unreadable`, `not_inspected`) and reports the counts, the version range, and whether the versions are mixed,
missing or newer. The level.dat version is shown separately: it says what saved the world last, not what saved each chunk.
The newest DataVersion a fixture here was written at is 4556. Chunks above it are read and written only after the user
confirms once per scan that the world came from a newer game version than this app was tested with; a backup is always made.
A version number alone never blocks a write. Structures the reader does not verify stay as they are.
Finding no text is never a statement about the world: chunks that were skipped, unreadable or not inspected are listed beside the result.

## Supported

- compression.gzip: supported
- compression.zlib: supported
- compression.none: supported
- compression.lz4: supported
- compression.external_mcc: supported
- text.legacy_sign: supported
- text.modern_sign: supported
- text.legacy_book: supported
- text.display_name_lore: supported
- text.item_components: supported
- text.direct_component: supported
- text.commands: supported
- text.snbt_commands: supported
- text.component_shapes: supported
- text.object_fallback: supported
- text.hover_item_entity: supported
- text.selector_separator: supported
- text.mannequin_description: supported
- text.modified_utf8: supported
- text.resource_pack_lang: supported
- layout.custom_dimension: supported
- layout.paper_sibling: supported
- safety.scan_only: supported
- safety.backup_restore: supported
- safety.multi_file_restore: supported
- safety.plan_invalidation: supported
- safety.malformed_chunk: supported
- safety.world_write_lock: supported
- safety.cancel_resume_backup: supported
- safety.app_data_backups: supported
- safety.provider_outage_writes_nothing: supported
- safety.retry_reuses_translated_strings: supported
- safety.unreadable_chunk_reported: supported

## Unsupported

- format.bedrock: unsupported
- format.mcr: unsupported
- format.linear: unsupported
- compression.127: unsupported
- compression.unknown: unsupported
- platform.macos_intel: unsupported
- platform.windows_x64: unsupported
- platform.linux_x64: unsupported
