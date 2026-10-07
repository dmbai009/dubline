# Contributing to DubLine

DubLine accepts issues and pull requests. Read [LICENSE](LICENSE) before
submitting code: current development uses **DubLine Source License 1.0**, a
source-available license that is **not an OSI-approved open-source license**.
Earlier revisions published under MIT keep their MIT permissions; contributing
to current development does not change that historical boundary.

## Rights required for a contribution

You retain ownership of your original contribution. To allow the copyright
holder, **dmbai009**, to maintain, distribute, commercialize, and relicense
DubLine, intentionally submitted contributions must carry the copyright and
patent grants in **Section 7 of LICENSE**. The copyright grant is perpetual,
worldwide, non-exclusive, irrevocable, royalty-free, transferable, and
sublicensable, and allows licensing under any terms, including proprietary
and commercial terms. It is not limited to noncommercial use.

Submit only work you own or are authorized to contribute on those terms.
Obtain your employer's permission if your employer owns the work. Identify
third-party code, its origin, and its license in the pull request; do not
claim rights you cannot grant. Clearly mark discussion material that is not
intended for incorporation as **Not a Contribution**.

Include this acknowledgment in your pull request description:

> I have read and agree to Section 7 (Contributions) of the DubLine Source
> License 1.0. I own this contribution or am authorized to grant the rights
> required by that section, including the rights to use, commercialize,
> sublicense, and relicense it. I have disclosed any third-party material
> and its license.

The maintainer must obtain this acknowledgment before merging a contribution.
If you cannot make these grants, discuss a separate written agreement before
submitting code for incorporation. Filing an issue alone grants no rights in
unrelated code or works.

## Development and review

Read [AGENTS.md](AGENTS.md), [PRODUCT.md](PRODUCT.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [BEHAVIOR.md](BEHAVIOR.md), and
[TESTING.md](TESTING.md). Keep changes focused and explain the problem, the
resulting behavior, and the checks you ran. Run `npm run check` and the tests
appropriate to your change; document checks that were not run.

## Forks, builds, and dependencies

Reading, copying, forking, and modifying the source for permitted uses is
allowed. Companies may use it internally. Commercial distribution, resale,
and commercial SaaS or hosted services require prior written permission from
dmbai009. See LICENSE for the complete terms and permission contact.

Identify source forks as unofficial. Third-party builds shared with others
must have a different product name, executable name, package identity, and
branding and must not claim to be official DubLine. The DubLine name, logo,
icons, and brand assets are not licensed with the code.

Dependencies remain under their own licenses. When adding or updating a
dependency or bundled binary, update [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES),
preserve upstream notices, and verify any source-distribution obligations.
If the pinned Cloudflared version changes, update its license file and version
record in `resources/licenses/cloudflared/` from the same upstream tag.
