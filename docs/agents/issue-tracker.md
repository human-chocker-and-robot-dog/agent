# Issue tracker: GitHub

Issues and product requirements for this repository live in GitHub Issues. Use the `gh` CLI for issue operations from this checkout.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open` with appropriate label filters.
- Comment: write the body to a temporary file, then use `gh issue comment <number> --body-file <file>`.
- Change labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

The repository is inferred from `git remote -v` when `gh` runs inside this clone.

## Pull requests as a triage surface

External pull requests are **not** a request surface. Triage workflows operate on GitHub Issues only.

## Skill vocabulary

When a skill says to publish work to the issue tracker, create a GitHub Issue. When it says to fetch a ticket, run `gh issue view <number> --comments`.
