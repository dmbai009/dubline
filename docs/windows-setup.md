# Windows Setup

Dubline uses the assisted [NSIS installer](https://www.electron.build/v26/docs/nsis/)
with a standard Windows wizard:

1. Welcome.
2. DubLine Source License 1.0.
3. Destination folder, including a writable folder on another drive.
4. Installation progress.
5. Finish, with a checkbox to launch Dubline.

Setup installs for the current user, creates desktop and Start menu shortcuts,
registers `.dubline` in Open with, and appears as Dubline in Windows Installed apps.
The install-mode hook keeps this per-user behavior even if Setup is started from
an elevated process. Protected Windows defaults are managed by Windows.

Updating reuses the chosen installation folder. Projects, workspace history and
preferences stay outside the application directory and survive uninstall. Use
the desktop storage setting to select where media/projects are kept; the Setup
destination selects where the program itself is installed.

## Build and verification

`npm run dist` creates Setup and Portable from one application payload.
`node tools/verify-release-artifacts.js` verifies the full distribution inventory.

`node tools/electron-setup-update-smoke.js` operates in a clean Windows profile.
It drives the real hidden native wizard, chooses an isolated folder containing
Unicode/spaces, disables the final launch checkbox, verifies shortcuts/Installed
apps/Open with, then tests differential update, the retained installation folder,
Setup/Portable coexistence, profile identity and uninstall ownership.

For a profile that already has Dubline installed, build the ordinary A artifacts
and an unpublished B with `node tools/build-update-qa.js`, then run:

```
node tools/build-setup-qa.js
node tools/electron-setup-update-smoke.js --isolated-setup
```

This first probes the exact production Setup's welcome/license/destination pages
and cancels before installation. Full install/update/uninstall uses the same
production ASAR/runtime with a separate QA NSIS app ID, handler, shortcut names,
Installed apps entry and installer cache. Production handler/shortcut/cache hashes
must remain unchanged. Only the verified owned QA cached installer is cleaned up.
The isolated packages are test artifacts and must not be published.
