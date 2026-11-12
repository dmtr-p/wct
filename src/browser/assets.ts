import { Schema } from "effect";
import manifestText from "./built.browser-assets" with { type: "text" };

const manifest = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Struct({ body: Schema.String, contentType: Schema.String }),
  ),
)(JSON.parse(manifestText));
const assets = new Map(Object.entries(manifest));

export const browserAssetPaths: readonly string[] = Object.freeze([
  ...assets.keys(),
]);

/** Accept an exact URL pathname, never a filesystem path or a fallback route. */
export function browserAssetResponse(pathname: string): Response | undefined {
  const asset = assets.get(pathname === "/" ? "/index.html" : pathname);
  if (!asset) return undefined;
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
