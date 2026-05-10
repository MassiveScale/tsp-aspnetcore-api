# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-05-10

### Fixed

- Corrected versioned controller route generation so each operation only emits routes for versions where that operation is available.
- Corrected versioned route templates to preserve operation path parameters (for example, `{id}` is now included in generated method routes when applicable).
- Fixed availability filtering for versioned routes when version enum names differ from their route values (for example, `v1_1` with value `"1.1"`).
- Updated generated `MergePatchUpdate<T>` model/interface properties to use `MergePatchValue<T?>` wrappers so JSON Merge Patch can distinguish absent fields from explicit `null` values.

### Changed

- Updated route behavior documentation to describe method-level `[Http<Verb>("...")]` attributes per available operation version.
- Updated the versioned API example output to reflect version-aware route emission and path parameter preservation.
- Merge patch update properties now default to `MergePatchValue<T?>.Absent` in generated classes.
- `MergePatchValue` helper generation is now automatic when merge patch update models are emitted, even when `emit-helpers` is `false`.
- Added regression tests covering merge patch wrapper typing and helper emission.
- Added a `pretest` build step and a VS Code-friendly test shim (`test/aspnetcore.api.test.mjs`) to improve test discovery and execution in the VS Code Testing panel.
- Added workspace extension recommendations for VS Code test discovery and test UI integration (`hbenl.vscode-test-explorer`, `connor4312.nodejs-testing`).


### Added

- Added regression tests for:
  - versioned routes including path parameters,
  - operation-level version availability filtering,
  - version-name versus version-value availability mapping.
