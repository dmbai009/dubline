# Portable projects and runtime modes

Status: accepted for 1.4 implementation.

## Decisions

1. Single Player reuses the existing local server and session/editor/recording/export architecture. It is a runtime mode, not a new project type.
2. Dubline Project is a ZIP container with an explicit, versioned `project.json` manifest. Internal persistence remains separate. Unsupported versions fail clearly; a future version can add an explicit migration.
3. Voxalike packs exchange content; Dubline Projects preserve a working scene, media, current takes, and mix. Neither format is substituted for the other.
4. Project state is independent of runtime room connectivity. No sockets, online participant list, PIN/password, host credentials, pending upload queue, UI preferences, or caches enter the manifest.

## Consequences

Serialization must use an allowlist, preserve metadata and bytes from one snapshot, and stage validated import before creating a new session. The same archive must work from either runtime mode. Hosting, authorization, and network delivery stay with the existing room/desktop systems. A project archive contains the active scene; other sessions remain available in room persistence and can be exported independently.
