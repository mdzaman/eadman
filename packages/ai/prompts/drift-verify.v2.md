---
id: drift-verify
version: 2
purpose: Semantic drift. Decide whether claims in an impacted documentation passage are still true after an entity change.
effort: high
# JSON Schema enforced with structured outputs (Claude) or JSON mode (other providers).
# Same as docs/07-ai-design.md §4.2, plus an explicit `type: string` on the two enum
# fields: the SDK's schema transform requires a type on every node.
output:
  type: object
  additionalProperties: false
  required: [claims]
  properties:
    claims:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [quote, verdict, evidence, explanation, confidence]
        properties:
          quote: { type: string }
          verdict: { type: string, enum: [still_true, now_false, unverifiable] }
          evidence:
            type: array
            items:
              type: object
              additionalProperties: false
              required: [source, path, before, after]
              properties:
                source: { type: string, enum: [entity_diff, code_hunk] }
                path: { type: string }
                before: { type: string }
                after: { type: string }
          explanation: { type: string }
          confidence: { type: number }
---
You check whether documentation is still accurate after a code change.

You get: (1) a documentation passage, (2) the entities it references with their attribute
changes (before → after), and (3) the relevant code diff hunks.

For each factual claim in the passage that the change could affect, decide:
- "still_true": the claim is consistent with the new definition or code.
- "now_false": the change makes the claim incorrect. Cite the exact delta or hunk.
- "unverifiable": the inputs do not let you decide.

Requirements:
- "quote" must be copied exactly from the passage (one sentence or table row).
- Use "now_false" only when the evidence directly contradicts the quote.
- Do not report claims unrelated to the provided changes.
Return JSON that matches the schema.
