# Billing launch evidence

Reproduction evidence for the billing launch hardening. These documents were written while
rehearsing the billing launch against the local billing test stack, and until now they lived
only in scratch directories outside version control. This directory is the first in-repo copy,
committed so the claims can be reviewed next to the code they are about.

## What is here

| Path | What it is |
|---|---|
| `group-a/FINDINGS.md` | Verdicts and mechanisms for the six Group A (money safety) break-it scenarios, plus the pre-fix falsification run. |
| `group-a/LIMITS.md` | What the Group A evidence does not prove, and the known weaknesses of its harness. |
| `defense/FINDINGS.md` | Two confirmed defects: hub silent payment loss (D1) and globe instant lockout on cancellation (D2). |
| `defense/LIMITS.md` | What the D1 and D2 evidence does not prove. |

## Held back: the drivers and the harnesses

The reproduction drivers (`groupa-reproduce.ps1`, `d1-reproduce.ps1`, `d2-reproduce.ps1`) and the
harnesses they drive (`groupa-harness.mjs`, `d1-harness.test.ts`, `d2-harness.test.ts`) are **not**
in this directory. They are held back deliberately, because committing them as they stand breaks
this repository's own checks. Each of these was observed on CI, not predicted:

| Check | Blocker |
|---|---|
| `quality` (Type check) | `tsconfig.json` includes `**/*.ts`, so `d2-harness.test.ts` is compiled. It imports `@/lib/db`, `@/lib/org-tier` and `@/app/api/service/tier-sync/route`, which live in the globe repository, not in this one, so `tsc --noEmit` fails with `TS2307 Cannot find module` plus strict-mode errors. |
| `SAST Scan` | The blocking semgrep rule `semgrep.service-role-in-browser` fires on `d1-harness.test.ts`, which builds a Supabase admin client from `SUPABASE_SERVICE_ROLE_KEY` with no `server-only` guard. |
| `gitleaks` | A `jwt` finding in `groupa-harness.mjs` and `d1-reproduce.ps1`. The token carries the `supabase-demo` issuer, so it is a local-dev fixture rather than a real credential, but its payload is **not** the one the `.gitleaks.toml` allowlist covers: the harness token's `exp` is `1983812996` while the allowlist matches `1983819996`. |

None of those three are things this directory should fix on its own. Excluding the harnesses from
`tsconfig`, `vitest` and `eslint`, suppressing a blocking semgrep rule, or widening the gitleaks
allowlist are all changes to shared build and security configuration, and each of them needs its
own review decision. Once that decision is made, the drivers and harnesses from the author's
scratch directory can be added here verbatim apart from the path rewrites described below.

The FINDINGS documents are self-contained without them: they state each scenario, its verdict and
the mechanism, and they quote the source lines and observed output that establish it.

## What is deliberately not here

The raw run transcripts and logs were left out as well. They are bulky, they quote the same source
and output the FINDINGS documents already summarise, and they can be regenerated.

| Omitted | Produced by |
|---|---|
| `GROUPA-TRANSCRIPT.txt` | the Group A driver and harness |
| `D1-TRANSCRIPT.txt`, `D2-TRANSCRIPT.txt` | the D1 and D2 drivers and harnesses |
| `_hub-dev.log`, `_groupa-harness.stdout.txt`, `_d1-stdout.log`, `_d2-stdout.log`, `_orchestrator.log` | the drivers, and the dev servers they start |
| `_baseline/` source snapshots | captured copies of the pre-fix sources |

Two consequences of those omissions are worth stating plainly, because otherwise the documents
read as if something is missing:

- `group-a/FINDINGS.md` names `GROUPA-TRANSCRIPT.txt` as its companion artifact, and
  `defense/FINDINGS.md` cites `D1-TRANSCRIPT.txt` and `D2-TRANSCRIPT.txt`. Those citations are
  accurate. The transcripts exist on the author's machine; they are simply not tracked here.
- `group-a/FINDINGS.md` also refers to a `baseline/` directory of pre-fix source snapshots used for
  its falsification run. That is not tracked either.

## Path convention

Absolute paths were rewritten to relative ones before committing, because the originals embedded a
local machine layout. Paths are now relative to the local ecosystem root, meaning the directory that
holds the main checkouts and their sibling worktrees, with scratch and decision documents under
`temp/`. So `worldwideview-web.fix-billing-launch-hardening` means the worktree
`<ecosystem-root>/worldwideview-web.fix-billing-launch-hardening`, and
`temp/billing-launch-readiness.md` means `<ecosystem-root>/temp/billing-launch-readiness.md`.

Nothing else in these documents was changed, and each committed file was verified byte-for-byte
against its source to confirm that the path rewrites are the only differences.

Two referenced documents live outside this repository and are not included:
`temp/billing-launch-readiness.md` (the launch-readiness decision document that defines the Group A
scenarios) and `temp/billing-launch-branch-status.md`.

## Results belong to a commit

The verdicts recorded in these documents belong to the specific commits the documents name. A run
against a different commit is a new result to be judged on its own, not a confirmation of the
recorded one.
