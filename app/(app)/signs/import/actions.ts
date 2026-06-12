"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { checkActionRateLimit } from "@/lib/ratelimit";
import { recordAudit } from "@/lib/audit";
import { parseCsv } from "@/lib/csv";
import { Prisma } from "@/app/generated/prisma/client";

import {
  buildPreview,
  tooManyRows,
  type ImportPreview,
  type MappingContext,
} from "./_map";
import { buildSignSheetPreview } from "./_parsers/signSheet";
import { buildMasterPreview } from "./_parsers/master";

// Which layout the uploaded CSV is. The wizard picks this; each maps to a parser
// producing the same ImportPreview shape.
export type ImportSource = "generic" | "signSheet" | "master";

function runPreview(
  source: ImportSource,
  rows: string[][],
  ctx: MappingContext,
): ImportPreview {
  switch (source) {
    case "signSheet":
      return buildSignSheetPreview(rows, ctx);
    case "master":
      return buildMasterPreview(rows, ctx);
    case "generic":
    default:
      return buildPreview(rows, ctx);
  }
}

// ~5 MB. The wizard reads the whole file into a string and ships it to the
// action, so bound it before parsing to avoid memory blow-ups.
const MAX_CSV_BYTES = 5_000_000;

function errorPreview(message: string): ImportPreview {
  return {
    headerError: message,
    mappedColumns: [],
    ignoredHeaders: [],
    rows: [],
    counts: { valid: 0, invalid: 0, duplicate: 0, total: 0 },
  };
}

async function loadContext(): Promise<MappingContext> {
  const [zones, tags, existing] = await Promise.all([
    prisma.zone.findMany({ select: { id: true, zoneCode: true } }),
    prisma.signTag.findMany({ select: { slug: true } }),
    prisma.sign.findMany({
      select: { itemId: true, signText: true, size: true },
    }),
  ]);
  return {
    zoneByCode: new Map(zones.map((z) => [z.zoneCode.toUpperCase(), z.id])),
    tagSlugs: new Set(tags.map((t) => t.slug)),
    // Key must match categorizeRows: itemId + signText + size.
    existingKeys: new Set(
      existing.map((s) => `${s.itemId} ${s.signText} ${s.size}`),
    ),
  };
}

export async function previewImport(
  csvText: string,
  source: ImportSource = "generic",
): Promise<ImportPreview> {
  const session = await requireRole("lead");

  const { success } = await checkActionRateLimit(`import:${session.user.id}`);
  if (!success) {
    return errorPreview("Too many import attempts. Wait a minute and try again.");
  }
  // Bytes, not UTF-16 code units — .length undercounts multi-byte text ~2x.
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return errorPreview("File too large (max 5 MB). Split it and import in parts.");
  }

  const rows = parseCsv(csvText);
  // Cap on raw file rows, before any source slices off a header (bounds work
  // regardless of which parser runs).
  const capped = tooManyRows(rows.length);
  if (capped) return capped;

  const ctx = await loadContext();
  return runPreview(source, rows, ctx);
}

export type ImportResult = {
  imported: number;
  failed: number;
  skipped: number;
};

export async function executeImport(
  csvText: string,
  includeDuplicates: boolean,
  asTestData: boolean,
  source: ImportSource = "generic",
): Promise<ImportResult> {
  const session = await requireRole("lead");

  const { success } = await checkActionRateLimit(`import:${session.user.id}`);
  if (!success) throw new Error("rate-limited");
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    throw new Error("file-too-large");
  }

  const rows = parseCsv(csvText);
  if (tooManyRows(rows.length)) throw new Error("too-many-rows");

  const ctx = await loadContext();
  // ctx is re-derived here, so duplicate detection reflects the DB at execute
  // time, not at preview time. A concurrent insert between preview and confirm
  // could re-classify a row -- acceptable for this low-concurrency internal tool.
  const preview = runPreview(source, rows, ctx);

  const toInsert = preview.rows.filter(
    (r) => r.status === "valid" || (includeDuplicates && r.status === "duplicate"),
  );
  const skipped = preview.rows.length - toInsert.length;

  const tagRows = await prisma.signTag.findMany({
    select: { id: true, slug: true },
  });
  const tagIdBySlug = new Map(tagRows.map((t) => [t.slug, t.id]));

  const importedBy = session.user.email ?? session.user.id;
  let imported = 0;
  let failed = 0;

  if (toInsert.length > 0) {
    // Bulk insert in one statement instead of a per-row create loop (which was N
    // sequential round-trips to Postgres). createManyAndReturn preserves input order
    // on Postgres, so each returned id maps back to its row; the tag links and
    // the per-sign "Imported from CSV" audit-trail history rows (OWASP A09) then
    // go in as two more bulk inserts — all inside one transaction (atomic).
    const signData: Prisma.SignCreateManyInput[] = toInsert.map((r) => ({
      ...r.data,
      status: "pending",
      isTestData: asTestData,
    }));

    try {
      imported = await prisma.$transaction(async (tx) => {
        const created = await tx.sign.createManyAndReturn({
          data: signData,
          select: { id: true },
        });

        const tagData: Prisma.SignTagAssignmentCreateManyInput[] = [];
        const historyData: Prisma.StatusHistoryCreateManyInput[] = [];
        created.forEach((c, i) => {
          for (const slug of toInsert[i].tagSlugs) {
            const tagId = tagIdBySlug.get(slug);
            if (tagId !== undefined) tagData.push({ signId: c.id, tagId });
          }
          historyData.push({
            signId: c.id,
            oldStatus: null,
            newStatus: "pending",
            changedBy: importedBy,
            notes: "Imported from CSV",
          });
        });

        await tx.statusHistory.createMany({ data: historyData });
        if (tagData.length > 0) {
          await tx.signTagAssignment.createMany({
            data: tagData,
            skipDuplicates: true,
          });
        }
        return created.length;
      });
    } catch (err) {
      console.error("bulk import failed", err);
      failed = toInsert.length;
    }
  }

  if (imported > 0) revalidatePath("/signs");

  await recordAudit({
    action: "signs.import",
    actorId: session.user.id,
    actorEmail: session.user.email,
    detail: `Imported ${imported} signs (${source}, ${
      asTestData ? "test" : "real"
    })${failed > 0 ? `, ${failed} failed` : ""}`,
  });

  return { imported, failed, skipped };
}
