## [0.10.1](https://github.com/idleware/repometry/compare/v0.10.0...v0.10.1) (2026-11-26)

### Fixes & improvements
* fix: keep go's telemetry out of the tool's temporary home ([e345773](https://github.com/idleware/repometry/commit/e345773d1af7abce1eafe479596e6eb55e5df555))
* docs: document analyze exit codes and the review checkout ([8fb616b](https://github.com/idleware/repometry/commit/8fb616b198222c959d022d7331c1d3b76d5760c8))
* perf: analyze long histories in parallel ([986ab46](https://github.com/idleware/repometry/commit/986ab46d9bb28a4ac725412694a3afccb3fd28b4))

## [0.10.0](https://github.com/idleware/repometry/compare/v0.9.0...v0.10.0) (2026-11-25)

### Features
* feat: open the review comment with the verdict flag ([6c85a02](https://github.com/idleware/repometry/commit/6c85a024342a842a60bcd5177a44c17f8b440bd6))

### Fixes & improvements
* refactor: read churn records one at a time ([89e8f41](https://github.com/idleware/repometry/commit/89e8f41367bb8441769215a891ef5b07c5c000af))
* docs: impr PR flow description ([ab07451](https://github.com/idleware/repometry/commit/ab07451d92649ab598d58b192703bdc611738e9c))

## [0.9.0](https://github.com/idleware/repometry/compare/v0.8.1...v0.9.0) (2026-11-25)

### Features
* feat: review pull requests on the lines they change ([988056a](https://github.com/idleware/repometry/commit/988056a00f89efedf52206dbe8e8f6e6d07403ee))

## [0.8.1](https://github.com/idleware/repometry/compare/v0.8.0...v0.8.1) (2026-11-25)

### Fixes & improvements
* docs: add cicd usage examples ([af145ca](https://github.com/idleware/repometry/commit/af145ca8d8d97dbc7a1e94526735e731ba1e4f4b))

## [0.8.0](https://github.com/idleware/repometry/compare/v0.7.0...v0.8.0) (2026-11-24)

### Features
* feat: store each file's results once across commits ([d8c0871](https://github.com/idleware/repometry/commit/d8c08712fb0b738fd8bedd0fbf5dd931f204896c))
* feat: analyse go and python with the local toolchain ([f6eef25](https://github.com/idleware/repometry/commit/f6eef25cca7c14f7a0ff9c4643f1489a5b4538ef))

### Fixes & improvements
* perf: reuse unchanged files' results when analysing history ([f40e6dd](https://github.com/idleware/repometry/commit/f40e6dd393d1b8b0b25321e2cc42eb6db8a4a0c4))
* refactor: keep every function within the complexity target ([4c06f1b](https://github.com/idleware/repometry/commit/4c06f1bbfe327305c0dddcb62494b79034d396f9))

## [0.7.0](https://github.com/idleware/repometry/compare/v0.6.2...v0.7.0) (2026-11-24)

### Features
* feat: add language plugins from repometry.config.json ([a7c4f47](https://github.com/idleware/repometry/commit/a7c4f47eac9e526219405811f1d837e6e3f60010))

## [0.6.2](https://github.com/idleware/repometry/compare/v0.6.1...v0.6.2) (2026-11-24)

### Fixes & improvements
* refactor: simplify the engine and drop parser names from comparison ([c63cf7c](https://github.com/idleware/repometry/commit/c63cf7c5c9ef6b86e3f49f2dc345a13dfd1ff280))

## [0.6.1](https://github.com/idleware/repometry/compare/v0.6.0...v0.6.1) (2026-11-24)

### Fixes & improvements
* fix: restore commit times in the report timeline ([e973dde](https://github.com/idleware/repometry/commit/e973ddee412e0ad049f042d3e0f3f5b2895b3bd6))

## [0.6.0](https://github.com/idleware/repometry/compare/v0.5.0...v0.6.0) (2026-11-24)

### Features
* feat: let language plugins select and measure source files ([5366479](https://github.com/idleware/repometry/commit/536647993a17cd3a0323368a66b35ca9287c1fcb))

## [0.5.0](https://github.com/idleware/repometry/compare/v0.4.2...v0.5.0) (2026-11-24)

### Features
* feat: run external analyzers as process plugins ([3566e43](https://github.com/idleware/repometry/commit/3566e43c229d0827ff77b5b69bedcf7243017651))

## [0.4.2](https://github.com/idleware/repometry/compare/v0.4.1...v0.4.2) (2026-11-23)

### Fixes & improvements
* fix: improve badges ([ff7fa51](https://github.com/idleware/repometry/commit/ff7fa512c5fd3b1049d415f2f3bc335ced2530e3))

## [0.4.1](https://github.com/idleware/repometry/compare/v0.4.0...v0.4.1) (2026-11-23)

### Fixes & improvements
* fix: avoid coverage strip break ([87140c0](https://github.com/idleware/repometry/commit/87140c036d309c60c93b99e83d0e2d94f25c116e))

## [0.4.0](https://github.com/idleware/repometry/compare/v0.3.1...v0.4.0) (2026-11-23)

### Features
* feat: introduce basic security checks ([93fb744](https://github.com/idleware/repometry/commit/93fb744847bdcd38104c7e7f30260eb17d445e4e))

## [0.3.1](https://github.com/idleware/repometry/compare/v0.3.0...v0.3.1) (2026-11-23)

### Fixes & improvements
* perf: show coverage hits ([8c0de8d](https://github.com/idleware/repometry/commit/8c0de8dad021f0b207af594d4931ea446a63a98e))

## [0.3.0](https://github.com/idleware/repometry/compare/v0.2.1...v0.3.0) (2026-11-23)

### Features
* feat: show line coverage in the source view ([9633c72](https://github.com/idleware/repometry/commit/9633c720c29678cc507cb55feafe8089f6097608))

## [0.2.1](https://github.com/idleware/repometry/compare/v0.2.0...v0.2.1) (2026-11-23)

### Fixes & improvements
* fix: join chart points across profile changes ([6f962b7](https://github.com/idleware/repometry/commit/6f962b7dcaaa937491a1d7e3f339d2a9522fcc72))

## [0.2.0](https://github.com/idleware/repometry/compare/v0.1.0...v0.2.0) (2026-11-23)

### Features
* feat: drop the GitHub Action in favour of the CLI ([2c9d330](https://github.com/idleware/repometry/commit/2c9d330b5fa38e63df776426448725d4e492cbe6))
* feat: one full report with branch and function coverage ([f6abfad](https://github.com/idleware/repometry/commit/f6abfadff9c4b6bc19dca4478da0a77f135c32a9))

## [0.1.0](https://github.com/idleware/repometry/compare/undefined...v0.1.0) (2026-11-23)

### Features
* feat: add file size measures ([9d982fa](https://github.com/idleware/repometry/commit/9d982fa3431fd52006cf3f6cb03548a050ba86d1))
* feat: initial commit with modular architecture and plugin manifests ([fd2c0e3](https://github.com/idleware/repometry/commit/fd2c0e3d0be24ac4011e6e7d6402c4b6eb6daba3))
