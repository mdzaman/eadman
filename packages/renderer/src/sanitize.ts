import type { Root } from "hast";
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize";

type AttributeDefinition = NonNullable<Schema["attributes"]>[string][number];

/** Classes the renderer itself generates inside page bodies (everything else is dropped). */
const CLASS_RE =
  /^(?:language-[^\s"'<>]+|method-[a-z]+|method|callout|callout-(?:note|tip|important|warning|caution|title|inline)|code-block|code-title|heading-wrapper|heading-anchor|tabs|code-group|tab-panel|tab-heading|api-operation|api-operation-(?:link|missing|inline)|api-path|api-summary|jira-status|table-wrap|task-list-item|contains-task-list|footnotes|sr-only|data-footnote-backref)$/;

const nameOf = (definition: AttributeDefinition): string => (typeof definition === "string" ? definition : definition[0]);

function buildSchema(): Schema {
  const attributes: Record<string, AttributeDefinition[]> = {};
  for (const [tag, definitions] of Object.entries(defaultSchema.attributes ?? {})) {
    // Tag-specific `className` allowlists would shadow the global one below.
    attributes[tag] = definitions.filter((d) => nameOf(d) !== "className");
  }
  attributes["*"] = [
    // `name` enables DOM clobbering of `document.*`; nothing we generate needs it.
    ...(attributes["*"] ?? []).filter((d) => nameOf(d) !== "name"),
    ["className", CLASS_RE],
    ["role", "note", "region"],
    "data*",
    "ariaLabel",
    "ariaLabelledBy",
    "ariaDescribedBy",
    "ariaHidden",
  ];
  attributes.a = [...(attributes.a ?? []), ["rel", "noopener", "noreferrer"]];
  attributes.img = [...(attributes.img ?? []), ["loading", "lazy"], ["decoding", "async"]];
  return {
    ...defaultSchema,
    attributes,
    tagNames: [...(defaultSchema.tagNames ?? []), "aside"],
    // Heading ids must match the anchors computed by @docops/markdown (GitHub-compatible).
    clobber: [],
    clobberPrefix: "",
    protocols: {
      ...defaultSchema.protocols,
      href: ["http", "https", "mailto", "tel"],
      src: ["http", "https"],
    },
    strip: ["script", "style"],
    allowComments: false,
    allowDoctypes: false,
  };
}

export const SANITIZE_SCHEMA: Schema = buildSchema();

/** Allowlist-sanitize a rendered page body (drops scripts, event handlers, `javascript:`/`data:` URLs). */
export function sanitizeBody(tree: Root): Root {
  const result = sanitize(tree, SANITIZE_SCHEMA);
  return result.type === "root" ? result : { type: "root", children: [result] };
}
