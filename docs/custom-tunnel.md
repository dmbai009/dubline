# Custom tunnel

Custom tunnel is the fourth launcher and connection-settings choice, marked
For advanced users in EN/RU/UK. It is a manual guide for people who need an
alternative to Cloudflare, Porthole or VPN, not a provider integration.

The production `launchWorkspace('custom')` uses the existing free-port selector,
origin preference, local server, desktop host proof, room and PIN. It starts no
tunnel process and downloads no tunnel software. Single Player promotion reuses
the same existing `enable-multiplayer` operation. Generic retry in this mode
returns its current status without enabling Cloudflare. No dependencies, project
fields, public endpoint discovery or networking architecture are added.

Connection settings and the invitation popup show the actual server port, with
Copy port, and the destination `127.0.0.1:<port>`. The three steps explain manual
installation/startup, forwarding to that destination, and sharing the tunnel's
public HTTPS link together with the room PIN. The port may change after restart
if the previous port is occupied. Popup Copy PIN copies only the PIN; the local
destination is never presented or copied as a public invitation.

Custom status is Manual setup, not an assertion that a third-party tunnel is
running or externally reachable. Existing tab switching changes displayed
information only, preserving independent Cloudflare operation and the current
room, port, PIN and participants. A deliberate Cloudflare toggle still controls
Cloudflare independently. Porthole and VPN retain their existing tool actions.

Tests cover the production main-process launch/promotion/retry functions with
mocked external boundaries, real free-port allocation, browser launcher and
settings flows, localization, changing/unknown ports, PIN masking, and switching
back to all existing modes. Native hosting smoke starts a real local server in
Custom mode and verifies clipboard/guest PIN access before testing independent
mocked Cloudflare. Actual external tunnel services are not part of these checks;
users must supply a compatible HTTPS tunnel with HTTP/WebSocket support.

Local validation (2026-10-17): syntax/whitespace checks, all 475 unit/server tests,
and 18 launcher/desktop/storage browser cases passed. Playwright captured and
checked 150 layouts across EN/RU/UK, six studio themes and effective 100/150%
viewports. Native Electron hosting smoke passed actual Custom-mode server startup,
no automatic tunnel/retry, clipboard port copy, guest PIN admission, independent
mocked Cloudflare switching, and six themes/three languages at 1024×768,
1280×720 and 1920×1080 with 100/125/150% native zoom. External services were mocked;
no public third-party tunnel was launched or tested. Distribution verification is
separate from the checks above.
