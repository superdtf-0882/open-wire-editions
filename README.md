# The Open Wire — editions

Machine-written content for the news digest published at
**[davidfacer.com/wire](https://davidfacer.com/wire)**.

This repository holds **data, not a site**. A scheduled job writes an
edition here twice daily; `davidfacer.com` fetches and renders it. The
job never writes to the site's own repository — that separation is the
architecture, not a convention (`ADR-009`, Shape A).

## What is here

| path | what it is |
|---|---|
| `editions/current.json` | the edition now being served |
| `editions/previous.json` | edition N−1, retained for rollback |

## This content is automatically generated

**Every item in an edition is produced by an automated pipeline, not
written or reviewed by a person before publication.** Items link to
their original sources and name the outlet that published them. Nothing
here is original reporting, and it is not presented as the repository
owner's own analysis.

**That notice travels in the edition payload as well as on the page.**
This repository is public, so `raw.githubusercontent.com` serves these
files directly and a consumer may never see the rendered page. Anything
that must be said to a reader must therefore be said in the JSON.

## Corrections

Open an issue here, or use the contact route on
[davidfacer.com](https://davidfacer.com). An item can be removed and the
edition republished.

## Governance

Built under `ADR-009` and `AC-011` in a private Enterprise Architecture
corpus. Those identifiers are cited so the decisions behind this
repository are nameable, not because the corpus is reachable from here.
