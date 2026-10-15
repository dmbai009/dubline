# CI verification

Dependencies are installed from package-lock.json with npm ci. The root
node_modules path is ignored as both a file and a directory; machine-specific
dependency links must not be committed.

The Windows source, browser shards and Electron jobs remain independent. Both
the browser jobs and release verification run tools/require-browser.js with
DUBLINE_REQUIRE_BROWSER=1 before starting browser tests. Local unit tests do not
require a browser.

Failure annotations prefer Node's detailed spec-reporter footer, which places
each source location before its test header. This avoids counting failures
twice or assigning a neighbouring test's error to them. Interrupted logs retain
their available test names without borrowing details across test boundaries.
The regression test invokes the actual Node reporter with two distinct errors,
forced terminal colours and paths containing spaces.
