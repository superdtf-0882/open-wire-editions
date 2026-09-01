# Run context template -- combined (legacy) stage

**Prompt text, not code.** `lib/prompt.js` loads this file and substitutes the
`{{...}}` placeholders; it holds no prompt text of its own (A1-014).

Verbatim from open-wire-spec.md v1.0 §9.2, with `{{#each topics}}` resolved by
the loader rather than by a template engine -- the substitutions are few and
explicit, and a template engine would be a dependency carrying no other weight.

Placeholders: `today_iso`, `today_local`, `topic_blocks`, `deny_list`,
`prefer_wires`, `prefer_analysis`, `prefer_primary`, `prefer_utah`,
`min_searches`.

---

```
Today is {{today_iso}} ({{today_local}} in America/Denver).

Compile digest items for these topics:

{{topic_blocks}}

## Source rules

DENIED -- never link, for any reason:
{{deny_list}}

PREFERRED -- free and open:
- Wires and open outlets: {{prefer_wires}}
- Open-access analysis: {{prefer_analysis}}
- Primary and official documents: {{prefer_primary}}
- Utah free outlets and official sources: {{prefer_utah}}

Use primary sources actively where they exist -- an agency release, a court
filing, a contract announcement or a statistical release is better than
coverage of it.

## Search approach

Run at least {{min_searches}} distinct searches across these topics. Vary
your phrasing. Check the preferred outlets directly, not only via general
queries. Prioritise what is newest; a story already widely covered yesterday
is worth including only if it has materially advanced.

## Per-item requirements

- `headline`: descriptive, under 160 characters, not the outlet's clickbait
  variant if a plainer framing is more accurate.
- `source`: the outlet's human-readable name.
- `url`: the canonical article URL, https, no tracking parameters.
- `publishedDate`: the article's own publication date, ISO YYYY-MM-DD.
- `kind`: "primary" for official documents, agency releases and company
  statements; "analysis" for think-tank and open-access analytical work;
  "news" otherwise. Tag honestly -- do not inflate.
- `brief`: two to three sentences. Concrete and factual, with real figures
  where they exist. No adjectives that a wire service would not use.
- `why`: one or two sentences of analysis for this specific reader.

## The reader

The analyst profile above states the frame. Write the `why` line from it.
Name the mechanism, the precedent, or the second-order effect. Assume the
reader already knows the background. Never write "this could have
implications", "it remains to be seen", or any sentence that would be true of
any story in the section.

Return JSON matching the provided schema.
```
