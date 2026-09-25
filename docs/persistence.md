# E-Stack persistence

## Server-persisted state

| Storage | Owner | Meaning |
| --- | --- | --- |
| `savedConfigs.dat` | E-Stack DSP saved-config API | Collection of user presets, including historical `global-eq` and `estack-system` records |
| `startupConfig.json` | Startup Configuration service | Startup mode (`yaml`, `specific`, `last`) and last/active system preset metadata |
| `currentConfig.json` | E-Stack DSP | Current named configuration selection metadata |
| `config/*.json` | E-Stack DSP | Named configuration records |
| `camillaNodeConfig.json` | E-Stack DSP compatibility | Application HTTP port/runtime configuration; filename intentionally retained |
| `wiimLoudnessConfig.json` | WiiM integration | Machine-local bridge/settings configuration; preserved by deployment |

`estack-system` records are full processing snapshots used by the server-owned
startup recall workflow. `global-eq` records are input/global EQ presets. The
legacy saved-config client keeps type/name/id semantics; the product must retain
those data formats and APIs while it migrates the related pages.

`EStackSavedConfigClient` is the product's reusable client for this collection.
It reads the complete array before a save or delete and submits the base plus the
complete updated array after modifying one record. The server compares the base
with current storage and rejects stale writes. It matches a replacement by
`type` plus `name`, preserves the existing ID on overwrite, and deletes only by
the selected ID. Listing by type is presentation-only; it must never be used to
produce the collection sent to `/saveConfigFile`.

## Browser-local preferences

Browser storage is for presentation/operator preferences only. It is not DSP
state and must never be treated as the live source of truth. Current examples:

- `estack.control.link.mid`
- `estack.control.link.high`
- historical local saved-config UI cache keys such as `savedConfigs`

The MID/HIGH keys control linked **gain** interaction only. They do not persist
or imply a DSP mute state.

## Raspberry runtime state outside source control

The physical CamillaDSP YAML, ALSA/RASPIAUDIO devices, amplifier calibration
and live hardware routing are not owned by source control. The normal updater
preserves the runtime files above and must not rewrite the hardware graph during
a UI update. See [Raspberry deployment](raspberry.md).

## Rule for product services

Read live DSP state through CamillaDSP for operational controls. Use persisted
server APIs only for their designated preset/configuration workflows. Do not
invent a browser persistence format for processing, limiter, mixer or device
state.

Product workflow display preferences use estack.product.presentation (density
and contrast). They are consumed only as CSS presentation by the secondary
workflow surfaces, System Presets and Advanced; they never represent processing or safety state.

## Atomic system persistence

System capture/update/delete is server-owned and synchronously reads, changes
one record and atomically renames the complete collection. Mixed record types
remain untouched. The file writer uses a unique temporary filename, fsync and
existing permissions. A failed write cannot truncate the original collection.
System IDs and creation dates survive overwrite and rename.
Active, selected-startup and last-used records cannot be deleted.

startupConfig.json uses the same atomic writer. Startup selection, system apply
metadata and deletion share the server workflow gate. Metadata is written only
after verified processing and Master readback. See pages/system-presets.md for
the unchanged historical schema and safe legacy Master fallback.

The earlier desktop legacy whole-collection save contract now requires ETag /
If-Match or a matching base array, and cannot modify system records. The product
saved-config client supplies the base automatically; Global EQ data semantics,
identity, overwrite rules and unrelated-record preservation are unchanged.

System renaming uses the server workflow gate and atomic file writes. Matching
startup/active/last-used/boot-applied references retain their ID and get the new
name. A metadata write failure rolls the collection back. Global EQ renaming uses
the existing compare-and-swap client and changes only the selected record name.
Neither operation applies processing or changes the configured startup mode.
