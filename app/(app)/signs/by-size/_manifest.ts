// Server-side per-size reconcile orchestration. Shared by the Server Action (preview on
// the by-size page) and the JSON download route so both re-derive the SAME manifest from
// the live DB + a fresh Figma fetch — the client never supplies node data or a changeset
// (the re-derive-on-use posture the master-sheet reconcile uses in reconcile/actions.ts).
//
// Read-only against Figma: it fetches each size file's document and emits a delete/append
// /ambiguous list. It NEVER mutates a Figma node — executing the list stays a follow-on
// plugin/MCP pass.
import "server-only";

import { prisma } from "@/lib/db";
import { fetchFileDocument, figmaToken } from "@/lib/figma-api";
import { figmaFileKey } from "@/lib/figma";
import { flattenFigmaNodes } from "@/lib/figma-match";
import {
  buildFigmaManifest,
  type ManifestAmbiguous,
  type ManifestAppend,
  type ManifestCorrection,
  type ManifestDelete,
  type ManifestOrphan,
} from "@/lib/figma-reconcile";
import {
  CUSTOM_BUCKET_KEY,
  SIGN_FORMATS,
  formatBucketForSize,
} from "@/lib/sign-format";

import { ARCHIVED_STATUS } from "../_lib";

// One reconciled Figma file within a bucket (a bucket usually has exactly one). Only the
// FILE-specific ambiguities live here (kind "node"); sign-side collisions are bucket-level.
export type BucketManifestFile = {
  fileKey: string;
  figmaUrl: string;
  inFile: number;
  deletes: ManifestDelete[];
  // A text-edited sign's old-text node to RETEXT in place (not append a duplicate).
  corrections: ManifestCorrection[];
  // Rendered instances tied to no active sign — probable stale leftovers ("delete?").
  orphanNodes: ManifestOrphan[];
  ambiguousNodes: ManifestAmbiguous[];
};

export type BucketManifest = {
  bucketKey: string;
  bucketLabel: string;
  generatedAt: string; // ISO — stamped by the caller (Date is unavailable in some contexts)
  files: BucketManifestFile[];
  // Bucket-level: an active sign present in NONE of the bucket's files (needs rendering).
  appends: ManifestAppend[];
  // Bucket-level active-sign collisions (kind "sign") — same across files, reported once.
  ambiguousSigns: ManifestAmbiguous[];
  fileErrors: string[]; // per-file fetch/parse problems, surfaced but non-fatal
  counts: {
    activeSigns: number;
    files: number;
    inFile: number;
    deletes: number;
    appends: number;
    ambiguous: number;
    corrections: number;
    orphans: number;
  };
};

export type BucketManifestResult =
  | { ok: true; manifest: BucketManifest }
  | { ok: false; error: string };

const CANONICAL_SIZES = SIGN_FORMATS.map((f) => f.size);
const BUCKET_LABEL = new Map<string, string>([
  ...SIGN_FORMATS.map((f) => [f.key, f.label] as const),
  [CUSTOM_BUCKET_KEY, "Other / custom"],
]);

export function isKnownBucketKey(key: string): boolean {
  return BUCKET_LABEL.has(key);
}

// Compute the manifest for one size bucket. `generatedAt` is injected so this stays free
// of ambient Date reads (deterministic + resume-safe).
export async function computeBucketManifest(
  bucketKey: string,
  generatedAt: string,
): Promise<BucketManifestResult> {
  const bucketLabel = BUCKET_LABEL.get(bucketKey);
  if (!bucketLabel) return { ok: false, error: "Unknown size bucket." };

  const token = figmaToken();
  if (!token) return { ok: false, error: "Figma API token not configured." };

  // Scope the query to the bucket's sizes: a canonical bucket is exactly one size; the
  // custom bucket is everything off-format. Include archived rows here (no status filter)
  // so a file is still discoverable — and its stale nodes still deletable — even when
  // every one of its signs has been removed from the record.
  //
  // Test data is excluded outright, on BOTH size branches. This manifest is the input to
  // a follow-on plugin/MCP pass that adds and deletes real nodes in the production Figma
  // files, so a sign from an "Import as test data" run (the ImportWizard's default) must
  // never reach it — same reason reconcile/actions.ts's loadSheetSourcedSigns filters it.
  // A test sign's leftover node mostly isn't lost by this — an unclaimed node still
  // surfaces as an orphan ("delete?") for a human to decide on — but the orphan fallback
  // only covers rendered INSTANCE nodes, so a test node someone DETACHED in Figma drops
  // out of the manifest entirely. That's test-sign cruft either way; the manifest never
  // deletes what it can't tie to the live record, which is the safe direction.
  // Known narrowing: figmaUrls below is derived from these same rows, so a bucket whose
  // ONLY Figma-linked rows are test data now reports "No Figma file linked" instead of
  // reconciling. Accepted — such a bucket has no production record to reconcile against.
  const fmt = SIGN_FORMATS.find((f) => f.key === bucketKey);
  const rows = await prisma.sign.findMany({
    where: {
      isTestData: false,
      ...(fmt ? { size: fmt.size } : { size: { notIn: CANONICAL_SIZES } }),
    },
    select: {
      id: true,
      itemId: true,
      signText: true,
      size: true,
      status: true,
      figmaInstanceNodeId: true,
      generationBatch: { select: { figmaUrl: true } },
    },
  });

  // Guard the custom-bucket query (a broad notIn) against a stray canonical row.
  const bucketRows = rows.filter(
    (r) => formatBucketForSize(r.size).key === bucketKey,
  );
  const activeRows = bucketRows.filter((r) => r.status !== ARCHIVED_STATUS);
  const activeSignLites = activeRows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    signText: r.signText,
    // Carried so the reconcile can recognize a text edit (stored node still in the file under a
    // drifted name) as an in-place correction rather than an append + stale orphan.
    figmaInstanceNodeId: r.figmaInstanceNodeId,
  }));
  // Removed (archived) signs of this bucket — their instances may still sit in the file
  // and are the only nodes the manifest will flag for deletion.
  const removedSigns = bucketRows
    .filter((r) => r.status === ARCHIVED_STATUS)
    .map((r) => ({
      id: r.id,
      itemId: r.itemId,
      signText: r.signText,
      figmaInstanceNodeId: r.figmaInstanceNodeId,
    }));

  const figmaUrls = [
    ...new Set(
      bucketRows
        .map((r) => r.generationBatch?.figmaUrl)
        .filter((u): u is string => !!u),
    ),
  ];
  if (figmaUrls.length === 0) {
    return {
      ok: false,
      error:
        "No Figma file linked for this size yet — save a batch's Figma link on the Generation page first.",
    };
  }

  const files: BucketManifestFile[] = [];
  const fileErrors: string[] = [];
  const matchedSignIds = new Set<number>();
  const ambiguousSignIds = new Set<number>();
  // Sign-side collisions are bucket-level (same for every file) — dedupe by name so a
  // multi-file bucket reports each collision once, not once per file.
  const ambiguousSigns: ManifestAmbiguous[] = [];
  const seenSignAmbiguity = new Set<string>();

  for (const url of figmaUrls) {
    const fileKey = figmaFileKey(url);
    if (!fileKey) {
      fileErrors.push(`Couldn't read the Figma file key from ${url}`);
      continue;
    }
    try {
      const document = await fetchFileDocument(fileKey, token);
      const nodes = flattenFigmaNodes(document);
      const manifest = buildFigmaManifest({
        nodes,
        activeSigns: activeSignLites,
        removedSigns,
      });
      for (const m of manifest.inFile) matchedSignIds.add(m.signId);
      // A correction's sign is spoken for (retext in place) — keep it out of bucket appends.
      for (const c of manifest.corrections) matchedSignIds.add(c.signId);
      const ambiguousNodes: ManifestAmbiguous[] = [];
      for (const a of manifest.ambiguous) {
        if (a.kind === "sign") {
          a.signIds.forEach((id) => ambiguousSignIds.add(id));
          if (!seenSignAmbiguity.has(a.nodeName)) {
            seenSignAmbiguity.add(a.nodeName);
            ambiguousSigns.push(a);
          }
        } else {
          // kind "node": its signIds mix the active + removed ids tangled in this node.
          // Exclude them from bucket-level appends too — an active sign already surfaced
          // as node-ambiguous must not ALSO be reported as "needs render". (Removed ids
          // never appear in activeRows, so unioning them here is harmless.)
          a.signIds.forEach((id) => ambiguousSignIds.add(id));
          ambiguousNodes.push(a);
        }
      }
      files.push({
        fileKey,
        figmaUrl: url,
        inFile: manifest.counts.inFile,
        deletes: manifest.deletes,
        corrections: manifest.corrections,
        orphanNodes: manifest.orphans,
        ambiguousNodes,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Figma file fetch failed.";
      fileErrors.push(`${fileKey}: ${message.slice(0, 200)}`);
    }
  }

  if (files.length === 0) {
    return {
      ok: false,
      error: fileErrors[0] ?? "Couldn't reconcile any Figma file for this size.",
    };
  }

  // Bucket-level appends: an active sign matched in NONE of the files (and not tangled in
  // a collision) genuinely isn't rendered anywhere in this size — it needs a render.
  const appends: ManifestAppend[] = activeRows
    .filter((r) => !matchedSignIds.has(r.id) && !ambiguousSignIds.has(r.id))
    .map((r) => ({ signId: r.id, itemId: r.itemId, signText: r.signText }));

  const deletes = files.reduce((n, f) => n + f.deletes.length, 0);
  const inFile = files.reduce((n, f) => n + f.inFile, 0);
  const corrections = files.reduce((n, f) => n + f.corrections.length, 0);
  const orphans = files.reduce((n, f) => n + f.orphanNodes.length, 0);
  const ambiguousNodeCount = files.reduce(
    (n, f) => n + f.ambiguousNodes.length,
    0,
  );

  return {
    ok: true,
    manifest: {
      bucketKey,
      bucketLabel,
      generatedAt,
      files,
      appends,
      ambiguousSigns,
      fileErrors,
      counts: {
        activeSigns: activeRows.length,
        files: files.length,
        inFile,
        deletes,
        appends: appends.length,
        ambiguous: ambiguousSigns.length + ambiguousNodeCount,
        corrections,
        orphans,
      },
    },
  };
}
